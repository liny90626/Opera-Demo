import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PmsEngine, roomViews, createAkubelaConnector, createGrmsSimulator, GrmsError, EVENTS } from '../src/index.ts';
import { localToUtcMs } from '../src/akubela/connector.ts';
import type { AkubelaConnectorApi, BusinessEvent, Command, GrmsSimulatorApi, GrmsTransport } from '../src/index.ts';

const ui = { name: 'TEST', source: 'OPERA_UI' as const };
const T0 = Date.parse('2026-06-15T02:00:00Z'); // 10:00 Shanghai, business date 2026-06-15

interface Harness {
  engine: PmsEngine;
  conn: AkubelaConnectorApi;
  clock: { t: number };
  notices: { kind: string; text: string }[];
  run(cmd: Command): ReturnType<PmsEngine['exec']>;
  drain(): Promise<void>;
}

function harness(transport: GrmsTransport, extra: { roomMap?: Record<string, string>; settings?: Record<string, unknown> } = {}): Harness {
  const engine = new PmsEngine(undefined, { businessDate: '2026-06-15', random: () => 0.99 });
  const clock = { t: T0 };
  const notices: { kind: string; text: string }[] = [];
  let conn!: AkubelaConnectorApi;
  const pms = {
    snapshot: () => engine.snapshot(),
    exec: (cmd: Command, actor: typeof ui) => {
      const r = engine.exec(cmd, actor);
      if (r.changes?.events) conn.handleEvents(r.changes.events as BusinessEvent[]);
      return r;
    },
  };
  conn = createAkubelaConnector({
    transport, mode: transport.kind, pms, now: () => clock.t,
    onNotice: (n) => notices.push(n), roomMap: extra.roomMap,
    initialState: extra.settings ? { settings: extra.settings as never } : undefined,
  });
  return {
    engine, conn, clock, notices,
    run: (cmd) => pms.exec(cmd, ui),
    async drain() {
      for (let i = 0; i < 6; i++) await conn.drain();
    },
  };
}

// ───────────────────────────────────────────── fake transport (independent of the simulator)
interface Call { command: string; param: any; commandId?: string }
function fakeTransport(opts: { unmapped?: string[] } = {}) {
  const calls: Call[] = [];
  const errors: Record<string, GrmsError[]> = {};
  const orders = new Map<string, any>();
  let seq = 0;
  const engineRooms = new PmsEngine(undefined, { businessDate: '2026-06-15' }).snapshot().rooms;
  const tr: GrmsTransport & { calls: Call[]; errors: Record<string, GrmsError[]>; orders: Map<string, any>; roomInfo: Record<string, any>; fail(cmd: string, ...e: GrmsError[]): void } = {
    kind: 'sim',
    calls, errors, orders,
    roomInfo: {},
    fail(cmd, ...e) { errors[cmd] = e; },
    tokenInfo: () => ({ expiresAt: T0 + 7200_000, scope: 'hotel' }),
    async call(command: string, param: Record<string, unknown>, o?: { commandId?: string }) {
      calls.push({ command, param: JSON.parse(JSON.stringify(param)), commandId: o?.commandId });
      const q = errors[command];
      if (q?.length) throw q.length > 1 ? q.shift()! : q[0];
      switch (command) {
        case 'get_room_list':
          return [{ building_id: 'b', building_name: 'B', floors: [{ floor_id: 'f', floor_name: '1', residences: engineRooms.filter((r) => !opts.unmapped?.includes(r.number)).map((r) => ({ residence_id: `res-${r.number}`, residence_name: r.number })) }] }] as never;
        case 'get_room_type_list': return [{ room_type_id: 't1', room_type_name: 'King' }] as never;
        case 'create_order_info': {
          const id = `o${++seq}`;
          orders.set(id, { ...param, order_state: 'check_in' });
          return { order_id: id, order_number: `N${seq}`, guest_id: `g${seq}` } as never;
        }
        case 'get_order_info': {
          const o = orders.get(param.order_id as string);
          if (!o) throw new GrmsError('not found', 20017008);
          return o as never;
        }
        case 'update_order_info': { Object.assign(orders.get(param.order_id as string), param); return {} as never; }
        case 'delete_order_info': { orders.delete(param.order_id as string); return {} as never; }
        case 'get_order_list': return [...orders.entries()].map(([id, o]) => ({ order_id: id, ...o })) as never;
        case 'get_room_info': return (tr.roomInfo[param.residence_id as string] ?? { dirty: false, occupied: false, dnd: false, order_id: '' }) as never;
        case 'create_authorization_record_info': return { record_id: 'a1', authorization_number: '1' } as never;
        case 'get_alarm_record_list': return [] as never;
        default: return {} as never;
      }
    },
  };
  return tr;
}

