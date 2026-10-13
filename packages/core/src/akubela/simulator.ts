/**
 * WBS-B1: in-memory Akubela GRMS simulator (OpenAPI V4.1, Hotel Function API).
 *
 * Implements `GrmsSimulatorApi`: the same `call(command, param)` surface as the real transport, with result
 * shapes (snake_case) and validation rules taken from the docs and from probing the UAT platform:
 *  - Required fields must be present AND non-empty strings -> 50104080 "api hotel command bind body"
 *  - create_order_info.start_time earlier than now -> 50105580
 *  - unknown residence -> 20017608, unknown order -> 20017008
 * Codes the real platform was not observed to return are simulator-defined (see SIM_ERROR_CODES).
 * `apply(action)` emulates changes made on the GRMS side (HyPanel, housekeeping, guest self check-out),
 * `setFaults('uat')` reproduces the platform-side failures seen on UAT so the UI shows realistic errors.
 */
import type { Snapshot } from '../types.ts';
import {
  GrmsError,
  type GrmsAbility,
  type GrmsDevice,
  type GrmsGuest,
  type GrmsOrder,
  type GrmsOrderState,
  type GrmsSimulatorApi,
  type SimAction,
} from './contract.ts';

export interface GrmsSimulatorOptions {
  now?: () => number;
  faults?: 'none' | 'uat';
  latencyMs?: number;
  /** Also create `checked_in` GRMS orders for OPERA reservations already in house (default false). */
  seedInHouse?: boolean;
}

/** Codes observed on the real platform plus simulator-defined ones (marked "sim"). */
export const SIM_ERROR_CODES = {
  BIND_BODY: 50104080, // real: empty/missing Required field, bad type, unknown command
  START_BEFORE_NOW: 50105580, // real
  FINISH_BEFORE_START: 50105581, // sim
  RESIDENCE_NOT_FOUND: 20017608, // real
  ORDER_NOT_FOUND: 20017008, // real
  ORDER_DELETE_STATE: 20017009, // sim: only check_in (pending) orders can be deleted
  ORDER_STATE_TRANSITION: 20017010, // sim: only check_in -> checked_in -> checked_out
  RESIDENCE_OCCUPIED: 20017011, // sim: another order is already checked_in in that room
  GUEST_NOT_FOUND: 20017108, // sim
  DEVICE_NOT_FOUND: 20017208, // sim
  ABILITY_NOT_FOUND: 20017209, // sim
  CONTROL_UNSUPPORTED: 20017210, // sim
  ATTRIBUTE_INVALID: 20017211, // sim
  DEVICE_OFFLINE: 20017212, // sim
  SCENE_NOT_FOUND: 20017408, // sim
  AUTH_RECORD_NOT_FOUND: 20017508, // sim
} as const;

/** Platform-side failures observed on UAT (project TMG-环境) and reproduced by faults 'uat'. */
export const UAT_FAULTS: Record<string, { code: number; message: string }> = {
  get_room_info: { code: 20950001, message: 'api room bind body' },
  update_room_state: { code: 20950001, message: 'api room bind body' },
  create_order_info: { code: 20950005, message: 'api order bind body' },
  get_project_info: { code: 24400347, message: 'api get project timezone bind header' },
  get_alarm_record_list: { code: 20950004, message: 'api notification bind body' },
};

const E = SIM_ERROR_CODES;
const BIND_MSG = 'api hotel command bind body';
const HOTEL_TZ = 'Asia/Shanghai';
const TOKEN_TTL_MS = 7200 * 1000;

// ───────────────────────────────────────────────────────────── internal db
interface SimRoom {
  roomId: string; // OPERA room id
  residence_id: string;
  residence_no: string;
  building_id: string;
  building_name: string;
  floor_id: string;
  floor_name: string;
  room_type_id: string;
  room_type_name: string;
  order_id: string;
  dirty: boolean;
  occupied: boolean;
  dnd: boolean;
}
interface SimRoomType { room_type_id: string; room_type_name: string; bed: number; occupancy: number }
interface SimGuest extends GrmsGuest { guest_id: string; order_id: string }
interface SimAuthRecord {
  record_id: string;
  authorization_number: string;
  access_type: string;
  pin_code: string;
  rf_card_number: string;
  guest_id: string;
  residence_id: string;
  start_time: string;
  finish_time: string;
  updated_time: string;
}
interface SimSceneAction { ability_type: string; control: string; attribute?: Record<string, unknown> }
interface SimScene { scene_id: string; scene_name: string; enable_auto: boolean; actions: SimSceneAction[] }
interface SimAlarm { alarm_time: string; alarm_type: string; residence_id: string; message?: string }

