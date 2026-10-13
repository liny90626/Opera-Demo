import type {
  Attendant,
  HkStatus,
  Reservation,
  Room,
  RoomCondition,
  RoomType,
  ReasonCode,
  Snapshot,
  Subscriber,
} from './types.ts';
import { addDays, todayIso } from './dates.ts';
import { EVENTS } from './events.ts';

/** Deterministic PRNG so the server and the in-browser backend seed identical data. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const ROOM_TYPES: RoomType[] = [
  { code: 'SK', name: 'Superior King', credits: 10, maxOccupancy: 2 },
  { code: 'ST', name: 'Superior Twin', credits: 10, maxOccupancy: 3 },
  { code: 'DK', name: 'Deluxe King', credits: 12, maxOccupancy: 3 },
  { code: 'JS', name: 'Junior Suite', credits: 16, maxOccupancy: 3 },
  { code: 'ES', name: 'Executive Suite', credits: 20, maxOccupancy: 4 },
];

export const CONDITIONS: RoomCondition[] = [
  { code: 'SHW', description: 'Show Room (sales tour)', blocksAssignment: true },
  { code: 'HLD', description: 'Hold for Group / VIP', blocksAssignment: true },
  { code: 'VIP', description: 'VIP amenity set-up', blocksAssignment: false },
  { code: 'CHK', description: 'Engineering re-check', blocksAssignment: false },
];

export const OOO_REASONS: ReasonCode[] = [
  { code: 'PLB', description: 'Plumbing / water leak' },
  { code: 'ELE', description: 'Electrical fault' },
  { code: 'HVA', description: 'A/C - HVAC failure' },
  { code: 'RNV', description: 'Renovation' },
  { code: 'DEP', description: 'Deep cleaning' },
  { code: 'FUR', description: 'Furniture damage' },
];

const ATTENDANTS: Attendant[] = [
  { id: 'HK01', name: 'Li Na', section: 'A', maxCredits: 140 },
  { id: 'HK02', name: 'Wang Fang', section: 'B', maxCredits: 140 },
  { id: 'HK03', name: 'Zhang Min', section: 'C', maxCredits: 140 },
  { id: 'HK04', name: 'Chen Jing', section: 'D', maxCredits: 140 },
  { id: 'HK05', name: 'Maria Santos', section: null, maxCredits: 120 },
  { id: 'HK06', name: 'Liu Yang', section: null, maxCredits: 120 },
];

const FIRST = ['Wei', 'Jun', 'Xiao', 'Hui', 'Emma', 'James', 'Olivia', 'Noah', 'Sakura', 'Kenji', 'Ana', 'Lucas', 'Mei', 'Hao', 'Sophie', 'Daniel', 'Yuki', 'Ming', 'Grace', 'Arjun'];
const LAST = ['Wang', 'Li', 'Zhang', 'Liu', 'Chen', 'Smith', 'Brown', 'Garcia', 'Tanaka', 'Sato', 'Muller', 'Rossi', 'Huang', 'Zhao', 'Martin', 'Kim', 'Park', 'Nguyen', 'Lopez', 'Wu'];
const SPECIALS = ['High Floor', 'Late Check-out', 'Extra Pillow', 'Baby Cot', 'Quiet Room', 'Early Check-in'];

function roomTypeFor(floor: number, idx: number): string {
  if (floor === 9 && idx >= 10) return 'ES';
  if (idx === 12) return 'JS';
  if (idx >= 10) return 'DK';
  if (idx >= 7) return 'ST';
  return 'SK';
}

function sectionFor(floor: number): string {
  return floor <= 3 ? 'A' : floor <= 5 ? 'B' : floor <= 7 ? 'C' : 'D';
}

export const DEFAULT_SUBSCRIBERS: Omit<Subscriber, 'mirror' | 'delivered' | 'failed' | 'lastDeliveryAt'>[] = [
  {
    id: 'SUB-HSK',
    name: 'Housekeeping Mobile App',
    kind: 'HOUSEKEEPING_APP',
    description: '第三方房务App（类似 HotSOS / Optii）：订阅房态、占用、OOO 与入住/退房事件，维护移动端房态',
    events: [EVENTS.HK_STATUS, EVENTS.HK_OCCUPANCY, EVENTS.OOO_PLACED, EVENTS.OOO_RELEASED, EVENTS.OOS_PLACED, EVENTS.OOS_RELEASED, EVENTS.CHECK_IN, EVENTS.CHECK_OUT, EVENTS.ROOM_MOVE, EVENTS.SERVICE_STATUS, EVENTS.ATTENDANT, EVENTS.NIGHT_AUDIT],
    enabled: true,
    failureRate: 0,
  },
  {
    id: 'SUB-PBX',
    name: 'PBX / Telephone System',
    kind: 'PBX',
    description: '电话交换机：入住开通外线、退房关闭外线；同时可通过话机拨码回写房态（入站）',
    events: [EVENTS.CHECK_IN, EVENTS.CHECK_OUT, EVENTS.ROOM_MOVE, EVENTS.NIGHT_AUDIT],
    enabled: true,
    failureRate: 0,
  },
  {
    id: 'SUB-LOCK',
    name: 'Door Lock System',
    kind: 'DOOR_LOCK',
    description: '门锁系统：入住制卡生效、退房/换房使旧卡失效',
    events: [EVENTS.CHECK_IN, EVENTS.CHECK_OUT, EVENTS.ROOM_MOVE, EVENTS.NIGHT_AUDIT],
    enabled: true,
    failureRate: 0,
  },
  {
    id: 'SUB-BMS',
    name: 'Energy Management (BMS)',
    kind: 'ENERGY',
    description: '楼宇能耗系统：空房/维修房切换节能模式，入住切换舒适模式',
    events: [EVENTS.CHECK_IN, EVENTS.CHECK_OUT, EVENTS.ROOM_MOVE, EVENTS.OOO_PLACED, EVENTS.OOO_RELEASED, EVENTS.OOS_PLACED, EVENTS.OOS_RELEASED, EVENTS.NIGHT_AUDIT],
    enabled: true,
    failureRate: 0,
  },
  {
    id: 'SUB-CHN',
    name: 'Channel Manager / Inventory',
    kind: 'CHANNEL',
    description: '渠道/库存：OOO 扣减可售库存（OOS 不扣减），按房型同步可售房数',
    events: [EVENTS.OOO_PLACED, EVENTS.OOO_RELEASED, EVENTS.NIGHT_AUDIT],
    enabled: true,
    failureRate: 0,
  },
];

export interface SeedOptions {
  businessDate?: string;
  seed?: number;
}

/** Build the initial demo state for a business date. */
export function createSeed(opts: SeedOptions = {}): Snapshot {
  const D = opts.businessDate ?? todayIso();
  const rnd = mulberry32(opts.seed ?? 20160615);
  const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];
  const ts = (hh: number, mm: number) => {
    const d = new Date(`${D}T00:00:00`);
    d.setHours(hh, mm, 0, 0);
    return d.toISOString();
  };

  const rooms: Room[] = [];
  for (let floor = 2; floor <= 9; floor++) {
    for (let i = 1; i <= 12; i++) {
      const number = `${floor}${String(i).padStart(2, '0')}`;
      const features = ['NS'];
      if (i <= 4) features.push('CV');
      else if (i >= 9) features.push('LV');
      if (floor === 2 && i <= 2) features.push('ACC');
      rooms.push({
        id: number.padStart(4, '0'),
        number,
        floor,
        roomType: roomTypeFor(floor, i),
        features,
        hkStatus: 'Inspected',
        outOfOrder: null,
        hkOccupancy: null,
        hkPersons: null,
        serviceStatus: null,
        turndown: 'Not Required',
        conditionCode: null,
        attendantId: null,
        section: sectionFor(floor),
        lastStatusChange: ts(7, 0),
        lastChangedBy: 'NIGHT AUDIT',
      });
    }
  }

  const reservations: Reservation[] = [];
  let conf = 482110;
  const newResv = (p: Partial<Reservation> & Pick<Reservation, 'arrival' | 'departure' | 'roomType' | 'status'>): Reservation => {
    conf += 7 + Math.floor(rnd() * 13);
    const adults = 1 + (rnd() < 0.55 ? 1 : 0);
    const r: Reservation = {
      id: `R${conf}`,
      confirmationNo: String(conf),
      guestName: `${pick(LAST)}, ${pick(FIRST)}`,
      vip: rnd() < 0.1 ? pick(['V1', 'V2', 'V3']) : null,
      adults,
      children: rnd() < 0.12 ? 1 : 0,
      roomId: null,
      queue: null,
      eta: `${String(12 + Math.floor(rnd() * 9)).padStart(2, '0')}:${rnd() < 0.5 ? '00' : '30'}`,
      specials: rnd() < 0.3 ? [pick(SPECIALS)] : [],
      checkedInAt: null,
      checkedOutAt: null,
      ...p,
    };
    reservations.push(r);
    return r;
  };

  // Shuffle room order deterministically, then allocate by scenario.
  const order = [...rooms].sort(() => rnd() - 0.5);
  let cursor = 0;
  const take = (n: number) => order.slice(cursor, (cursor += n));

  // 1) Stay-overs (in house, depart later) — 34 rooms
  for (const room of take(34)) {
    const arrival = addDays(D, -(1 + Math.floor(rnd() * 4)));
    const r = newResv({ arrival, departure: addDays(D, 1 + Math.floor(rnd() * 3)), roomType: room.roomType, status: 'InHouse', roomId: room.id });
    r.checkedInAt = `${arrival}T15:${String(Math.floor(rnd() * 59)).padStart(2, '0')}:00.000Z`;
    room.hkStatus = rnd() < 0.3 ? 'Clean' : 'Dirty';
    if (room.hkStatus === 'Clean') room.lastStatusChange = ts(9 + Math.floor(rnd() * 2), Math.floor(rnd() * 59));
    if (rnd() < 0.45) {
      room.hkOccupancy = 'Occupied';
      room.hkPersons = r.adults + r.children;
    }
    if (rnd() < 0.1) room.serviceStatus = 'DND';
    else if (rnd() < 0.08) room.serviceStatus = 'MUR';
    if (r.vip || room.roomType === 'ES' || room.roomType === 'JS') room.turndown = 'Required';
  }
  // 2) Due-outs (in house, depart today) — 16 rooms
  for (const room of take(16)) {
    const arrival = addDays(D, -(1 + Math.floor(rnd() * 3)));
    const r = newResv({ arrival, departure: D, roomType: room.roomType, status: 'InHouse', roomId: room.id });
    r.checkedInAt = `${arrival}T14:${String(Math.floor(rnd() * 59)).padStart(2, '0')}:00.000Z`;
    room.hkStatus = 'Dirty';
  }
  // 3) Departed this morning — 9 rooms
  for (const room of take(9)) {
    const r = newResv({ arrival: addDays(D, -2), departure: D, roomType: room.roomType, status: 'CheckedOut', roomId: room.id });
    r.checkedInAt = `${addDays(D, -2)}T15:10:00.000Z`;
    r.checkedOutAt = ts(7 + Math.floor(rnd() * 3), Math.floor(rnd() * 59));
    room.hkStatus = pick<HkStatus>(['Dirty', 'Dirty', 'Dirty', 'Clean', 'Pickup']);
    room.lastStatusChange = r.checkedOutAt;
    room.lastChangedBy = 'OC-FD1';
  }
  // 4) Day use (in house today only) — 1 room
  for (const room of take(1)) {
    const r = newResv({ arrival: D, departure: D, roomType: room.roomType, status: 'InHouse', roomId: room.id });
    r.checkedInAt = ts(9, 5);
    room.hkOccupancy = 'Occupied';
    room.hkPersons = r.adults;
  }
  // Remaining rooms are vacant: mix of statuses
  const vacant = order.slice(cursor);
  for (const room of vacant) {
    room.hkStatus = pick<HkStatus>(['Inspected', 'Inspected', 'Inspected', 'Clean', 'Clean', 'Dirty']);
  }
  // 5) OOO / OOS
  const oooActive = vacant.find((r) => r.hkStatus === 'Dirty' && r.roomType === 'SK')!;
  oooActive.outOfOrder = { id: 'OOO-1001', type: 'OOO', from: addDays(D, -1), to: addDays(D, 2), reasonCode: 'PLB', returnStatus: 'Dirty', remarks: 'Bathroom leak, waiting for spare part' };
  const oosActive = vacant.find((r) => r.hkStatus === 'Clean' && r !== oooActive)!;
  oosActive.outOfOrder = { id: 'OOO-1002', type: 'OOS', from: D, to: D, reasonCode: 'FUR', returnStatus: 'Inspected', remarks: 'TV replacement today' };
  const oooFuture = vacant.find((r) => r.roomType === 'DK' && r !== oooActive && r !== oosActive)!;
  oooFuture.outOfOrder = { id: 'OOO-1003', type: 'OOO', from: addDays(D, 3), to: addDays(D, 6), reasonCode: 'RNV', returnStatus: 'Dirty', remarks: 'Carpet replacement' };
  const blocked = new Set([oooActive.id, oosActive.id]);

  // 6) Arrivals today — 12 pre-assigned, 10 unassigned
  const assignable = vacant.filter((r) => !blocked.has(r.id));
  const ready = assignable.filter((r) => r.hkStatus !== 'Dirty');
  const dirty = assignable.filter((r) => r.hkStatus === 'Dirty');
  const usedForArrival = new Set<string>();
  for (const room of ready.slice(0, 9)) {
    newResv({ arrival: D, departure: addDays(D, 1 + Math.floor(rnd() * 3)), roomType: room.roomType, status: 'Reserved', roomId: room.id });
    usedForArrival.add(room.id);
  }
  for (const [i, room] of dirty.slice(0, 3).entries()) {
    const r = newResv({ arrival: D, departure: addDays(D, 2), roomType: room.roomType, status: 'Reserved', roomId: room.id, eta: '10:30' });
    usedForArrival.add(room.id);
    if (i < 2) r.queue = { queuedAt: new Date(Date.now() - (34 - i * 21) * 60000).toISOString(), priority: i + 1 };
  }
  for (let i = 0; i < 10; i++) {
    newResv({ arrival: D, departure: addDays(D, 1 + Math.floor(rnd() * 4)), roomType: pick(['SK', 'SK', 'ST', 'DK', 'DK', 'JS']), status: 'Reserved' });
  }
  // 7) Future arrivals (D+1..D+3) — some assigned so OOO conflict checks have something to find
  for (let day = 1; day <= 3; day++) {
    for (let i = 0; i < 12; i++) {
      newResv({ arrival: addDays(D, day), departure: addDays(D, day + 1 + Math.floor(rnd() * 3)), roomType: pick(['SK', 'SK', 'ST', 'DK', 'JS', 'ES']), status: 'Reserved' });
    }
  }
  const futureTarget = vacant.find((r) => !blocked.has(r.id) && !usedForArrival.has(r.id) && r.roomType === 'SK');
  if (futureTarget) {
    newResv({ arrival: addDays(D, 2), departure: addDays(D, 4), roomType: 'SK', status: 'Reserved', roomId: futureTarget.id, guestName: 'Future, Guest' });
  }

  // 8) Seeded discrepancies & conditions
  const inHouse = reservations.filter((r) => r.status === 'InHouse' && r.arrival !== r.departure);
  const skipRoom = rooms.find((r) => r.id === inHouse[3]?.roomId);
  if (skipRoom) { skipRoom.hkOccupancy = 'Vacant'; skipRoom.hkPersons = 0; skipRoom.serviceStatus = null; }
  const personRoom = rooms.find((r) => r.id === inHouse[5]?.roomId);
  if (personRoom) { personRoom.hkOccupancy = 'Occupied'; personRoom.hkPersons = 4; }
  const sleepRoom = vacant.find((r) => !blocked.has(r.id) && !usedForArrival.has(r.id) && r !== futureTarget);
  if (sleepRoom) { sleepRoom.hkOccupancy = 'Occupied'; sleepRoom.hkPersons = 1; }
  const showRoom = vacant.find((r) => r.roomType === 'JS' && !blocked.has(r.id) && !usedForArrival.has(r.id));
  if (showRoom) { showRoom.conditionCode = 'SHW'; showRoom.hkStatus = 'Inspected'; }

  const hotel = {
    hotelId: 'DEMO1',
    name: 'OPERA Demo Hotel',
    chainCode: 'DEMO',
    businessDate: D,
    parameters: {
      inspectedStatusEnabled: true,
      pickupStatusEnabled: true,
      allowCheckInClean: true,
      autoDirtyOnNightAudit: true,
    },
  };

  const snapshot: Snapshot = {
    version: 1,
    hotel,
    roomTypes: ROOM_TYPES.map((t) => ({ ...t })),
    rooms,
    reservations,
    attendants: ATTENDANTS.map((a) => ({ ...a })),
    conditions: CONDITIONS.map((c) => ({ ...c })),
    oooReasons: OOO_REASONS.map((c) => ({ ...c })),
    events: [],
    subscribers: [],
    deliveries: [],
    apiLog: [],
  };
  return snapshot;
}