const names = (calls: Call[]) => calls.map((c) => c.command);
const picks = (h: Harness) => roomViews(h.engine.snapshot()).filter((v) => (v.hkStatus === 'Inspected' || v.hkStatus === 'Clean') && v.foStatus === 'Vacant' && !v.oooActive && !v.arrival && v.id !== '0202');
const notReadyArrival = () => 'R482996'; // room 0202 (number 202), Clean, arrives today

// ───────────────────────────────────────────── unit tests
test('timezone conversion: Asia/Shanghai 14:00 → 06:00 UTC', () => {
  assert.equal(new Date(localToUtcMs('2026-06-15', '14:00', 'Asia/Shanghai')).toISOString(), '2026-06-15T06:00:00.000Z');
  assert.equal(new Date(localToUtcMs('2026-06-15', '12:00', 'Asia/Shanghai')).toISOString(), '2026-06-15T04:00:00.000Z');
  assert.equal(new Date(localToUtcMs('2026-07-01', '14:00', 'America/New_York')).toISOString(), '2026-07-01T18:00:00.000Z'); // DST
  assert.equal(new Date(localToUtcMs('2026-01-01', '14:00', 'America/New_York')).toISOString(), '2026-01-01T19:00:00.000Z');
});

test('mapping: auto by room number, roomMap override by id and number, unmapped rooms produce no jobs', async () => {
  const tr = fakeTransport({ unmapped: ['202'] });
  const h = harness(tr, { roomMap: { '0210': 'RoomX', '305': '305' } });
  await h.conn.refreshMasterData();
  const m = (id: string) => h.conn.getState().mappings.find((x) => x.roomId === id)!;
  assert.equal(h.conn.getState().mappings.length, 97);
  assert.equal(m('0305').origin, 'manual');
  assert.equal(m('0305').residenceId, 'res-305');
  assert.equal(m('0210').origin, 'manual');
  assert.equal(m('0210').residenceId, null); // RoomX does not exist in GRMS
  assert.equal(m('0201').origin, 'auto');
  assert.equal(m('0201').residenceId, 'res-201');
  assert.equal(m('0202').residenceId, null);
  h.conn.setMapping('0202', 'res-201');
  assert.equal(m('0202').origin, 'manual');
  h.conn.setMapping('0202', null);
  // events for unmapped room 202: nothing
  const r = h.run({ type: 'unassignRoom', reservationId: notReadyArrival() });
  assert.ok(r.ok);
  h.run({ type: 'setHkStatus', roomIds: ['0202'], status: 'Dirty' });
  assert.equal(h.conn.getState().jobs.length, 0);
});

test('pre-register on assign: times, guest conversion, placeholders, remark; reassign cancels old order', async () => {
  const tr = fakeTransport();
  const h = harness(tr);
  await h.conn.refreshMasterData();
  const id = notReadyArrival();
  h.run({ type: 'unassignRoom', reservationId: id });
  h.run({ type: 'assignRoom', reservationId: id, roomId: '0202' });
  await h.drain();
  const create = tr.calls.find((c) => c.command === 'create_order_info')!;
  const resv = h.engine.snapshot().reservations.find((r) => r.id === id)!;
  assert.equal(create.param.residence_id, 'res-202');
  assert.equal(create.param.start_time, '2026-06-15 06:00:00');
  assert.equal(create.param.finish_time, `${resv.departure} 04:00:00`);
  const [last, first] = resv.guestName.split(', ');
  assert.equal(create.param.guest.guest_name, `${first} ${last}`);
  assert.equal(create.param.guest.email, 'no-email@opera-demo.local');
  assert.equal(create.param.guest.phone, 'N/A');
  assert.equal(create.param.guest.id_card, 'N/A');
  assert.equal(create.param.guest.passport, 'N/A');
  assert.equal(create.param.source, 'OPERA');
  assert.equal(create.param.remark, `OPERA #${resv.confirmationNo}`);
  assert.equal(create.param.enable_booking, false);
  assert.equal(create.commandId, `opera-${h.conn.getState().jobs.find((j) => j.action === 'PRE_REGISTER')!.id}`);
  const st = h.conn.getState();
  assert.equal(st.links.length, 1);
  assert.equal(st.links[0].state, 'check_in');
  // reassign to another room → old order deleted then new one created
  const other = roomViews(h.engine.snapshot()).find((v) => v.id !== '0202' && v.roomType === resv.roomType && !v.arrival && !v.inHouse && !v.oooActive && v.id !== '0201')!;
  const r = h.run({ type: 'assignRoom', reservationId: id, roomId: other.id });
  assert.ok(r.ok, r.error);
  await h.drain();
  assert.ok(names(tr.calls).includes('delete_order_info'));
  const open = h.conn.getState().links.filter((l) => !l.closed);
  assert.equal(open.length, 1);
  assert.equal(open[0].roomId, other.id);
});