// ───────────────────────────────────────────────────────────── helpers
/** Deterministic 32 hex chars derived from a seed string (FNV-1a variants). */
function hex32(seed: string): string {
  let out = '';
  for (let i = 0; i < 4; i++) {
    let h = (0x811c9dc5 ^ Math.imul(i + 1, 0x9e3779b1)) | 0;
    for (let k = 0; k < seed.length; k++) {
      h ^= seed.charCodeAt(k);
      h = Math.imul(h, 0x01000193);
    }
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    out += (h >>> 0).toString(16).padStart(8, '0');
  }
  return out;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** "YYYY-MM-DD HH:mm:ss" (UTC) */
function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
/** Strict parse of "YYYY-MM-DD HH:mm:ss" (UTC) -> epoch ms, or null. */
function parseTime(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isNaN(ms) || fmtTime(ms) !== s ? null : ms;
}

const NEXT_STATE: Record<GrmsOrderState, GrmsOrderState[]> = {
  check_in: ['check_in', 'checked_in'],
  checked_in: ['checked_in', 'checked_out'],
  checked_out: ['checked_out'],
};
const ORDER_STATES = Object.keys(NEXT_STATE);
const ACCESS_TYPES = ['password', 'rf_card', 'qr_code'];
const ALARM_TYPE: Record<string, string> = { sos: 'sos_alarm', smoke: 'smoke_alarm', low_power: 'low_power', water_leak: 'moist_alarm' };

// ───────────────────────────────────────────────────────────── device seeding
function space(name: string, key: string) {
  return { parent_space_id: '', space_id: name ? `r${hex32(key)}` : '', space_name: name };
}

function seedDevices(no: string): GrmsDevice[] {
  const id = (kind: string, prefix: string) => `${prefix}${hex32(`${kind}:${no}`)}`;
  const living = space('Living Room', `space:${no}:living`);
  const none = space('', '');
  const hypanelId = id('dev:hypanel', 'd');
  const irId = id('dev:ir', 'd');
  const mk = (device_id: string, device_name: string, product_name: string, device_type: string, abilities: GrmsAbility[], sp: GrmsDevice['space'], parent: string, subs: GrmsDevice[] = []): GrmsDevice => ({
    device_id, device_name, product_name, device_type, device_picture_url: '', online: true, abilities, space: sp, sub_devices: subs, parent_device_id: parent,
  });
  const ab = (kind: string, name: string, type: string, attrs: string[] | null, state: string, attribute: Record<string, unknown>): GrmsAbility => ({
    ability_id: id(`ab:${kind}`, 'e'), ability_name: name, ability_type: type, ability_attribute: attrs, state, attribute,
  });
  const ac = mk(id('dev:ac', 'd'), 'Midea AC', 'AC Remote', 'AC Remote', [
    ab('climate', 'climate', 'climate', ['preset_temperature', 'hvac_mode', 'support_hvac_mode', 'fan_mode', 'support_fan_mode', 'swing_mode'], 'off', {
      fan_mode: 'auto', hvac_mode: 'cool', preset_temperature: 24,
      support_fan_mode: ['auto', 'low', 'medium', 'high'], support_hvac_mode: ['cool', 'heat', 'auto', 'fan_only', 'dry'],
      support_swing_mode: ['auto', 'fix_1'], swing_mode: 'auto',
    }),
  ], living, irId);
  const ir = mk(irId, 'IR Controller', 'IR Controller', 'IR Controller', [
    ab('temp', 'temperature', 'sensor', ['type'], '26.0', { type: 'temperature' }),
    ab('hum', 'humidity', 'sensor', ['type'], '55.7', { type: 'humidity' }),
  ], living, hypanelId, [ac]);
  const relay = mk(id('dev:relay', 'd'), `HyPanel Elite 10 ${no} - relay`, 'Relay1', 'Siren', [ab('relay1', 'relay1', 'switch', null, 'off', {})], none, hypanelId);
  const light = mk(id('dev:light', 'd'), 'Ceiling Light', 'Smart Dimmer', 'Light', [ab('light', 'light', 'light', ['brightness'], 'off', { brightness: 100 })], living, hypanelId);
  const lock = mk(id('dev:lock', 'd'), 'Door Lock', 'Smart Lock', 'Lock', [ab('lock', 'lock', 'lock', null, 'locked', {})], none, hypanelId);
  const panel = mk(hypanelId, `HyPanel Elite 10 ${no}`, 'HyPanel Elite 10', 'PH59', [ab('motion', 'motion', 'binary_sensor', ['type'], 'off', { type: 'motion' })], none, '', [relay, ir, light, lock]);
  return [panel];
}

function seedScenes(): SimScene[] {
  const sc = (name: string, actions: SimSceneAction[]): SimScene => ({ scene_id: `s${hex32(`scene:${name}`)}`, scene_name: name, enable_auto: false, actions });
  return [
    sc('Welcome', [
      { ability_type: 'light', control: 'turn_on', attribute: { brightness: 80 } },
      { ability_type: 'climate', control: 'turn_on', attribute: { hvac_mode: 'cool', preset_temperature: 24 } },
    ]),
    sc('Check-out Energy Saving', [
      { ability_type: 'light', control: 'turn_off' },
      { ability_type: 'climate', control: 'turn_off' },
      { ability_type: 'switch', control: 'turn_off' },
    ]),
    sc('Sleep', [
      { ability_type: 'light', control: 'turn_off' },
      { ability_type: 'climate', control: 'turn_on', attribute: { hvac_mode: 'cool', preset_temperature: 26, fan_mode: 'low' } },
      { ability_type: 'lock', control: 'lock' },
    ]),
  ];
}

// ───────────────────────────────────────────────────────────── factory
/** Build a simulated GRMS whose rooms mirror the OPERA rooms (residence_name = room number). */
export function createGrmsSimulator(pms: Snapshot, opts: GrmsSimulatorOptions = {}): GrmsSimulatorApi {
  const now = opts.now ?? (() => Date.now());
  const latencyMs = opts.latencyMs ?? 0;
  let faults: 'none' | 'uat' = opts.faults ?? 'none';
  let calls = 0;
  const idRng = mulberry32(0x6a09e667);
  const traceRng = mulberry32(0xbb67ae85);

  const rid = (prefix: string) => prefix + Array.from({ length: 4 }, () => Math.floor(idRng() * 0x100000000).toString(16).padStart(8, '0')).join('');
  const traceId = () => Array.from({ length: 4 }, () => Math.floor(traceRng() * 0x100000000).toString(16).padStart(8, '0')).join('');

  // ── seed: room types, rooms, devices, scenes
  const roomTypes: SimRoomType[] = pms.roomTypes.map((t) => ({
    room_type_id: `t${hex32(`roomtype:${t.code}`)}`,
    room_type_name: t.name,
    bed: Math.max(1, Math.ceil(t.maxOccupancy / 2)),
    occupancy: t.maxOccupancy,
  }));
  const typeByCode = new Map(pms.roomTypes.map((t, i) => [t.code, roomTypes[i]]));
  const building = { building_id: `b${hex32('building:b1')}`, building_name: 'b1' };
  const rooms: SimRoom[] = pms.rooms.map((r) => {
    const rt = typeByCode.get(r.roomType);
    return {
      roomId: r.id,
      residence_id: `r${hex32(`residence:${r.number}`)}`,
      residence_no: r.number,
      ...building,
      floor_id: `f${hex32(`floor:b1:${r.floor}`)}`,
      floor_name: String(r.floor),
      room_type_id: rt?.room_type_id ?? '',
      room_type_name: rt?.room_type_name ?? r.roomType,
      order_id: '',
      dirty: r.hkStatus === 'Dirty' || r.hkStatus === 'Pickup',
      occupied: false,
      dnd: false,
    };
  });
  const roomById = new Map(rooms.map((r) => [r.residence_id, r]));
  const devices = new Map<string, GrmsDevice[]>(rooms.map((r) => [r.residence_id, seedDevices(r.residence_no)]));
  const scenes = seedScenes();
  const orders: GrmsOrder[] = []; // creation order
  const guests: SimGuest[] = [];
  const authRecords: SimAuthRecord[] = [];
  const alarms: SimAlarm[] = []; // creation order

  // ── errors
  function fail(code: number, message: string, trace: string): never { throw new GrmsError(message, code, trace); }
  function bind(trace: string): never { return fail(E.BIND_BODY, BIND_MSG, trace); }

  // ── lookups
  const residenceOf = (rid_: unknown, trace: string): SimRoom => {
    const r = typeof rid_ === 'string' ? roomById.get(rid_) : undefined;
    if (!r) fail(E.RESIDENCE_NOT_FOUND, 'service get partner rms room info check residence id exists', trace);
    return r as SimRoom;
  };
  const orderOf = (oid: unknown, trace: string): GrmsOrder => {
    const o = typeof oid === 'string' ? orders.find((x) => x.order_id === oid) : undefined;
    if (!o) fail(E.ORDER_NOT_FOUND, 'service get partner rms order info check order id exists', trace);
    return o as GrmsOrder;
  };
  const eachDevice = (list: GrmsDevice[], fn: (d: GrmsDevice, residenceId: string) => boolean | void, residenceId: string): boolean => {
    for (const d of list) {
      if (fn(d, residenceId) === true) return true;
      if (eachDevice(d.sub_devices, fn, residenceId)) return true;
    }
    return false;
  };
  const findDevice = (deviceId: string): { device: GrmsDevice; residenceId: string } | null => {
    let found: { device: GrmsDevice; residenceId: string } | null = null;
    for (const [residenceId, list] of devices) {
      if (eachDevice(list, (d) => { if (d.device_id === deviceId) { found = { device: d, residenceId }; return true; } }, residenceId)) break;
    }
    return found;
  };

  // ── param validation
  const requireStrings = (p: Record<string, unknown>, keys: string[], trace: string) => {
    for (const k of keys) if (!isStr(p[k])) bind(trace);
  };
  const page = (p: Record<string, unknown>, trace: string) => {
    const size = p.page_size, idx = p.page_index;
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) bind(trace);
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 1) bind(trace);
    return { size: size as number, index: idx as number };
  };
  const paginate = <T>(items: T[], p: Record<string, unknown>, trace: string): T[] => {
    const { size, index } = page(p, trace);
    return items.slice((index - 1) * size, index * size);
  };
  const parseTimes = (p: Record<string, unknown>, trace: string) => {
    const start = parseTime(p.start_time), finish = parseTime(p.finish_time);
    if (start === null || finish === null) bind(trace);
    return { start: start as number, finish: finish as number };
  };
  /** Order times are second-granular, so "now" is truncated to the second. */
  const startNotBeforeNow = (start: number, trace: string) => {
    if (start < Math.floor(now() / 1000) * 1000) fail(E.START_BEFORE_NOW, 'open ability rms order start time cannot be earlier than now', trace);
  };
  const finishAfterStart = (start: number, finish: number, trace: string) => {
    if (finish <= start) fail(E.FINISH_BEFORE_START, 'open ability rms order finish time cannot be earlier than start time', trace);
  };
  const checkGuestBody = (g: unknown, trace: string): GrmsGuest => {
    if (!isObj(g)) bind(trace);
    const o = g as Record<string, unknown>;
    requireStrings(o, ['guest_name', 'email', 'phone', 'id_card', 'passport'], trace);
    return { guest_name: o.guest_name as string, email: o.email as string, phone: o.phone as string, id_card: o.id_card as string, passport: o.passport as string };
  };

  // ── business side effects
  const orderNumber = (): string => {
    const stamp = fmtTime(now()).replace(/[- :]/g, '');
    let n: string;
    do n = stamp + String(100000 + Math.floor(idRng() * 900000)); while (orders.some((o) => o.order_number === n));
    return n;
  };
  const addGuest = (orderId: string, g: GrmsGuest): SimGuest => {
    const sg: SimGuest = { guest_id: rid('g'), order_id: orderId, ...g };
    guests.push(sg);
    return sg;
  };
  const publicGuest = (g: SimGuest): GrmsGuest => ({ guest_id: g.guest_id, guest_name: g.guest_name, email: g.email, phone: g.phone, id_card: g.id_card, passport: g.passport });
  const orderGuests = (o: GrmsOrder) => o.guests.map((g) => ({ ...g }));

  const setState = (o: GrmsOrder, to: GrmsOrderState) => {
    const room = roomById.get(o.residence_id)!;
    o.order_state = to;
    if (to === 'checked_in') {
      room.occupied = true;
      room.order_id = o.order_id;
    } else if (to === 'checked_out') {
      if (room.order_id === o.order_id || room.order_id === '') {
        room.occupied = false;
        room.order_id = '';
      }
      room.dirty = true;
    }
  };

  // ── devices
  const CONTROLS: Record<string, string[]> = {
    switch: ['turn_on', 'turn_off', 'toggle'],
    light: ['turn_on', 'turn_off', 'toggle'],
    climate: ['turn_on', 'turn_off', 'toggle'],
    lock: ['lock', 'unlock'],
  };
  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const validateAttributes = (ability: GrmsAbility, attr: Record<string, unknown>, trace: string): void => {
    const bad = (m: string): never => fail(E.ATTRIBUTE_INVALID, `service control device check attribute: ${m}`, trace);
    for (const [k, v] of Object.entries(attr)) {
      if (!ability.ability_attribute?.includes(k) || k.startsWith('support_')) bad(`${k} is not controllable on ${ability.ability_type}`);
      if (ability.ability_type === 'light' && k === 'brightness') {
        if (!isNum(v) || !Number.isInteger(v) || v < 0 || v > 100) bad('brightness must be an integer 0-100');
      } else if (ability.ability_type === 'climate') {
        const sup = (name: string) => (ability.attribute[name] as string[] | undefined) ?? [];
        if (k === 'preset_temperature') { if (!isNum(v) || v < 16 || v > 30) bad('preset_temperature must be 16-30'); }
        else if (k === 'hvac_mode') { if (typeof v !== 'string' || !sup('support_hvac_mode').includes(v)) bad('hvac_mode not in support_hvac_mode'); }
        else if (k === 'fan_mode') { if (typeof v !== 'string' || !sup('support_fan_mode').includes(v)) bad('fan_mode not in support_fan_mode'); }
        else if (k === 'swing_mode') { if (typeof v !== 'string' || !sup('support_swing_mode').includes(v)) bad('swing_mode not in support_swing_mode'); }
      }
    }
  };
  const applyControl = (device: GrmsDevice, ability: GrmsAbility, control: string, attr: Record<string, unknown>, trace: string): void => {
    if (!device.online) fail(E.DEVICE_OFFLINE, 'service control device check device online', trace);
    const allowed = CONTROLS[ability.ability_type];
    if (!allowed || !allowed.includes(control)) fail(E.CONTROL_UNSUPPORTED, `service control device check control ${control} supported by ${ability.ability_type} ability`, trace);
    if (Object.keys(attr).length) {
      if (control === 'turn_off' || control === 'toggle' && ability.state === 'on') fail(E.ATTRIBUTE_INVALID, `service control device check attribute: not allowed with ${control}`, trace);
      validateAttributes(ability, attr, trace);
    }
    if (control === 'turn_on') ability.state = 'on';
    else if (control === 'turn_off') ability.state = 'off';
    else if (control === 'toggle') ability.state = ability.state === 'on' ? 'off' : 'on';
    else if (control === 'lock') ability.state = 'locked';
    else if (control === 'unlock') ability.state = 'unlocked';
    Object.assign(ability.attribute, attr);
  };
  const triggerScene = (scene: SimScene, residenceId: string, trace: string) => {
    eachDevice(devices.get(residenceId)!, (d) => {
      for (const ability of d.abilities) {
        for (const a of scene.actions) {
          if (a.ability_type !== ability.ability_type) continue;
          if (a.control === 'turn_on' && ability.state === 'on' && !a.attribute) continue;
          applyControl(d, ability, a.control, { ...(a.attribute ?? {}) }, trace);
        }
      }
    }, residenceId);
  };
  const deviceView = (d: GrmsDevice, showAbility: boolean, subTypes: string[] | null, parallel: boolean): GrmsDevice => {
    const subs = parallel ? [] : d.sub_devices.filter((s) => !subTypes || subTypes.includes(s.device_type)).map((s) => deviceView(s, showAbility, subTypes, false));
    return { ...clone({ ...d, sub_devices: [] }), abilities: showAbility ? clone(d.abilities) : [], sub_devices: subs };
  };
  const flatten = (list: GrmsDevice[]): GrmsDevice[] => list.flatMap((d) => [d, ...flatten(d.sub_devices)]);

  // ── commands
  type Handler = (p: Record<string, unknown>, t: string) => unknown;
  const roomInfo = (r: SimRoom) => ({
    building_id: r.building_id, building_name: r.building_name, floor_id: r.floor_id, floor_name: r.floor_name,
    residence_no: r.residence_no, room_type_id: r.room_type_id, room_type_name: r.room_type_name,
    room_tag_id: '', room_tag_name: '', order_id: r.order_id, dirty: r.dirty, occupied: r.occupied, dnd: r.dnd,
  });
  const authView = (a: SimAuthRecord) => {
    const g = guests.find((x) => x.guest_id === a.guest_id);
    const r = roomById.get(a.residence_id)!;
    const t = now(), s = parseTime(a.start_time)!, f = parseTime(a.finish_time)!;
    return {
      record_id: a.record_id, authorization_number: a.authorization_number, access_type: a.access_type,
      guest_id: a.guest_id, guest_name: g?.guest_name ?? '', email: g?.email ?? '', phone: g?.phone ?? '',
      residence_id: a.residence_id, residence_no: r.residence_no, start_time: a.start_time, finish_time: a.finish_time,
      authorization_status: t >= f ? 'expired' : t < s ? 'pending' : 'effective', updated_time: a.updated_time,
    };
  };

  const handlers: Record<string, Handler> = {
    get_room_list: () => [{
      ...building,
      floors: [...new Set(rooms.map((r) => r.floor_id))].map((fid) => {
        const rs = rooms.filter((r) => r.floor_id === fid);
        return { floor_id: fid, floor_name: rs[0].floor_name, residences: rs.map((r) => ({ residence_id: r.residence_id, residence_name: r.residence_no })) };
      }),
    }],

    get_room_info: (p, t) => {
      requireStrings(p, ['residence_id'], t);
      const r = residenceOf(p.residence_id, t);
      uatFault('get_room_info', t);
      return roomInfo(r);
    },

    update_room_state: (p, t) => {
      requireStrings(p, ['residence_id'], t);
      if (typeof p.dirty !== 'boolean') bind(t);
      const r = residenceOf(p.residence_id, t);
      uatFault('update_room_state', t);
      r.dirty = p.dirty as boolean;
      return {};
    },

    get_room_type_list: (p, t) => paginate(roomTypes, p, t).map((x) => ({ ...x })),

    get_order_list: (p, t) => {
      const list = [...orders].reverse().map((o) => ({
        order_id: o.order_id, order_number: o.order_number, residence_id: o.residence_id, residence_no: o.residence_no,
        room_type_id: o.room_type_id, room_type_name: o.room_type_name, start_time: o.start_time, finish_time: o.finish_time,
        order_state: o.order_state, guests: orderGuests(o),
      }));
      return paginate(list, p, t);
    },

    get_order_info: (p, t) => {
      requireStrings(p, ['order_id'], t);
      const o = orderOf(p.order_id, t);
      return {
        order_number: o.order_number, residence_id: o.residence_id, residence_no: o.residence_no, room_type_id: o.room_type_id,
        room_type_name: o.room_type_name, start_time: o.start_time, finish_time: o.finish_time, order_state: o.order_state,
        source: o.source ?? '', remark: o.remark ?? '', enable_booking: o.enable_booking ?? false, guests: orderGuests(o),
      };
    },

    create_order_info: (p, t) => {
      requireStrings(p, ['residence_id', 'start_time', 'finish_time', 'source', 'remark'], t);
      if (typeof p.enable_booking !== 'boolean') bind(t);
      const guest = checkGuestBody(p.guest, t);
      const room = residenceOf(p.residence_id, t);
      const { start, finish } = parseTimes(p, t);
      startNotBeforeNow(start, t);
      finishAfterStart(start, finish, t);
      uatFault('create_order_info', t);
      const order: GrmsOrder = {
        order_id: rid('o'), order_number: orderNumber(), residence_id: room.residence_id, residence_no: room.residence_no,
        room_type_id: room.room_type_id, room_type_name: room.room_type_name, start_time: p.start_time as string,
        finish_time: p.finish_time as string, order_state: 'check_in', guests: [], source: p.source as string,
        remark: p.remark as string, enable_booking: p.enable_booking as boolean,
      };
      const g = addGuest(order.order_id, guest);
      order.guests.push(publicGuest(g));
      orders.push(order);
      return { order_id: order.order_id, order_number: order.order_number, guest_id: g.guest_id };
    },

    update_order_info: (p, t) => {
      requireStrings(p, ['order_id', 'start_time', 'finish_time', 'order_state', 'source', 'remark'], t);
      if (typeof p.enable_booking !== 'boolean') bind(t);
      if (!ORDER_STATES.includes(p.order_state as string)) bind(t);
      const { start, finish } = parseTimes(p, t);
      const o = orderOf(p.order_id, t);
      const to = p.order_state as GrmsOrderState;
      // a pending order can only be (re)scheduled into the future
      if (o.order_state === 'check_in') startNotBeforeNow(start, t);
      // a check-out may close the order at any time (finish_time = now)
      if (to !== 'checked_out') finishAfterStart(start, finish, t);
      if (!NEXT_STATE[o.order_state].includes(to)) fail(E.ORDER_STATE_TRANSITION, `service update partner rms order check order state cannot change from ${o.order_state} to ${to}`, t);
      if (to === 'checked_in' && o.order_state !== 'checked_in') {
        const room = roomById.get(o.residence_id)!;
        if (room.order_id && room.order_id !== o.order_id) fail(E.RESIDENCE_OCCUPIED, 'service update partner rms order check residence is occupied by another order', t);
      }
      o.start_time = p.start_time as string;
      o.finish_time = p.finish_time as string;
      o.source = p.source as string;
      o.remark = p.remark as string;
      o.enable_booking = p.enable_booking as boolean;
      if (to !== o.order_state) setState(o, to);
      return {};
    },

    delete_order_info: (p, t) => {
      requireStrings(p, ['order_id'], t);
      const o = orderOf(p.order_id, t);
      if (o.order_state !== 'check_in') fail(E.ORDER_DELETE_STATE, 'service delete partner rms order check only pending (check_in) order can be deleted', t);
      orders.splice(orders.indexOf(o), 1);
      for (let i = guests.length - 1; i >= 0; i--) if (guests[i].order_id === o.order_id) guests.splice(i, 1);
      return {};
    },

    get_guest_list: (p, t) => paginate([...guests].reverse().map(publicGuest), p, t),

    create_guest_info: (p, t) => {
      requireStrings(p, ['guest_name', 'email', 'phone', 'id_card', 'passport', 'order_id'], t);
      const o = orderOf(p.order_id, t);
      const g = addGuest(o.order_id, checkGuestBody(p, t));
      o.guests.push(publicGuest(g));
      return { guest_id: g.guest_id };
    },

    get_authorization_record_list: (p, t) => paginate([...authRecords].reverse().map(authView), p, t),

    create_authorization_record_info: (p, t) => {
      requireStrings(p, ['access_type', 'guest_id', 'residence_id', 'start_time', 'finish_time'], t);
      if (!ACCESS_TYPES.includes(p.access_type as string)) bind(t);
      for (const k of ['pin_code', 'rf_card_number']) if (p[k] !== undefined && typeof p[k] !== 'string') bind(t);
      const pinGiven = isStr(p.pin_code);
      if (pinGiven && !/^\d{4,10}$/.test(p.pin_code as string)) bind(t);
      if (p.access_type === 'rf_card' && !isStr(p.rf_card_number)) bind(t);
      const room = residenceOf(p.residence_id, t);
      if (!guests.some((g) => g.guest_id === p.guest_id)) fail(E.GUEST_NOT_FOUND, 'service create partner rms authorization check guest id exists', t);
      const { start, finish } = parseTimes(p, t);
      finishAfterStart(start, finish, t);
      const rec: SimAuthRecord = {
        record_id: rid('u'),
        authorization_number: orderNumber(),
        access_type: p.access_type as string,
        pin_code: p.access_type === 'password' ? (pinGiven ? (p.pin_code as string) : String(100000 + Math.floor(idRng() * 900000))) : '',
        rf_card_number: (p.rf_card_number as string | undefined) ?? '',
        guest_id: p.guest_id as string,
        residence_id: room.residence_id,
        start_time: p.start_time as string,
        finish_time: p.finish_time as string,
        updated_time: fmtTime(now()),
      };
      authRecords.push(rec);
      return { record_id: rec.record_id, authorization_number: rec.authorization_number, qr_code_url: '' };
    },

    delete_authorization_record_info: (p, t) => {
      requireStrings(p, ['record_id'], t);
      const i = authRecords.findIndex((a) => a.record_id === p.record_id);
      if (i < 0) fail(E.AUTH_RECORD_NOT_FOUND, 'service delete partner rms authorization check record id exists', t);
      authRecords.splice(i, 1);
      return {};
    },

    get_device_list: (p, t) => {
      page(p, t);
      if (p.residence_id !== undefined && !isStr(p.residence_id)) bind(t);
      const subTypes = p.sub_device_type === undefined ? null : p.sub_device_type;
      if (subTypes !== null && (!Array.isArray(subTypes) || subTypes.some((x) => typeof x !== 'string'))) bind(t);
      for (const k of ['show_ability', 'parallel_sub_device']) if (p[k] !== undefined && typeof p[k] !== 'boolean') bind(t);
      let list: GrmsDevice[];
      const showAbility = p.residence_id !== undefined && p.show_ability === true; // "only valid with residence_id"
      if (p.residence_id !== undefined) list = devices.get(residenceOf(p.residence_id, t).residence_id)!;
      else list = [...devices.values()].flat();
      const parallel = p.parallel_sub_device === true;
      if (parallel) list = flatten(list);
      return paginate(list, p, t).map((d) => deviceView(d, showAbility, subTypes as string[] | null, parallel));
    },

    get_device_info: (p, t) => {
      requireStrings(p, ['device_id'], t);
      const f = findDevice(p.device_id as string);
      if (!f) fail(E.DEVICE_NOT_FOUND, 'service get partner device info check device id exists', t);
      return deviceView(f!.device, true, null, false);
    },

    control_device: (p, t) => {
      requireStrings(p, ['device_id', 'ability_id', 'control'], t);
      if (p.attribute !== undefined && !isObj(p.attribute)) bind(t);
      const f = findDevice(p.device_id as string);
      if (!f) fail(E.DEVICE_NOT_FOUND, 'service get partner device info check device id exists', t);
      const ability = f!.device.abilities.find((a) => a.ability_id === p.ability_id);
      if (!ability) fail(E.ABILITY_NOT_FOUND, 'service control device check ability id exists', t);
      applyControl(f!.device, ability as GrmsAbility, p.control as string, { ...((p.attribute as Record<string, unknown> | undefined) ?? {}) }, t);
      return {};
    },

    get_scene_list: (p, t) => paginate(scenes, p, t).map((s) => ({ scene_id: s.scene_id, scene_name: s.scene_name, enable_auto: s.enable_auto })),

    manual_trigger_scene: (p, t) => {
      requireStrings(p, ['scene_id'], t);
      if (!Array.isArray(p.residences) || p.residences.length === 0) bind(t);
      const ids = (p.residences as unknown[]).map((x) => {
        if (!isObj(x) || !isStr(x.residence_id)) bind(t);
        return (x as Record<string, unknown>).residence_id as string;
      });
      const scene = scenes.find((s) => s.scene_id === p.scene_id);
      if (!scene) fail(E.SCENE_NOT_FOUND, 'service trigger scene check scene id exists', t);
      const targets = ids.map((i) => residenceOf(i, t));
      for (const r of targets) triggerScene(scene as SimScene, r.residence_id, t);
      return {};
    },

    get_alarm_record_list: (p, t) => {
      page(p, t);
      uatFault('get_alarm_record_list', t);
      return paginate([...alarms].reverse().map((a) => ({ alarm_time: a.alarm_time, alarm_type: a.alarm_type, residence_id: a.residence_id })), p, t);
    },

    get_project_info: (_p, t) => {
      uatFault('get_project_info', t);
      const occ = rooms.filter((r) => r.occupied).length;
      const all = flatten([...devices.values()].flat());
      return {
        project_id: `p${hex32('project:sim')}`, project_name: 'OPERA Demo (GRMS simulator)', currency: 'CNY:Yuan Renminbi',
        visit_url: 'https://grms.sim.invalid', timezone: HOTEL_TZ,
        address: { country: 'China', state_province: 'Shanghai', city: 'Shanghai', street: 'Simulator Road 1', postcode: '200000' },
        room: {
          to_stay: orders.filter((o) => o.order_state === 'check_in').length,
          checked_out: orders.filter((o) => o.order_state === 'checked_out').length,
          dirty: rooms.filter((r) => r.dirty).length,
          vacant_dirty: rooms.filter((r) => r.dirty && !r.occupied).length,
          occupied_dirty: rooms.filter((r) => r.dirty && r.occupied).length,
          vacant_clean: rooms.filter((r) => !r.dirty && !r.occupied).length,
          occupied_clean: rooms.filter((r) => !r.dirty && r.occupied).length,
          dnd: rooms.filter((r) => r.dnd).length,
          vacant_today: rooms.length - occ,
          checked_in_today: orders.filter((o) => o.order_state === 'checked_in').length,
          number_of_staying_today: orders.filter((o) => o.order_state === 'checked_in').reduce((n, o) => n + o.guests.length, 0),
          occupancy_rate_today: rooms.length ? Math.round((occ * 100) / rooms.length) : 0,
        },
        device: { total: all.length, online: all.filter((d) => d.online).length, offline: all.filter((d) => !d.online).length, low_power: 0 },
      };
    },
  };

  function uatFault(command: string, trace: string): void {
    const f = faults === 'uat' ? UAT_FAULTS[command] : undefined;
    if (f) fail(f.code, f.message, trace);
  }

  // ── seed in-house orders (optional)
  if (opts.seedInHouse) {
    for (const rv of pms.reservations) {
      const room = rv.roomId ? rooms.find((r) => r.roomId === rv.roomId) : undefined;
      if (rv.status !== 'InHouse' || !room) continue;
      const o: GrmsOrder = {
        order_id: rid('o'), order_number: orderNumber(), residence_id: room.residence_id, residence_no: room.residence_no,
        room_type_id: room.room_type_id, room_type_name: room.room_type_name,
        start_time: fmtTime(now()), finish_time: fmtTime(Date.parse(`${rv.departure}T12:00:00Z`)), order_state: 'check_in',
        guests: [], source: 'seed', remark: `seed ${rv.confirmationNo}`, enable_booking: false,
      };
      const g = addGuest(o.order_id, { guest_name: rv.guestName, email: rv.email ?? 'N/A', phone: rv.phone ?? 'N/A', id_card: 'N/A', passport: 'N/A' });
      o.guests.push(publicGuest(g));
      orders.push(o);
      setState(o, 'checked_in');
    }
  }

  // ── transport + sim controls
  async function call<T = unknown>(command: string, param: Record<string, unknown>): Promise<T> {
    if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
    calls++;
    const trace = traceId();
    const h = Object.prototype.hasOwnProperty.call(handlers, command) ? handlers[command] : undefined;
    if (!h) throw new GrmsError(BIND_MSG, E.BIND_BODY, trace);
    if (!isObj(param)) throw new GrmsError(BIND_MSG, E.BIND_BODY, trace);
    return clone(h(param, trace)) as T;
  }

  function apply(action: SimAction): void {
    const t = traceId();
    switch (action.type) {
      case 'setRoomState': {
        const r = residenceOf(action.residenceId, t);
        if (typeof action.dirty === 'boolean') r.dirty = action.dirty;
        if (typeof action.dnd === 'boolean') r.dnd = action.dnd;
        return;
      }
      case 'guestSelfCheckout': {
        const o = orderOf(action.orderId, t);
        if (o.order_state !== 'checked_in') fail(E.ORDER_STATE_TRANSITION, `guest self check-out needs a checked_in order (is ${o.order_state})`, t);
        o.finish_time = fmtTime(now());
        setState(o, 'checked_out');
        return;
      }
      case 'raiseAlarm': {
        const r = residenceOf(action.residenceId, t);
        const type = ALARM_TYPE[action.alarmType];
        if (!type) fail(E.BIND_BODY, BIND_MSG, t);
        alarms.push({ alarm_time: fmtTime(now()), alarm_type: type, residence_id: r.residence_id, message: action.message });
        return;
      }
      case 'setFaults':
        if (action.profile !== 'none' && action.profile !== 'uat') fail(E.BIND_BODY, BIND_MSG, t);
        faults = action.profile;
        return;
    }
  }

  return {
    kind: 'sim',
    call: call as GrmsSimulatorApi['call'],
    tokenInfo: () => ({ expiresAt: now() + TOKEN_TTL_MS, scope: 'hotel' }),
    apply,
    dump: () => clone({
      faults, calls, building, roomTypes, rooms, orders,
      guests, authRecords, alarms,
      devices: Object.fromEntries(devices),
      scenes,
    }),
  };
}
