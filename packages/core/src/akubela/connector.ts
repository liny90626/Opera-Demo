/**
 * Akubela GRMS connector (WBS-B2) – pure logic, see docs/07-akubela-integration-design.md §4.
 * Outbound planner (PMS event → job), per-key FIFO job queue with retry/backoff, inbound polling/reconcile,
 * room mapping and echo suppression. All GRMS traffic goes through one logging wrapper (`grms`).
 */
import type { BusinessEvent, Reservation, Room } from '../types.ts';
import { EVENTS } from '../events.ts';
import {
  AKUBELA_ACTOR,
  DEFAULT_SETTINGS,
  GrmsError,
  type AkubelaAlarm,
  type AkubelaConnectorApi,
  type AkubelaSettings,
  type AkubelaState,
  type ApiCallLog,
  type ConnectorDeps,
  type GrmsCommand,
  type GrmsDevice,
  type GrmsOrder,
  type GrmsOrderState,
  type GrmsResidence,
  type GrmsRoomInfo,
  type GrmsRoomListBuilding,
  type GrmsRoomSnapshot,
  type GrmsScene,
  type Job,
  type JobAction,
  type OrderLink,
  type RoomMapping,
} from './contract.ts';

const CAP_JOBS = 200;
const CAP_LOG = 300;
const CAP_ALARMS = 100;
const CAP_EXTERNAL = 50;
const BACKOFF_MS = [2000, 4000, 8000, 16000, 32000];
const MASTER_TTL_MS = 5 * 60_000;
const DIRTY_ECHO_MS = 30_000;
const ORDER_PAGE = 50;
const ORDER_MISSING = 20017008;
const REDACT_KEYS = new Set(['id_card', 'passport', 'phone', 'email', 'pin_code', 'pin', 'client_secret', 'access_token', 'refresh_token']);

// ───────────────────────────────────────────────────────────── time helpers
function tzOffsetMs(utcMs: number, tz: string): number {
  let f: Intl.DateTimeFormat;
  try {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return 0; // unknown timezone → treat as UTC
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(utcMs))) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** "2026-06-15" + "14:00" in `tz` → epoch ms (UTC). */
export function localToUtcMs(date: string, hhmm: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi || 0);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

const fmtUtc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const parseUtc = (s: string | undefined | null): number | null => {
  if (!s) return null;
  const t = Date.parse(s.replace(' ', 'T') + 'Z');
  return Number.isNaN(t) ? null : t;
};

// ───────────────────────────────────────────────────────────── misc helpers
class SkipError extends Error {}

export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = REDACT_KEYS.has(k) ? '***' : redact(x);
    return out;
  }
  return v;
}

const asGrmsError = (e: unknown): GrmsError =>
  e instanceof GrmsError ? e : new GrmsError(e instanceof Error ? e.message : String(e), -1, undefined, undefined, true);

const errInfo = (e: GrmsError) => ({ code: e.code, message: e.message, ...(e.traceId ? { traceId: e.traceId } : {}) });
const jobSeqOf = (id: string) => Number(id.replace(/^\D+/, '')) || 0;

function guestName(raw: string): string {
  const s = (raw || '').trim();
  if (!s) return 'Guest';
  const i = s.indexOf(',');
  return i < 0 ? s : `${s.slice(i + 1).trim()} ${s.slice(0, i).trim()}`.trim();
}

function randomPin(): string {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return String(a[0] % 1_000_000).padStart(6, '0');
}

interface Payload {
  dirty?: boolean;
  fromRoomId?: string;
  toRoomId?: string;
}

interface NewJob {
  key: string;
  action: JobAction;
  ev?: BusinessEvent;
  reservationId?: string | null;
  roomId?: string | null;
  summary: string;
  payload?: Payload;
  status?: 'PENDING' | 'SKIPPED';
}

interface Ctx {
  jobId: string;
  n: number;
}