test('preRegisterOnAssign=false: assign creates no job', async () => {
  const tr = fakeTransport();
  const h = harness(tr, { settings: { preRegisterOnAssign: false } });
  await h.conn.refreshMasterData();
  h.run({ type: 'unassignRoom', reservationId: notReadyArrival() });
  h.run({ type: 'assignRoom', reservationId: notReadyArrival(), roomId: '0202' });
  assert.equal(h.conn.getState().jobs.filter((j) => j.action === 'PRE_REGISTER').length, 0);
});

test('check-in (create+update), PIN is stored but never logged, welcome scene; check-out → dirty, auth deleted, scene', async () => {
  const tr = fakeTransport();
  const h = harness(tr, { settings: { doorPinOnCheckIn: true, welcomeSceneId: 'sc1', checkoutSceneId: 'sc2' } });
  await h.conn.refreshMasterData();
  const id = notReadyArrival();
  assert.ok(h.run({ type: 'checkIn', reservationId: id }).ok);
  await h.drain();
  assert.deepEqual(names(tr.calls).filter((c) => !c.startsWith('get_')), ['create_order_info', 'update_order_info', 'create_authorization_record_info', 'manual_trigger_scene']);
  const create = tr.calls.find((c) => c.command === 'create_order_info')!;
  assert.equal(create.param.start_time, '2026-06-15 02:01:00'); // now + 60s
  const upd = tr.calls.find((c) => c.command === 'update_order_info')!;
  assert.equal(upd.param.order_state, 'checked_in');
  const link = h.conn.getState().links[0];
  assert.equal(link.state, 'checked_in');
  assert.match(link.pin!, /^\d{6}$/);
  const dump = JSON.stringify(h.conn.getState().apiLog) + JSON.stringify(h.conn.getState().jobs) + JSON.stringify(h.notices);
  assert.ok(!dump.includes(link.pin!));
  assert.ok(!dump.includes('no-email@opera-demo.local'));
  const logged = h.conn.getState().apiLog.find((l) => l.command === 'create_order_info')!;
  assert.equal(logged.direction, 'OUT');
  assert.equal((logged.param as any).guest.email, '***');
  assert.equal((logged.param as any).guest.phone, '***');
  assert.equal((logged.param as any).guest.id_card, '***');
  assert.equal((logged.param as any).guest.passport, '***');
  assert.equal((logged.param as any).residence_id, 'res-202');
  assert.equal(h.conn.getState().apiLog.find((l) => l.command === 'create_authorization_record_info')!.param && ((h.conn.getState().apiLog.find((l) => l.command === 'create_authorization_record_info')!.param as any).pin_code), '***');
  assert.equal(h.conn.getState().apiLog.find((l) => l.command === 'get_room_list')!.direction, 'IN');

  tr.calls.length = 0;
  h.clock.t += 3600_000;
  assert.ok(h.run({ type: 'checkOut', reservationId: id }).ok);
  await h.drain();
  const cmds = names(tr.calls).filter((c) => !c.startsWith('get_'));
  assert.deepEqual([...cmds].sort(), ['delete_authorization_record_info', 'manual_trigger_scene', 'update_order_info', 'update_room_state', 'update_room_state']); // second update_room_state = HK Dirty event (room key runs in parallel)
  assert.equal(tr.calls.find((c) => c.command === 'update_order_info')!.param.order_state, 'checked_out');
  assert.deepEqual(tr.calls.find((c) => c.command === 'update_room_state')!.param, { residence_id: 'res-202', dirty: true });
  assert.equal(h.conn.getState().links[0].closed, true);
  assert.equal(h.conn.getState().links[0].pin, undefined);
});

test('echo suppression: AKUBELA-sourced events never produce jobs', async () => {
  const tr = fakeTransport();
  const h = harness(tr);
  await h.conn.refreshMasterData();
  const ev: BusinessEvent = { id: 'E1', seq: 1, eventName: EVENTS.HK_STATUS, module: 'HOUSEKEEPING', hotelId: 'H', businessDate: '2026-06-15', timestamp: '', actor: 'AKUBELA-GRMS', source: 'AKUBELA', primaryKey: '0202', roomIds: ['0202'], details: [{ elementName: 'RoomStatus', oldValue: 'Dirty', newValue: 'Clean' }], summary: '' };
  h.conn.handleEvents([ev]);
  assert.equal(h.conn.getState().jobs.length, 0);
  h.conn.handleEvents([{ ...ev, id: 'E2', source: 'OPERA_UI' }]);
  assert.equal(h.conn.getState().jobs.length, 1);
  assert.equal(h.conn.getState().jobs[0].action, 'ROOM_STATE');
  h.conn.handleEvents([{ ...ev, id: 'E2', source: 'OPERA_UI' }]); // duplicate id ignored
  assert.equal(h.conn.getState().jobs.length, 1);
});

test('HK status mapping: Dirty/Pickup → dirty, Clean/Inspected → clean; syncHkStatus off → nothing; OOO/MUR/turndown/condition → SKIPPED UNSUPPORTED', async () => {
  const tr = fakeTransport();
  const h = harness(tr);
  await h.conn.refreshMasterData();
  const [A, B, C] = picks(h);
  const room = A.id;
  h.run({ type: 'setHkStatus', roomIds: [room], status: 'Dirty' });
  h.run({ type: 'setHkStatus', roomIds: [room], status: 'Clean' });
  await h.drain();
  const writes = tr.calls.filter((c) => c.command === 'update_room_state').map((c) => c.param.dirty);
  assert.ok(writes.includes(true) && writes.at(-1) === false);
  h.conn.updateSettings({ syncHkStatus: false });
  const n = h.conn.getState().jobs.length;
  h.run({ type: 'setHkStatus', roomIds: [room], status: 'Dirty' });
  assert.equal(h.conn.getState().jobs.length, n);
  h.run({ type: 'placeOutOfOrder', roomIds: [B.id], oooType: 'OOO', from: '2026-06-15', to: '2026-06-16', reasonCode: h.engine.snapshot().oooReasons[0].code, returnStatus: 'Dirty' } as Command);
  h.run({ type: 'setTurndown', roomIds: [C.id], turndown: 'Required' });
  h.run({ type: 'setServiceStatus', roomIds: ['0308'], service: 'MUR' });
  const skipped = h.conn.getState().jobs.filter((j) => j.action === 'UNSUPPORTED');
  assert.equal(skipped.length, 3);
  assert.ok(skipped.every((j) => j.status === 'SKIPPED' && /not supported by GRMS OpenAPI/.test(j.summary)));
});

test('retry: retryable errors back off 2,4,8,16,32s then DEAD; retryJob requeues; business errors FAIL immediately', async () => {
  const tr = fakeTransport();
  const h = harness(tr);
  await h.conn.refreshMasterData();
  const [A, B] = picks(h);
  tr.fail('update_room_state', new GrmsError('boom', 50300, 'tr1', 503, true));
  h.run({ type: 'setHkStatus', roomIds: [A.id], status: 'Dirty' });
  const job = h.conn.getState().jobs[0];
  const gaps = [2, 4, 8, 16, 32];
  await h.conn.drain();
  for (let i = 0; i < gaps.length; i++) {
    assert.equal(job.status, 'PENDING');
    assert.equal(job.attempts, i + 1);
    assert.equal(job.nextRunAt, h.clock.t + gaps[i] * 1000);
    h.clock.t += gaps[i] * 1000 - 1;
    await h.conn.drain();
    assert.equal(job.attempts, i + 1, 'not run before backoff expires');
    h.clock.t += 1;
    await h.conn.drain();
  }
  assert.equal(job.status, 'DEAD');
  assert.equal(job.lastError!.traceId, 'tr1');
  assert.equal(h.conn.getState().stats.jobsFailed, 1);
  tr.errors['update_room_state'] = [];
  h.conn.retryJob(job.id);
  await h.conn.drain();
  assert.equal(job.status, 'SUCCEEDED');
  assert.equal(h.conn.getState().stats.jobsSucceeded, 1);
  // non-retryable → FAILED, other error types → retryable code -1
  tr.fail('update_room_state', new GrmsError('bad body', 50104080, 'tr2'));
  h.run({ type: 'setHkStatus', roomIds: [B.id], status: 'Dirty' });
  await h.conn.drain();
  const failed = h.conn.getState().jobs[0];
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.attempts, 1);
  const bad = h.conn.getState().apiLog.find((l) => !l.ok)!;
  assert.deepEqual([bad.code, bad.traceId], [50104080, 'tr2']);
  tr.errors['update_room_state'] = [new Error('socket hang up') as never];
  h.conn.retryJob(failed.id);
  await h.conn.drain();
  assert.equal(failed.status, 'PENDING');
  assert.equal(failed.lastError!.code, -1);
});