export function createAkubelaConnector(deps: ConnectorDeps): AkubelaConnectorApi {
  const nowMs = () => (deps.now ? deps.now() : Date.now());
  const isoNow = () => new Date(nowMs()).toISOString();
  const init = deps.initialState ?? {};

  const st: AkubelaState = {
    mode: deps.mode,
    baseUrl: deps.baseUrl ?? init.baseUrl ?? null,
    clientIdMasked: deps.clientIdMasked ?? init.clientIdMasked ?? null,
    connected: false,
    token: null,
    lastPollAt: init.lastPollAt ?? null,
    lastError: null,
    settings: { ...DEFAULT_SETTINGS, ...(init.settings ?? {}) },
    residences: init.residences ? [...init.residences] : [],
    roomTypes: init.roomTypes ? [...init.roomTypes] : [],
    mappings: init.mappings ? init.mappings.map((m) => ({ ...m })) : [],
    links: init.links ? init.links.map((l) => ({ ...l })) : [],
    grmsRooms: { ...(init.grmsRooms ?? {}) },
    externalOrders: init.externalOrders ? [...init.externalOrders] : [],
    // a job that was RUNNING when the process stopped is simply re-queued
    jobs: (init.jobs ?? []).slice(0, CAP_JOBS).map((j) => ({ ...j, status: j.status === 'RUNNING' ? ('PENDING' as const) : j.status, nextRunAt: j.status === 'RUNNING' ? 0 : j.nextRunAt })),
    apiLog: (init.apiLog ?? []).slice(0, CAP_LOG),
    alarms: (init.alarms ?? []).slice(0, CAP_ALARMS),
    stats: { jobsSucceeded: 0, jobsFailed: 0, inboundApplied: 0, ...(init.stats ?? {}) },
    version: init.version ?? 0,
  };

  let jobSeq = st.jobs.reduce((m, j) => Math.max(m, jobSeqOf(j.id)), 0);
  let logSeq = st.apiLog.reduce((m, l) => Math.max(m, jobSeqOf(l.id)), 0);
  let alarmSeq = 0;
  const payloads = new Map<string, Payload>();
  const lastDirtyWrite = new Map<string, number>(); // roomId → ms of our last dirty=true write
  const userMapped = new Set<string>(); // rooms mapped via setMapping() in this process (beat deps.roomMap)
  const seenEvents: string[] = [];
  const seenEventSet = new Set<string>();
  const activeKeys = new Set<string>();
  let lastMasterAt = 0;
  let pollRunning = false;
  let drainTimer: ReturnType<typeof setInterval> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const changed = () => {
    st.version++;
    deps.onStateChange?.(st);
  };
  const notice = (kind: 'info' | 'warning' | 'error', text: string) => deps.onNotice?.({ kind, text });

  // ─────────────────────────────────────────────────────────── PMS helpers
  const snap = () => deps.pms.snapshot();
  const roomById = (id: string): Room | undefined => snap().rooms.find((r) => r.id === id);
  const roomByAny = (v: string | null | undefined): Room | undefined => (v ? snap().rooms.find((r) => r.id === v || r.number === v) : undefined);
  const roomNo = (id: string) => roomById(id)?.number ?? id;
  const resvById = (id: string | null | undefined): Reservation | undefined => (id ? snap().reservations.find((r) => r.id === id) : undefined);

  // ─────────────────────────────────────────────────────────── mapping
  const mappingOf = (roomId: string) => st.mappings.find((m) => m.roomId === roomId);
  const residenceIdOf = (roomId: string): string | null => mappingOf(roomId)?.residenceId ?? null;
  const roomOfResidence = (rid: string): string | null => st.mappings.find((m) => m.residenceId === rid)?.roomId ?? null;

  function rebuildMappings(): boolean {
    const next: RoomMapping[] = [];
    for (const room of snap().rooms) {
      const existing = mappingOf(room.id);
      const override = userMapped.has(room.id) ? undefined : (deps.roomMap?.[room.id] ?? deps.roomMap?.[room.number]);
      let m: RoomMapping;
      if (override !== undefined) {
        const res = st.residences.find((r) => r.residence_name === override);
        m = { roomId: room.id, residenceId: res?.residence_id ?? null, residenceName: res?.residence_name ?? override, origin: 'manual' };
      } else if (existing?.origin === 'manual') {
        const res = existing.residenceId ? st.residences.find((r) => r.residence_id === existing.residenceId) : undefined;
        m = { ...existing, residenceName: res?.residence_name ?? existing.residenceName };
      } else {
        const res = st.residences.find((r) => r.residence_name === room.number);
        m = { roomId: room.id, residenceId: res?.residence_id ?? null, residenceName: res?.residence_name ?? null, origin: 'auto' };
      }
      next.push(m);
    }
    const diff = next.length !== st.mappings.length || next.some((m, i) => JSON.stringify(m) !== JSON.stringify(st.mappings[i]));
    if (diff) st.mappings = next;
    return diff;
  }
  rebuildMappings();

  // ─────────────────────────────────────────────────────────── transport wrapper
  async function grms<T>(command: GrmsCommand, param: Record<string, unknown>, o: { direction: 'OUT' | 'IN'; jobId?: string; commandId?: string }): Promise<T> {
    const t0 = nowMs();
    const log: ApiCallLog = { id: `L-${++logSeq}`, ts: new Date(t0).toISOString(), direction: o.direction, command, param: redact(param), ok: false, durationMs: 0 };
    if (o.jobId) log.jobId = o.jobId;
    const finish = () => {
      log.durationMs = Math.max(0, nowMs() - t0);
      st.apiLog.unshift(log);
      if (st.apiLog.length > CAP_LOG) st.apiLog.length = CAP_LOG;
    };
    try {
      if (!deps.transport) throw new GrmsError('GRMS integration is off (no transport)', -2);
      const res = await deps.transport.call<T>(command, param, o.commandId ? { commandId: o.commandId } : undefined);
      log.ok = true;
      st.connected = true;
      const ti = deps.transport.tokenInfo();
      st.token = ti ? { expiresAt: ti.expiresAt } : null;
      finish();
      changed();
      return res;
    } catch (e) {
      const ge = asGrmsError(e);
      log.ok = false;
      log.code = ge.code;
      log.message = ge.message;
      if (ge.traceId) log.traceId = ge.traceId;
      if (ge.retryable && ge.code === -1) st.connected = false;
      st.lastError = errInfo(ge);
      finish();
      changed();
      throw ge;
    }
  }

  // ─────────────────────────────────────────────────────────── master data
  async function refreshMasterData(): Promise<void> {
    const tree = await grms<GrmsRoomListBuilding[]>('get_room_list', {}, { direction: 'IN' });
    const flat: GrmsResidence[] = [];
    for (const b of tree ?? []) for (const f of b.floors ?? []) for (const r of f.residences ?? [])
      flat.push({ residence_id: r.residence_id, residence_name: r.residence_name, building_id: b.building_id, building_name: b.building_name, floor_name: f.floor_name });
    st.residences = flat;
    try {
      const types = await grms<{ room_type_id: string; room_type_name: string }[]>('get_room_type_list', { page_size: 100, page_index: 1 }, { direction: 'IN' });
      st.roomTypes = (types ?? []).map((t) => ({ room_type_id: t.room_type_id, room_type_name: t.room_type_name }));
    } catch {
      /* room types are informational only */
    }
    lastMasterAt = nowMs();
    st.lastError = null;
    rebuildMappings();
    changed();
  }

  // ─────────────────────────────────────────────────────────── links & jobs
  const openLink = (resvId: string) => st.links.find((l) => l.reservationId === resvId && !l.closed);
  const lastLink = (resvId: string) => [...st.links].reverse().find((l) => l.reservationId === resvId);
  const touchLink = (l: OrderLink, patch: Partial<OrderLink>) => {
    Object.assign(l, patch, { updatedAt: isoNow() });
    changed();
  };
  const activeJob = (key: string, action: JobAction) => st.jobs.some((j) => j.key === key && j.action === action && (j.status === 'PENDING' || j.status === 'RUNNING'));

  function enqueue(n: NewJob): Job {
    const ts = isoNow();
    const job: Job = {
      id: `J-${++jobSeq}`,
      key: n.key,
      action: n.action,
      eventId: n.ev?.id ?? null,
      eventName: n.ev?.eventName ?? null,
      reservationId: n.reservationId ?? null,
      roomId: n.roomId ?? null,
      summary: n.summary,
      status: n.status ?? 'PENDING',
      attempts: 0,
      nextRunAt: 0,
      lastError: null,
      createdAt: ts,
      updatedAt: ts,
    };
    if (n.payload) payloads.set(job.id, n.payload);
    st.jobs.unshift(job);
    while (st.jobs.length > CAP_JOBS) {
      let idx = -1;
      for (let i = st.jobs.length - 1; i >= 0; i--) {
        const s = st.jobs[i].status;
        if (s !== 'PENDING' && s !== 'RUNNING') { idx = i; break; }
      }
      const [gone] = st.jobs.splice(idx < 0 ? st.jobs.length - 1 : idx, 1);
      payloads.delete(gone.id);
    }
    changed();
    return job;
  }

  // ─────────────────────────────────────────────────────────── outbound planner
  function handleEvents(events: BusinessEvent[]): void {
    if (!deps.transport || st.mode === 'off') return;
    for (const ev of events) {
      if (ev.source === 'AKUBELA') continue; // echo suppression
      if (seenEventSet.has(ev.id)) continue;
      seenEventSet.add(ev.id);
      seenEvents.push(ev.id);
      if (seenEvents.length > 1000) seenEventSet.delete(seenEvents.shift()!);
      plan(ev);
    }
  }

  function plan(ev: BusinessEvent): void {
    const S = st.settings;
    const detail = (name: string) => ev.details.find((d) => d.elementName === name);
    switch (ev.eventName) {
      case EVENTS.ROOM_ASSIGN: {
        const resvId = ev.primaryKey;
        const res = resvById(resvId);
        const newId = ev.roomIds[ev.roomIds.length - 1];
        const oldRoom = roomByAny(detail('RoomId')?.oldValue);
        if (oldRoom && oldRoom.id !== newId && (openLink(resvId) || activeJob(`resv:${resvId}`, 'PRE_REGISTER')))
          enqueue({ key: `resv:${resvId}`, action: 'CANCEL_ORDER', ev, reservationId: resvId, roomId: oldRoom.id, summary: `Cancel pre-registered order #${res?.confirmationNo ?? resvId} (room ${oldRoom.number} released)` });
        if (S.preRegisterOnAssign && res?.status === 'Reserved' && residenceIdOf(newId))
          enqueue({ key: `resv:${resvId}`, action: 'PRE_REGISTER', ev, reservationId: resvId, roomId: newId, summary: `Pre-register #${res.confirmationNo} → room ${roomNo(newId)}` });
        return;
      }
      case EVENTS.ROOM_UNASSIGN: {
        const room = roomByAny(ev.roomIds[0]);
        if (!room || !residenceIdOf(room.id)) return;
        const res = resvById(ev.primaryKey);
        enqueue({ key: `resv:${ev.primaryKey}`, action: 'CANCEL_ORDER', ev, reservationId: ev.primaryKey, roomId: room.id, summary: `Cancel order #${res?.confirmationNo ?? ev.primaryKey} (room ${room.number} released)` });
        return;
      }
      case EVENTS.CHECK_IN:
      case EVENTS.CHECK_OUT: {
        const roomId = ev.roomIds[0];
        if (!roomId || !residenceIdOf(roomId)) return;
        const res = resvById(ev.primaryKey);
        const isIn = ev.eventName === EVENTS.CHECK_IN;
        enqueue({ key: `resv:${ev.primaryKey}`, action: isIn ? 'CHECK_IN' : 'CHECK_OUT', ev, reservationId: ev.primaryKey, roomId, summary: `${isIn ? 'Check-in' : 'Check-out'} #${res?.confirmationNo ?? ev.primaryKey} ${isIn ? '→' : '←'} room ${roomNo(roomId)}` });
        return;
      }
      case EVENTS.ROOM_MOVE: {
        const [from, to] = ev.roomIds;
        if (!from || !to || (!residenceIdOf(from) && !residenceIdOf(to))) return;
        const res = resvById(ev.primaryKey);
        enqueue({ key: `resv:${ev.primaryKey}`, action: 'ROOM_MOVE', ev, reservationId: ev.primaryKey, roomId: to, payload: { fromRoomId: from, toRoomId: to }, summary: `Room move #${res?.confirmationNo ?? ev.primaryKey}: ${roomNo(from)} → ${roomNo(to)}` });
        return;
      }
      case EVENTS.HK_STATUS: {
        const roomId = ev.roomIds[0];
        if (!S.syncHkStatus || !roomId || !residenceIdOf(roomId)) return;
        const v = (detail('RoomStatus') ?? ev.details[0])?.newValue;
        const dirty = v === 'Dirty' || v === 'Pickup' ? true : v === 'Clean' || v === 'Inspected' ? false : null;
        if (dirty === null) return;
        enqueue({ key: `room:${roomId}`, action: 'ROOM_STATE', ev, roomId, payload: { dirty }, summary: `Room ${roomNo(roomId)} → ${dirty ? 'dirty' : 'clean'}` });
        return;
      }
      case EVENTS.NIGHT_AUDIT: {
        for (const l of st.links.filter((x) => !x.closed && x.state === 'check_in')) {
          const res = resvById(l.reservationId);
          if (res?.status === 'NoShow' && !activeJob(`resv:${res.id}`, 'CANCEL_ORDER'))
            enqueue({ key: `resv:${res.id}`, action: 'CANCEL_ORDER', ev, reservationId: res.id, roomId: l.roomId, summary: `Cancel order #${res.confirmationNo} (no-show)` });
        }
        return;
      }
      case EVENTS.SERVICE_STATUS: {
        const d = detail('ServiceStatus');
        if (d?.newValue !== 'MUR' && d?.oldValue !== 'MUR') return; // DND is inbound-only, not an error
        break;
      }
      case EVENTS.OOO_PLACED:
      case EVENTS.OOO_RELEASED:
      case EVENTS.OOS_PLACED:
      case EVENTS.OOS_RELEASED:
      case EVENTS.TURNDOWN:
      case EVENTS.CONDITION:
        break;
      default:
        return;
    }
    // unsupported by the GRMS OpenAPI → recorded as SKIPPED so the UI can show it
    const room = ev.roomIds.map(roomByAny).find((r) => r && residenceIdOf(r.id));
    if (!room) return;
    enqueue({ key: `room:${room.id}`, action: 'UNSUPPORTED', ev, roomId: room.id, status: 'SKIPPED', summary: `${ev.eventName} room ${room.number} – not supported by GRMS OpenAPI` });
  }

  // ─────────────────────────────────────────────────────────── queue runner
  function dueCandidates(): string[] {
    const now = nowMs();
    const byKey = new Map<string, Job[]>();
    for (const j of st.jobs) if (j.status === 'PENDING' || j.status === 'RUNNING') (byKey.get(j.key) ?? byKey.set(j.key, []).get(j.key)!).push(j);
    const keys: string[] = [];
    for (const [key, list] of byKey) {
      if (activeKeys.has(key)) continue;
      const head = list.reduce((a, b) => (jobSeqOf(a.id) <= jobSeqOf(b.id) ? a : b));
      if (head.status === 'PENDING' && head.nextRunAt <= now) keys.push(key);
    }
    return keys;
  }

  function nextJobOfKey(key: string): Job | null {
    const now = nowMs();
    let head: Job | null = null;
    for (const j of st.jobs) if (j.key === key && (j.status === 'PENDING' || j.status === 'RUNNING') && (!head || jobSeqOf(j.id) < jobSeqOf(head.id))) head = j;
    return head && head.status === 'PENDING' && head.nextRunAt <= now ? head : null;
  }

  async function drain(): Promise<void> {
    const keys = dueCandidates();
    await Promise.all(
      keys.map(async (key) => {
        activeKeys.add(key);
        try {
          for (let j = nextJobOfKey(key); j; j = nextJobOfKey(key)) await execute(j);
        } finally {
          activeKeys.delete(key);
        }
      }),
    );
  }

  async function execute(job: Job): Promise<void> {
    job.status = 'RUNNING';
    job.attempts++;
    job.updatedAt = isoNow();
    changed();
    const ctx: Ctx = { jobId: job.id, n: 0 };
    try {
      await run(job, ctx);
      job.status = 'SUCCEEDED';
      job.lastError = null;
      st.stats.jobsSucceeded++;
    } catch (e) {
      if (e instanceof SkipError) {
        job.status = 'SKIPPED';
        job.summary = `${job.summary} – ${e.message}`;
        job.lastError = null;
      } else {
        const ge = asGrmsError(e);
        job.lastError = errInfo(ge);
        if (ge.retryable && job.attempts <= BACKOFF_MS.length) {
          job.status = 'PENDING';
          job.nextRunAt = nowMs() + BACKOFF_MS[job.attempts - 1];
        } else {
          job.status = ge.retryable ? 'DEAD' : 'FAILED';
          st.stats.jobsFailed++;
          notice('error', `Akubela job ${job.status.toLowerCase()}: ${job.summary} (${ge.message})`);
        }
      }
    }
    job.updatedAt = isoNow();
    changed();
  }

  // ─────────────────────────────────────────────────────────── job execution
  const out = <T>(ctx: Ctx, command: GrmsCommand, param: Record<string, unknown>) =>
    grms<T>(command, param, { direction: 'OUT', jobId: ctx.jobId, commandId: `opera-${ctx.jobId}${ctx.n++ ? `-${ctx.n - 1}` : ''}` });

  function guestParam(res: Reservation) {
    return {
      guest_name: guestName(res.guestName),
      email: res.email || 'no-email@opera-demo.local',
      phone: res.phone || 'N/A',
      id_card: 'N/A',
      passport: 'N/A',
    };
  }

  function stayTimes(res: Reservation, immediate: boolean) {
    const S = st.settings;
    const nowPlus = nowMs() + 60_000;
    let start = immediate ? nowPlus : Math.max(nowPlus, localToUtcMs(res.arrival, S.checkInTime, S.hotelTimezone));
    let finish = localToUtcMs(res.departure, S.checkOutTime, S.hotelTimezone);
    if (finish <= start) finish = start + 3_600_000;
    return { start, finish };
  }

  async function createOrder(ctx: Ctx, res: Reservation, roomId: string, o: { immediate: boolean; remark?: string }): Promise<OrderLink> {
    const residenceId = residenceIdOf(roomId);
    if (!residenceId) throw new SkipError(`room ${roomNo(roomId)} is not mapped to a GRMS residence`);
    const { start, finish } = stayTimes(res, o.immediate);
    const r = await out<{ order_id: string; order_number: string; guest_id?: string }>(ctx, 'create_order_info', {
      residence_id: residenceId,
      start_time: fmtUtc(start),
      finish_time: fmtUtc(finish),
      guest: guestParam(res),
      source: st.settings.orderSource,
      remark: o.remark ?? `OPERA #${res.confirmationNo}`,
      enable_booking: false,
    });
    const ts = isoNow();
    const link: OrderLink = {
      reservationId: res.id,
      confirmationNo: res.confirmationNo,
      orderId: r.order_id,
      orderNumber: r.order_number,
      residenceId,
      roomId,
      state: 'check_in',
      closed: false,
      createdAt: ts,
      updatedAt: ts,
      ...(r.guest_id ? { guestId: r.guest_id } : {}),
    };
    st.links.push(link);
    changed();
    return link;
  }

  /** update_order_info with the order's current times (read first; falls back to computed ones). */
  async function updateOrder(ctx: Ctx, link: OrderLink, res: Reservation | undefined, state: GrmsOrderState): Promise<void> {
    let cur: Partial<GrmsOrder> = {};
    try {
      cur = await grms<GrmsOrder>('get_order_info', { order_id: link.orderId }, { direction: 'IN', jobId: ctx.jobId });
    } catch (e) {
      const ge = asGrmsError(e);
      if (ge.code === ORDER_MISSING) throw ge;
    }
    const now = nowMs();
    const fallback = res ? stayTimes(res, state === 'checked_in') : { start: now + 60_000, finish: now + 3_600_000 };
    let start = parseUtc(cur.start_time) ?? fallback.start;
    let finish = parseUtc(cur.finish_time) ?? fallback.finish;
    if (state === 'checked_in') {
      if (start < now + 60_000) start = now + 60_000;
      if (finish <= start) finish = start + 3_600_000;
    } else if (state === 'checked_out') {
      finish = Math.max(now, start + 1000);
    }
    await out(ctx, 'update_order_info', {
      order_id: link.orderId,
      start_time: fmtUtc(start),
      finish_time: fmtUtc(finish),
      order_state: state,
      source: st.settings.orderSource,
      remark: cur.remark || `OPERA #${link.confirmationNo}`,
      enable_booking: false,
    });
    touchLink(link, { state });
  }

  async function setDirty(ctx: Ctx, roomId: string, dirty: boolean): Promise<void> {
    const rid = residenceIdOf(roomId);
    if (!rid) return;
    await out(ctx, 'update_room_state', { residence_id: rid, dirty });
    if (dirty) lastDirtyWrite.set(roomId, nowMs());
  }

  async function dropAuth(ctx: Ctx, link: OrderLink): Promise<void> {
    if (!link.authRecordId) return;
    try {
      await out(ctx, 'delete_authorization_record_info', { record_id: link.authRecordId });
    } catch (e) {
      const ge = asGrmsError(e);
      if (ge.retryable) throw ge;
    }
    const patch: Partial<OrderLink> = { authRecordId: undefined, pin: undefined };
    delete link.authRecordId;
    delete link.pin;
    touchLink(link, patch);
  }

  async function triggerSceneFor(ctx: Ctx, sceneId: string | null, roomId: string): Promise<void> {
    const rid = residenceIdOf(roomId);
    if (!sceneId || !rid) return;
    await out(ctx, 'manual_trigger_scene', { scene_id: sceneId, residences: [{ residence_id: rid }] });
  }

  /** Cancel (pending) or check out (active) the order of a link and mark it closed. */
  async function closeLink(ctx: Ctx, link: OrderLink, res: Reservation | undefined, markDirty: boolean): Promise<void> {
    if (link.state === 'check_in') {
      try {
        await out(ctx, 'delete_order_info', { order_id: link.orderId });
      } catch (e) {
        if (asGrmsError(e).code !== ORDER_MISSING) throw e;
      }
    } else if (link.state === 'checked_in') {
      await updateOrder(ctx, link, res, 'checked_out');
    }
    await dropAuth(ctx, link);
    if (markDirty) await setDirty(ctx, link.roomId, true);
    touchLink(link, { closed: true });
  }

  async function performCheckIn(ctx: Ctx, res: Reservation, roomId: string, remark?: string): Promise<void> {
    if (!residenceIdOf(roomId)) throw new SkipError(`room ${roomNo(roomId)} is not mapped to a GRMS residence`);
    let link = openLink(res.id);
    if (link && link.roomId !== roomId) {
      await closeLink(ctx, link, res, link.state === 'checked_in');
      link = undefined;
    }
    if (!link) link = await createOrder(ctx, res, roomId, { immediate: true, remark });
    if (link.state === 'check_in') await updateOrder(ctx, link, res, 'checked_in');
    if (st.settings.doorPinOnCheckIn && !link.authRecordId && link.guestId) {
      const pin = randomPin();
      const now = nowMs();
      const { finish } = stayTimes(res, true);
      const r = await out<{ record_id: string }>(ctx, 'create_authorization_record_info', {
        access_type: 'password',
        pin_code: pin,
        guest_id: link.guestId,
        residence_id: link.residenceId,
        start_time: fmtUtc(now + 60_000),
        finish_time: fmtUtc(finish),
      });
      touchLink(link, { authRecordId: r.record_id, pin });
    }
    await triggerSceneFor(ctx, st.settings.welcomeSceneId, roomId);
  }

  async function run(job: Job, ctx: Ctx): Promise<void> {
    const res = resvById(job.reservationId);
    const pl = payloads.get(job.id) ?? {};
    switch (job.action) {
      case 'PRE_REGISTER': {
        if (!res || res.status !== 'Reserved' || !res.roomId) throw new SkipError('reservation is no longer a reserved arrival with a room');
        const open = openLink(res.id);
        if (open && open.roomId === res.roomId) return; // already registered
        if (open) await closeLink(ctx, open, res, false);
        await createOrder(ctx, res, res.roomId, { immediate: false });
        return;
      }
      case 'CANCEL_ORDER': {
        const link = openLink(job.reservationId ?? '');
        if (!link) throw new SkipError('no open GRMS order');
        if (link.state === 'checked_in') throw new SkipError('order already checked in');
        await closeLink(ctx, link, res, false);
        return;
      }
      case 'CHECK_IN': {
        if (!res || res.status !== 'InHouse' || !res.roomId) throw new SkipError('reservation is not in house');
        await performCheckIn(ctx, res, res.roomId);
        return;
      }
      case 'CHECK_OUT': {
        const link = openLink(job.reservationId ?? '');
        if (!link) throw new SkipError('no open GRMS order');
        if (link.state === 'check_in') {
          await closeLink(ctx, link, res, true); // never checked in on GRMS: just drop it
          return;
        }
        if (link.state !== 'checked_out') await updateOrder(ctx, link, res, 'checked_out');
        await setDirty(ctx, link.roomId, true);
        await dropAuth(ctx, link);
        await triggerSceneFor(ctx, st.settings.checkoutSceneId, link.roomId);
        touchLink(link, { closed: true });
        return;
      }
      case 'ROOM_MOVE': {
        if (!res || res.status !== 'InHouse' || !res.roomId) throw new SkipError('reservation is not in house');
        const toRoom = res.roomId;
        const open = openLink(res.id);
        if (open && open.roomId === toRoom) return;
        const fromId = pl.fromRoomId ?? open?.roomId ?? lastLink(res.id)?.roomId;
        if (open) await closeLink(ctx, open, res, true);
        if (!residenceIdOf(toRoom)) throw new SkipError('target room is not mapped');
        await performCheckIn(ctx, res, toRoom, fromId ? `Room move from ${roomNo(fromId)}` : undefined);
        return;
      }
      case 'ROOM_STATE': {
        const roomId = job.roomId;
        const room = roomId ? roomById(roomId) : undefined;
        if (!roomId || !room) throw new SkipError('room not found');
        const dirty = pl.dirty ?? (room.hkStatus === 'Dirty' || room.hkStatus === 'Pickup');
        await setDirty(ctx, roomId, dirty);
        return;
      }
      default:
        throw new SkipError('not supported by GRMS OpenAPI');
    }
  }

  // ─────────────────────────────────────────────────────────── inbound polling
  const pendingRoomWork = (roomId: string) =>
    st.jobs.some((j) => (j.status === 'PENDING' || j.status === 'RUNNING') && (j.roomId === roomId || payloads.get(j.id)?.fromRoomId === roomId) && ['ROOM_STATE', 'CHECK_OUT', 'ROOM_MOVE', 'CHECK_IN'].includes(j.action));

  function applied(text: string) {
    st.stats.inboundApplied++;
    notice('info', text);
  }

  function applyRoomRules(roomId: string, info: GrmsRoomInfo, prev: GrmsRoomSnapshot | undefined): void {
    const room = roomById(roomId);
    if (!room) return;
    const S = st.settings;
    if (S.acceptGrmsClean && !pendingRoomWork(roomId)) {
      const recent = nowMs() - (lastDirtyWrite.get(roomId) ?? -Infinity) < DIRTY_ECHO_MS;
      if (info.dirty === false && (room.hkStatus === 'Dirty' || room.hkStatus === 'Pickup') && !recent) {
        const r = deps.pms.exec({ type: 'setHkStatus', roomIds: [roomId], status: 'Clean' }, AKUBELA_ACTOR);
        if (r.ok) applied(`GRMS: room ${room.number} cleaned → set Clean in OPERA`);
      } else if (info.dirty === true && S.syncHkStatus && (room.hkStatus === 'Clean' || room.hkStatus === 'Inspected')) {
        const r = deps.pms.exec({ type: 'setHkStatus', roomIds: [roomId], status: 'Dirty' }, AKUBELA_ACTOR);
        if (r.ok) applied(`GRMS: room ${room.number} marked dirty → set Dirty in OPERA`);
      }
    }
    if (S.acceptGrmsDnd) {
      const was = prev?.dnd ?? false;
      const inHouse = snap().reservations.some((r) => r.status === 'InHouse' && r.roomId === roomId);
      if (info.dnd !== was && inHouse) {
        if (info.dnd && room.serviceStatus !== 'DND') {
          if (deps.pms.exec({ type: 'setServiceStatus', roomIds: [roomId], service: 'DND' }, AKUBELA_ACTOR).ok) applied(`GRMS: room ${room.number} Do Not Disturb on`);
        } else if (!info.dnd && room.serviceStatus === 'DND') {
          if (deps.pms.exec({ type: 'setServiceStatus', roomIds: [roomId], service: null }, AKUBELA_ACTOR).ok) applied(`GRMS: room ${room.number} Do Not Disturb off`);
        }
      }
    }
  }

  async function pollRooms(): Promise<void> {
    for (const m of st.mappings) {
      if (!m.residenceId) continue;
      const prev = st.grmsRooms[m.residenceId];
      try {
        const info = await grms<GrmsRoomInfo>('get_room_info', { residence_id: m.residenceId }, { direction: 'IN' });
        st.grmsRooms[m.residenceId] = {
          residenceId: m.residenceId, dirty: info.dirty ?? null, occupied: info.occupied ?? null, dnd: info.dnd ?? null,
          orderId: info.order_id || null, fetchedAt: isoNow(), error: null,
        };
        applyRoomRules(m.roomId, info, prev);
      } catch (e) {
        const ge = asGrmsError(e);
        st.grmsRooms[m.residenceId] = {
          residenceId: m.residenceId, dirty: prev?.dirty ?? null, occupied: prev?.occupied ?? null, dnd: prev?.dnd ?? null,
          orderId: prev?.orderId ?? null, fetchedAt: isoNow(), error: errInfo(ge),
        };
      }
      changed();
    }
  }

  async function fetchPaged<T>(command: GrmsCommand, maxPages: number): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const list = (await grms<T[]>(command, { page_size: ORDER_PAGE, page_index: page }, { direction: 'IN' })) ?? [];
      all.push(...list);
      if (list.length < ORDER_PAGE) break;
    }
    return all;
  }

  async function pollOrders(): Promise<void> {
    const orders = await fetchPaged<GrmsOrder>('get_order_list', 20);
    const external: GrmsOrder[] = [];
    for (const o of orders) {
      const link = st.links.find((l) => l.orderId === o.order_id);
      if (!link) { external.push(o); continue; }
      if (link.closed) continue;
      if (o.order_state === 'checked_out' && link.state !== 'checked_out') {
        const res = resvById(link.reservationId);
        if (res?.status === 'InHouse') {
          if (!st.settings.acceptGrmsCheckout) continue;
          const r = deps.pms.exec({ type: 'checkOut', reservationId: res.id }, AKUBELA_ACTOR);
          if (r.ok) applied(`GRMS: guest ${res.guestName} checked out of room ${roomNo(link.roomId)} → checked out in OPERA`);
          else notice('warning', `GRMS check-out of ${res.guestName} could not be applied: ${r.error ?? 'unknown'}`);
        }
        touchLink(link, { state: 'checked_out', closed: true });
      } else if (o.order_state === 'checked_in' && link.state === 'check_in') {
        touchLink(link, { state: 'checked_in' });
      }
    }
    st.externalOrders = external.slice(0, CAP_EXTERNAL);
    changed();
  }

  async function pollAlarms(): Promise<void> {
    const recs = await fetchPaged<Record<string, unknown>>('get_alarm_record_list', 3);
    const known = new Set(st.alarms.map((a) => a.id));
    const now = nowMs();
    const fresh: AkubelaAlarm[] = [];
    for (const r of recs) {
      const type = String(r.alarm_type ?? 'alarm');
      const rid = typeof r.residence_id === 'string' ? r.residence_id : null;
      const id = `${r.alarm_time}|${type}|${rid}`;
      if (known.has(id)) continue;
      known.add(id);
      const t = parseUtc(String(r.alarm_time ?? ''));
      const roomId = rid ? roomOfResidence(rid) : null;
      const where = roomId ? `room ${roomNo(roomId)}` : (st.residences.find((x) => x.residence_id === rid)?.residence_name ?? 'unknown location');
      fresh.push({ id, ts: new Date(t ?? now).toISOString(), residenceId: rid, roomId, type, message: `${type.replace(/_/g, ' ')} – ${where}`, raw: r });
      void alarmSeq++;
    }
    if (!fresh.length) return;
    st.alarms = [...fresh, ...st.alarms].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)).slice(0, CAP_ALARMS);
    for (const a of fresh) {
      if (Date.parse(a.ts) >= now - 10 * 60_000) {
        notice(/sos|smoke|co_|gas/.test(a.type) ? 'error' : 'warning', `GRMS alarm: ${a.message}`);
        st.stats.inboundApplied++;
      }
    }
    changed();
  }

  async function poll(): Promise<void> {
    if (!deps.transport || st.mode === 'off' || pollRunning) return;
    pollRunning = true;
    try {
      if (!st.residences.length || nowMs() - lastMasterAt > MASTER_TTL_MS) {
        try { await refreshMasterData(); } catch { /* logged by wrapper; continue with what we have */ }
      }
      rebuildMappings();
      await pollRooms();
      try { await pollOrders(); } catch { /* logged */ }
      try { await pollAlarms(); } catch { /* logged */ }
      st.lastPollAt = isoNow();
      changed();
    } finally {
      pollRunning = false;
    }
  }

  // ─────────────────────────────────────────────────────────── reconcile
  async function reconcile(): Promise<number> {
    if (!deps.transport || st.mode === 'off') return 0;
    if (!st.residences.length) { try { await refreshMasterData(); } catch { /* ignore */ } }
    rebuildMappings();
    let issues = 0;
    const S = st.settings;
    const s = snap();
    // 1. in-house guests in mapped rooms without an open order
    for (const m of st.mappings) {
      if (!m.residenceId) continue;
      const res = s.reservations.find((r) => r.status === 'InHouse' && r.roomId === m.roomId);
      if (!res || openLink(res.id) || activeJob(`resv:${res.id}`, 'CHECK_IN') || activeJob(`resv:${res.id}`, 'ROOM_MOVE')) continue;
      issues++;
      enqueue({ key: `resv:${res.id}`, action: 'CHECK_IN', reservationId: res.id, roomId: m.roomId, summary: `Reconcile: check-in #${res.confirmationNo} → room ${roomNo(m.roomId)}` });
    }
    // 2. open links vs PMS reservation and GRMS order
    for (const link of st.links.filter((l) => !l.closed)) {
      const res = resvById(link.reservationId);
      const key = `resv:${link.reservationId}`;
      const busy = st.jobs.some((j) => j.key === key && (j.status === 'PENDING' || j.status === 'RUNNING'));
      if (busy) continue;
      const repair = (action: JobAction, why: string) => {
        issues++;
        enqueue({ key, action, reservationId: link.reservationId, roomId: res?.roomId ?? link.roomId, summary: `Reconcile: ${why} #${link.confirmationNo}` });
      };
      if (!res || res.status === 'NoShow' || res.status === 'Cancelled') {
        if (link.state === 'check_in') repair('CANCEL_ORDER', 'cancel order');
        continue;
      }
      if (res.status === 'CheckedOut') {
        if (link.state !== 'checked_out' || !link.closed) repair('CHECK_OUT', 'check-out');
        continue;
      }
      if (res.roomId && res.roomId !== link.roomId) {
        if (res.status === 'InHouse') repair('ROOM_MOVE', 'room move');
        else { repair('CANCEL_ORDER', 'cancel order (room changed)'); if (S.preRegisterOnAssign && residenceIdOf(res.roomId)) repair('PRE_REGISTER', 're-register'); }
        continue;
      }
      if (res.status === 'InHouse' && link.state === 'check_in') { repair('CHECK_IN', 'check-in'); continue; }
      // verify against GRMS
      try {
        const o = await grms<GrmsOrder>('get_order_info', { order_id: link.orderId }, { direction: 'IN' });
        if (o.order_state === 'check_in' && link.state === 'checked_in' && res.status === 'InHouse') {
          touchLink(link, { state: 'check_in' });
          repair('CHECK_IN', 'order state repair');
        } else if (o.order_state !== link.state && o.order_state !== 'checked_out') {
          touchLink(link, { state: o.order_state });
        }
      } catch (e) {
        if (asGrmsError(e).code === ORDER_MISSING) {
          touchLink(link, { closed: true });
          if (res.status === 'InHouse') repair('CHECK_IN', 'recreate missing order');
          else if (res.status === 'Reserved' && res.roomId && S.preRegisterOnAssign) repair('PRE_REGISTER', 'recreate missing order');
          else issues++;
        }
      }
    }
    changed();
    return issues;
  }

  // ─────────────────────────────────────────────────────────── devices, scenes (pass-through)
  async function listDevices(roomId: string): Promise<GrmsDevice[]> {
    const rid = residenceIdOf(roomId) ?? residenceIdOf(roomByAny(roomId)?.id ?? '');
    if (!rid) throw new Error(`Room ${roomId} is not mapped to a GRMS residence`);
    const all: GrmsDevice[] = [];
    for (let page = 1; page <= 5; page++) {
      const list = (await grms<GrmsDevice[]>('get_device_list', { page_size: 100, page_index: page, residence_id: rid, show_ability: true, parallel_sub_device: false }, { direction: 'IN' })) ?? [];
      all.push(...list);
      if (list.length < 100) break;
    }
    return all;
  }

  async function controlDevice(param: { device_id: string; ability_id: string; control: string; attribute?: Record<string, unknown> }): Promise<void> {
    await grms('control_device', { ...param }, { direction: 'OUT' });
  }

  async function listScenes(): Promise<GrmsScene[]> {
    return (await grms<GrmsScene[]>('get_scene_list', { page_size: 100, page_index: 1 }, { direction: 'IN' })) ?? [];
  }

  async function triggerScene(sceneId: string, roomIds: string[]): Promise<void> {
    const residences = roomIds.map((r) => residenceIdOf(roomByAny(r)?.id ?? r)).filter((x): x is string => !!x).map((residence_id) => ({ residence_id }));
    if (!residences.length) throw new Error('None of the selected rooms is mapped to a GRMS residence');
    await grms('manual_trigger_scene', { scene_id: sceneId, residences }, { direction: 'OUT' });
  }

  // ─────────────────────────────────────────────────────────── misc API
  function retryJob(jobId: string): void {
    const j = st.jobs.find((x) => x.id === jobId);
    if (!j || (j.status !== 'FAILED' && j.status !== 'DEAD')) return;
    j.status = 'PENDING';
    j.attempts = 0;
    j.nextRunAt = 0;
    j.updatedAt = isoNow();
    changed();
  }

  function setMapping(roomId: string, residenceId: string | null): void {
    const room = roomByAny(roomId);
    const id = room?.id ?? roomId;
    userMapped.add(id);
    const res = residenceId ? st.residences.find((r) => r.residence_id === residenceId) : undefined;
    const m: RoomMapping = { roomId: id, residenceId, residenceName: res?.residence_name ?? null, origin: 'manual' };
    const i = st.mappings.findIndex((x) => x.roomId === id);
    if (i >= 0) st.mappings[i] = m; else st.mappings.push(m);
    changed();
  }

  function updateSettings(patch: Partial<AkubelaSettings>): void {
    const pollChanged = patch.pollSeconds !== undefined && patch.pollSeconds !== st.settings.pollSeconds;
    st.settings = { ...st.settings, ...patch };
    if (pollChanged && pollTimer) { clearInterval(pollTimer); pollTimer = null; startPollTimer(); }
    changed();
  }

  const unref = (t: unknown) => (t as { unref?: () => void } | null)?.unref?.();
  function startPollTimer() {
    pollTimer = setInterval(() => { void poll().catch(() => {}); }, Math.max(1, st.settings.pollSeconds) * 1000);
    unref(pollTimer);
  }
  function start(): void {
    if (drainTimer || !deps.transport || st.mode === 'off') return;
    drainTimer = setInterval(() => { void drain().catch(() => {}); }, 1000);
    unref(drainTimer);
    startPollTimer();
    void poll().catch(() => {});
  }
  function stop(): void {
    if (drainTimer) clearInterval(drainTimer);
    if (pollTimer) clearInterval(pollTimer);
    drainTimer = pollTimer = null;
  }

  return {
    getState: () => st,
    handleEvents,
    drain,
    poll,
    reconcile,
    refreshMasterData,
    retryJob,
    setMapping,
    updateSettings,
    listDevices,
    controlDevice,
    listScenes,
    triggerScene,
    start,
    stop,
  };
}