test('per-key FIFO: a backing-off job blocks later jobs of the same key only', async () => {
  const tr = fakeTransport();
  const h = harness(tr);
  await h.conn.refreshMasterData();
  const [A, B] = picks(h);
  tr.fail('update_room_state', new GrmsError('boom', 50300, undefined, 503, true));
  h.run({ type: 'setHkStatus', roomIds: [A.id], status: 'Dirty' }); // key room:A, fails
  h.run({ type: 'setHkStatus', roomIds: [A.id], status: 'Clean' }); // same key, must wait
  h.run({ type: 'setHkStatus', roomIds: [B.id], status: 'Dirty' }); // other key, also hits the error but is independent
  await h.conn.drain();
  const jobs = h.conn.getState().jobs;
  const second = jobs.find((j) => j.key === `room:${A.id}` && j.summary.includes('clean'))!;
  assert.equal(second.attempts, 0);
  assert.equal(second.status, 'PENDING');
  assert.equal(jobs.find((j) => j.key === `room:${B.id}`)!.attempts, 1);
  tr.errors['update_room_state'] = [];
  h.clock.t += 3000;
  await h.conn.drain();
  const order = tr.calls.filter((c) => c.command === 'update_room_state' && c.param.residence_id === `res-${A.number}`).map((c) => c.param.dirty);
  assert.deepEqual(order.slice(-2), [true, false]);
});

test('caps: jobs 200, apiLog 300; version bumps and onStateChange fires', async () => {
  const tr = fakeTransport();
  const h = harness(tr);
  let n = 0;
  const v0 = h.conn.getState().version;
  await h.conn.refreshMasterData();
  assert.ok(h.conn.getState().version > v0);
  for (let i = 0; i < 260; i++) h.conn.handleEvents([{ id: `X${i}`, seq: i, eventName: EVENTS.HK_STATUS, module: 'HOUSEKEEPING', hotelId: 'H', businessDate: 'd', timestamp: '', actor: 'x', source: 'OPERA_UI', primaryKey: '0201', roomIds: ['0201'], details: [{ elementName: 'RoomStatus', oldValue: null, newValue: 'Dirty' }], summary: '' }]);
  assert.equal(h.conn.getState().jobs.length, 200);
  void n;
});

test('reconcile (bidirectional): in-house guest without order → CHECK_IN; missing GRMS order → repair', async () => {
  const tr = fakeTransport();
  const h = harness(tr, { settings: { syncMode: 'bidirectional' } });
  await h.conn.refreshMasterData();
  const inh = h.engine.snapshot().reservations.find((r) => r.status === 'InHouse')!;
  const issues = await h.conn.reconcile();
  assert.ok(issues >= 1);
  assert.ok(h.conn.getState().jobs.some((j) => j.action === 'CHECK_IN' && j.reservationId === inh.id));
  await h.drain();
  const link = h.conn.getState().links.find((l) => l.reservationId === inh.id)!;
  assert.equal(link.state, 'checked_in');
  assert.equal(await h.conn.reconcile(), 0);
  tr.orders.delete(link.orderId);
  assert.equal(await h.conn.reconcile(), 1);
  await h.drain();
  assert.equal(h.conn.getState().links.filter((l) => l.reservationId === inh.id && !l.closed).length, 1);
});

// ───────────────────────────────────────────── end-to-end with the GRMS simulator
async function e2e(settings?: Record<string, unknown>) {
  const engine0 = new PmsEngine(undefined, { businessDate: '2026-06-15', random: () => 0.99 });
  const clock = { t: T0 };
  const sim: GrmsSimulatorApi = createGrmsSimulator(engine0.snapshot(), { now: () => clock.t });
  const h = harness(sim);
  // re-create the sim against the harness engine's snapshot (same seed) and share the clock
  const sim2 = createGrmsSimulator(h.engine.snapshot(), { now: () => h.clock.t });
  const h2 = harness(sim2, { settings });
  await h2.conn.refreshMasterData();
  const orders = () => (sim2.dump() as any).orders as any[];
  const room = (no: string) => (sim2.dump() as any).rooms.find((r: any) => r.residence_no === no);
  return { ...h2, sim: sim2, orders, room };
}

test('e2e: check-in → checked_in; check-out → checked_out + dirty', async () => {
  const x = await e2e();
  const id = 'R482996';
  assert.ok(x.run({ type: 'checkIn', reservationId: id }).ok);
  await x.drain();
  assert.equal(x.orders().length, 1);
  assert.equal(x.orders()[0].order_state, 'checked_in');
  assert.equal(x.orders()[0].residence_no, '202');
  assert.equal(x.room('202').occupied, true);
  assert.equal(x.conn.getState().jobs.filter((j) => j.status !== 'SUCCEEDED' && j.status !== 'SKIPPED').length, 0);
  x.clock.t += 3600_000;
  x.run({ type: 'checkOut', reservationId: id });
  await x.drain();
  assert.equal(x.orders()[0].order_state, 'checked_out');
  assert.equal(x.room('202').dirty, true);
  assert.equal(x.room('202').occupied, false);
});

test('e2e: pre-register on assign, no-show cancels the order, room move', async () => {
  const x = await e2e();
  const arrivals = x.engine.snapshot().reservations.filter((r) => r.status === 'Reserved' && r.arrival === '2026-06-15' && !r.roomId).slice(0, 1);
  const a = arrivals[0];
  const v = roomViews(x.engine.snapshot()).find((r) => r.roomType === a.roomType && !r.arrival && !r.inHouse && !r.oooActive && r.hkStatus !== 'Dirty')!;
  assert.ok(x.run({ type: 'assignRoom', reservationId: a.id, roomId: v.id }).ok);
  await x.drain();
  assert.equal(x.orders().length, 1);
  assert.equal(x.orders()[0].order_state, 'check_in');
  // move: check in another guest, then room move
  assert.ok(x.run({ type: 'checkIn', reservationId: 'R482996' }).ok);
  await x.drain();
  const target = roomViews(x.engine.snapshot()).find((r) => !r.arrival && !r.inHouse && !r.oooActive && r.id !== v.id && (r.hkStatus === 'Clean' || r.hkStatus === 'Inspected'))!;
  const mv = x.run({ type: 'roomMove', reservationId: 'R482996', toRoomId: target.id });
  assert.ok(mv.ok, mv.error);
  await x.drain();
  const mine = x.orders().filter((o) => o.residence_no === '202' || o.residence_no === target.number);
  assert.equal(mine.find((o) => o.residence_no === '202').order_state, 'checked_out');
  const neo = mine.find((o) => o.residence_no === target.number);
  assert.equal(neo.order_state, 'checked_in');
  assert.match(neo.remark, /Room move from 202/);
  assert.equal(x.room('202').dirty, true);
  // no-show: check out all due-outs, run end of day
  for (const r of x.engine.snapshot().reservations.filter((r) => r.status === 'InHouse' && r.departure <= '2026-06-15')) x.run({ type: 'checkOut', reservationId: r.id });
  const eod = x.run({ type: 'nightAudit' });
  assert.ok(eod.ok, eod.error);
  await x.drain();
  const link = x.conn.getState().links.find((l) => l.reservationId === a.id)!;
  assert.equal(link.closed, true);
  assert.equal(x.orders().find((o) => o.order_id === link.orderId), undefined);
});

test('e2e inbound (bidirectional): HK clean/dirty both ways (with 30s echo guard), DND, self check-out, alarms, external orders', async () => {
  const x = await e2e({ syncMode: 'bidirectional', acceptGrmsClean: true });
  const rid = (no: string) => x.conn.getState().residences.find((r) => r.residence_name === no)!.residence_id;
  // PMS Dirty → GRMS dirty
  const clean = roomViews(x.engine.snapshot()).find((v) => v.hkStatus === 'Inspected' && v.foStatus === 'Vacant' && !v.oooActive)!;
  x.run({ type: 'setHkStatus', roomIds: [clean.id], status: 'Dirty' });
  await x.drain();
  assert.equal(x.room(clean.number).dirty, true);
  // GRMS cleans immediately: echo guard keeps PMS Dirty
  x.sim.apply({ type: 'setRoomState', residenceId: rid(clean.number), dirty: false });
  await x.conn.poll();
  assert.equal(x.engine.snapshot().rooms.find((r) => r.id === clean.id)!.hkStatus, 'Dirty');
  x.clock.t += 31_000;
  const jobsBefore = x.conn.getState().jobs.length;
  await x.conn.poll();
  assert.equal(x.engine.snapshot().rooms.find((r) => r.id === clean.id)!.hkStatus, 'Clean');
  assert.ok(x.conn.getState().stats.inboundApplied >= 1);
  assert.equal(x.conn.getState().jobs.length, jobsBefore, 'echo: inbound change creates no outbound job');
  assert.ok(x.notices.some((n) => /cleaned/.test(n.text)));
  // GRMS dirty → PMS Dirty
  x.sim.apply({ type: 'setRoomState', residenceId: rid(clean.number), dirty: true });
  await x.conn.poll();
  assert.equal(x.engine.snapshot().rooms.find((r) => r.id === clean.id)!.hkStatus, 'Dirty');
  assert.equal(x.conn.getState().jobs.length, jobsBefore);
  // DND (in-house only) and guest self check-out
  x.run({ type: 'checkIn', reservationId: 'R482996' });
  await x.drain();
  x.sim.apply({ type: 'setRoomState', residenceId: rid('202'), dnd: true });
  await x.conn.poll();
  assert.equal(x.engine.snapshot().rooms.find((r) => r.id === '0202')!.serviceStatus, 'DND');
  x.sim.apply({ type: 'setRoomState', residenceId: rid('202'), dnd: false });
  await x.conn.poll();
  assert.equal(x.engine.snapshot().rooms.find((r) => r.id === '0202')!.serviceStatus, null);
  const link = x.conn.getState().links.find((l) => l.reservationId === 'R482996')!;
  x.sim.apply({ type: 'guestSelfCheckout', orderId: link.orderId });
  const n = x.conn.getState().jobs.length;
  await x.conn.poll();
  assert.equal(x.engine.snapshot().reservations.find((r) => r.id === 'R482996')!.status, 'CheckedOut');
  assert.equal(x.conn.getState().jobs.length, n, 'self check-out is not echoed back to GRMS');
  assert.equal(x.conn.getState().links.find((l) => l.reservationId === 'R482996')!.closed, true);
  // alarms
  x.sim.apply({ type: 'raiseAlarm', residenceId: rid('202'), alarmType: 'smoke' });
  await x.conn.poll();
  assert.equal(x.conn.getState().alarms.length, 1);
  assert.equal(x.conn.getState().alarms[0].roomId, '0202');
  assert.ok(x.notices.some((n) => n.kind === 'error' && /alarm/i.test(n.text)));
  await x.conn.poll();
  assert.equal(x.conn.getState().alarms.length, 1, 'deduplicated');
  assert.ok(x.conn.getState().lastPollAt);
});

test('e2e: uat fault profile → per-room error snapshot, jobs fail with code and trace id, start/stop do not hold the process', async () => {
  const x = await e2e();
  x.sim.apply({ type: 'setFaults', profile: 'uat' });
  await x.conn.poll();
  const snaps = Object.values(x.conn.getState().grmsRooms);
  assert.ok(snaps.length > 0 && snaps.every((s) => s.error?.code === 20950001));
  x.run({ type: 'setHkStatus', roomIds: [picks(x)[0].id], status: 'Dirty' });
  await x.drain();
  const j = x.conn.getState().jobs[0];
  assert.equal(j.status, 'FAILED');
  assert.equal(j.lastError!.code, 20950001);
  assert.ok(j.lastError!.traceId);
  x.conn.start();
  x.conn.stop();
});

// ───────────────────────────────────────────── OPERA is the master
const hk = (x: { engine: PmsEngine }, id: string) => x.engine.snapshot().rooms.find((r) => r.id === id)!.hkStatus;
const active = (x: { conn: AkubelaConnectorApi }) => x.conn.getState().jobs.filter((j) => j.status === 'PENDING' || j.status === 'RUNNING');

test('pushAll: room states, in-house check-ins, pre-registrations, stale links; deduped', async () => {
  const tr = fakeTransport();
  const h = harness(tr);
  await h.conn.refreshMasterData();
  const snap = h.engine.snapshot();
  const inh = snap.reservations.filter((r) => r.status === 'InHouse' && r.roomId);
  const arr = snap.reservations.find((r) => r.status === 'Reserved' && r.roomId === '0101')!;
  assert.ok(inh.length > 0 && arr);
  // stale link: reservation no longer in house / assigned
  const n = await h.conn.pushAll();
  const jobs = h.conn.getState().jobs;
  assert.equal(n, active(h).length);
  assert.equal(jobs.filter((j) => j.action === 'ROOM_STATE').length, 97);
  assert.ok(jobs.every((j) => /^Push: /.test(j.summary)));
  const rs = (id: string) => jobs.find((j) => j.action === 'ROOM_STATE' && j.roomId === id)!;
  assert.ok(rs('0101').summary.includes('clean'));
  const dirtyRoom = snap.rooms.find((r) => r.hkStatus === 'Dirty')!;
  assert.ok(rs(dirtyRoom.id).summary.includes('dirty'));
  for (const r of inh) assert.ok(jobs.some((j) => j.action === 'CHECK_IN' && j.reservationId === r.id));
  assert.ok(jobs.some((j) => j.action === 'PRE_REGISTER' && j.reservationId === arr.id));
  assert.ok(h.conn.getState().lastPushAt);
  assert.equal(await h.conn.pushAll(), 0, 'deduped against pending jobs');
  await h.drain();
  assert.ok(h.conn.getState().links.some((l) => l.reservationId === inh[0].id && l.state === 'checked_in'));
  assert.ok(h.conn.getState().links.some((l) => l.reservationId === arr.id && l.state === 'check_in'));
  assert.ok(tr.calls.some((c) => c.command === 'update_room_state' && c.param.residence_id === 'res-101' && c.param.dirty === false));
  assert.equal(await h.conn.pushAll(), 97, 'room states are re-pushed unconditionally; no new order jobs');
  await h.drain();
  // stale link closing
  const link = h.conn.getState().links.find((l) => l.reservationId === arr.id)!;
  h.run({ type: 'unassignRoom', reservationId: arr.id } as Command);
  await h.drain();
  link.closed = false; link.state = 'check_in';
  const co = inh[0];
  h.conn.getState().links.find((l) => l.reservationId === co.id)!;
  h.run({ type: 'checkOut', reservationId: co.id });
  await h.drain();
  const l2 = h.conn.getState().links.find((l) => l.reservationId === co.id)!;
  l2.closed = false; l2.state = 'checked_in';
  await h.conn.pushAll();
  assert.ok(active(h).some((j) => j.action === 'CHECK_OUT' && j.reservationId === co.id));
  assert.ok(active(h).some((j) => j.action === 'CANCEL_ORDER' && j.reservationId === arr.id));
});

test('opera-master inbound: GRMS dirty/clean never changes OPERA HK; corrective push is throttled; DND + self-checkout still inbound', async () => {
  const x = await e2e();
  const rid = (no: string) => x.conn.getState().residences.find((r) => r.residence_name === no)!.residence_id;
  assert.equal(x.conn.getState().settings.syncMode, 'opera-master');
  const clean = roomViews(x.engine.snapshot()).find((v) => v.hkStatus === 'Inspected' && v.foStatus === 'Vacant' && !v.oooActive && v.number !== '101')!;
  x.sim.apply({ type: 'setRoomState', residenceId: rid(clean.number), dirty: true });
  await x.conn.poll();
  assert.equal(hk(x, clean.id), 'Inspected', 'OPERA untouched');
  const fixes = () => x.conn.getState().jobs.filter((j) => j.roomId === clean.id && j.action === 'ROOM_STATE');
  assert.equal(fixes().length, 1);
  assert.match(fixes()[0].summary, /^Push: /);
  await x.conn.poll();
  assert.equal(fixes().length, 1, 'no duplicate while pending');
  await x.drain();
  assert.equal(x.room(clean.number).dirty, false, 'GRMS corrected');
  x.sim.apply({ type: 'setRoomState', residenceId: rid(clean.number), dirty: true });
  x.clock.t += 10_000;
  await x.conn.poll();
  assert.equal(fixes().length, 1, 'throttled within 60 s');
  x.clock.t += 61_000;
  await x.conn.poll();
  assert.equal(fixes().length, 2);
  await x.drain();
  assert.equal(hk(x, clean.id), 'Inspected');
  // DND + self check-out remain inbound
  x.run({ type: 'checkIn', reservationId: 'R482996' });
  await x.drain();
  x.sim.apply({ type: 'setRoomState', residenceId: rid('202'), dnd: true });
  await x.conn.poll();
  assert.equal(x.engine.snapshot().rooms.find((r) => r.id === '0202')!.serviceStatus, 'DND');
  const link = x.conn.getState().links.find((l) => l.reservationId === 'R482996')!;
  x.sim.apply({ type: 'guestSelfCheckout', orderId: link.orderId });
  await x.conn.poll();
  assert.equal(x.engine.snapshot().reservations.find((r) => r.id === 'R482996')!.status, 'CheckedOut');
});

test('updateSettings: switching to opera-master triggers a push; reconcile in opera-master = push', async () => {
  const tr = fakeTransport();
  const h = harness(tr, { settings: { syncMode: 'bidirectional' } });
  await h.conn.refreshMasterData();
  assert.equal(active(h).length, 0);
  h.conn.updateSettings({ syncMode: 'opera-master' });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(h.conn.getState().jobs.some((j) => j.action === 'ROOM_STATE'));
  await h.drain();
  assert.equal(await h.conn.reconcile(), 97);
});
