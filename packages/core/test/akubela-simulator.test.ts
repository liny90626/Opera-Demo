import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, createGrmsSimulator, GrmsError, SIM_ERROR_CODES as E } from '../src/index.ts';
import type { GrmsDevice, GrmsRoomInfo } from '../src/index.ts';

const pms = createInitialState();
const T0 = Date.UTC(2026, 5, 15, 10, 0, 0);
const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const HOUR = 3600_000;

function make(opts: Parameters<typeof createGrmsSimulator>[1] = {}) {
  let t = T0;
  const sim = createGrmsSimulator(pms, { now: () => t, ...opts });
  const call = <T = any>(c: string, p: Record<string, unknown> = {}) => sim.call<T>(c, p);
  return { sim, call, advance: (ms: number) => (t += ms), clock: () => t };
}
type Ctx = ReturnType<typeof make>;

async function rejects(p: Promise<unknown>, code: number, msg?: RegExp) {
  await assert.rejects(p, (e: any) => {
    assert.ok(e instanceof GrmsError, 'GrmsError expected');
    assert.equal(e.code, code, e.message);
    assert.match(e.traceId ?? '', /^[0-9a-f]{32}$/);
    if (msg) assert.match(e.message, msg);
    return true;
  });
}

const guest = { guest_name: 'Ann Lee', email: 'ann@x.io', phone: '123', id_card: 'N/A', passport: 'N/A' };
async function rooms(c: Ctx) {
  const tree = await c.call('get_room_list');
  return tree[0].floors.flatMap((f: any) => f.residences) as { residence_id: string; residence_name: string }[];
}
async function residence(c: Ctx, no = '201') {
  return (await rooms(c)).find((r) => r.residence_name === no)!.residence_id;
}
function orderParam(rid: string, over: Record<string, unknown> = {}) {
  return { residence_id: rid, start_time: fmt(T0 + HOUR), finish_time: fmt(T0 + 24 * HOUR), source: 'OPERA', remark: 'OPERA #1', enable_booking: false, guest, ...over };
}
const updParam = (order_id: string, state: string, over: Record<string, unknown> = {}) => ({
  order_id, start_time: fmt(T0 + HOUR), finish_time: fmt(T0 + 24 * HOUR), order_state: state, source: 'OPERA', remark: 'r', enable_booking: false, ...over,
});
async function newOrder(c: Ctx, no = '201', over: Record<string, unknown> = {}) {
  const rid = await residence(c, no);
  const r = await c.call('create_order_info', orderParam(rid, over));
  return { rid, ...r } as { rid: string; order_id: string; order_number: string; guest_id: string };
}
const info = (c: Ctx, rid: string) => c.call<GrmsRoomInfo>('get_room_info', { residence_id: rid });

test('room list mirrors OPERA rooms; deterministic ids', async () => {
  const a = make(), b = make();
  const list = await rooms(a);
  assert.equal(list.length, pms.rooms.length);
  const tree = await a.call('get_room_list');
  assert.equal(tree.length, 1);
  assert.equal(tree[0].building_name, 'b1');
  const f2 = tree[0].floors.find((f: any) => f.floor_name === '2');
  assert.ok(f2.residences.some((r: any) => r.residence_name === '201'));
  for (const r of list) assert.match(r.residence_id, /^r[0-9a-f]{32}$/);
  assert.deepEqual(list, await rooms(b));
  assert.equal(new Set(list.map((r) => r.residence_id)).size, list.length);
});

test('get_room_info: shape, dirty mirrors hkStatus, types mirror OPERA', async () => {
  const c = make();
  const dirtyRoom = pms.rooms.find((r) => r.hkStatus === 'Dirty')!;
  const cleanRoom = pms.rooms.find((r) => r.hkStatus === 'Clean')!;
  const d = await info(c, await residence(c, dirtyRoom.number));
  assert.equal(d.dirty, true);
  assert.equal(d.occupied, false);
  assert.equal(d.dnd, false);
  assert.equal(d.order_id, '');
  assert.equal(d.residence_no, dirtyRoom.number);
  assert.equal(d.floor_name, String(dirtyRoom.floor));
  assert.equal(d.room_type_name, pms.roomTypes.find((t) => t.code === dirtyRoom.roomType)!.name);
  assert.deepEqual(Object.keys(d).sort(), ['building_id', 'building_name', 'dirty', 'dnd', 'floor_id', 'floor_name', 'occupied', 'order_id', 'residence_no', 'room_tag_id', 'room_tag_name', 'room_type_id', 'room_type_name'].sort());
  assert.equal((await info(c, await residence(c, cleanRoom.number))).dirty, false);
  const types = await c.call('get_room_type_list', { page_size: 50, page_index: 1 });
  assert.deepEqual(types.map((t: any) => t.room_type_name), pms.roomTypes.map((t) => t.name));
  assert.ok(types.every((t: any) => /^t[0-9a-f]{32}$/.test(t.room_type_id) && t.bed >= 1 && t.occupancy >= 1));
});

test('validation: required fields must be present and non-empty strings', async () => {
  const c = make();
  const rid = await residence(c);
  await rejects(c.call('get_room_info', {}), 50104080, /bind body/);
  await rejects(c.call('get_room_info', { residence_id: '' }), 50104080);
  await rejects(c.call('get_room_info', { residence_id: 5 }), 50104080);
  await rejects(c.call('update_room_state', { residence_id: rid }), 50104080);
  await rejects(c.call('update_room_state', { residence_id: rid, dirty: 'true' }), 50104080);
  for (const k of ['residence_id', 'start_time', 'finish_time', 'source', 'remark']) {
    await rejects(c.call('create_order_info', orderParam(rid, { [k]: '' })), 50104080);
    const p: any = orderParam(rid);
    delete p[k];
    await rejects(c.call('create_order_info', p), 50104080);
  }
  await rejects(c.call('create_order_info', orderParam(rid, { enable_booking: undefined })), 50104080);
  for (const k of Object.keys(guest)) await rejects(c.call('create_order_info', orderParam(rid, { guest: { ...guest, [k]: '' } })), 50104080);
  await rejects(c.call('create_order_info', orderParam(rid, { guest: undefined })), 50104080);
  await rejects(c.call('get_order_info', { order_id: '' }), 50104080);
  await rejects(c.call('get_order_list', {}), 50104080);
  await rejects(c.call('get_order_list', { page_size: 0, page_index: 1 }), 50104080);
  await rejects(c.call('get_order_list', { page_size: 10, page_index: '1' }), 50104080);
  await rejects(c.call('control_device', { device_id: 'x', ability_id: '', control: 'turn_on' }), 50104080);
  await rejects(c.call('manual_trigger_scene', { scene_id: 's', residences: [] }), 50104080);
  await rejects(c.call('manual_trigger_scene', { scene_id: 's', residences: [{ residence_id: '' }] }), 50104080);
  await rejects(c.call('create_guest_info', { ...guest, order_id: 'o', passport: '' }), 50104080);
  await rejects(c.call('nope_command', {}), 50104080);
});

test('create_order_info: time rules, unknown residence, result shape', async () => {
  const c = make();
  const rid = await residence(c);
  await rejects(c.call('create_order_info', orderParam(rid, { start_time: fmt(T0 - 1000) })), 50105580, /cannot be earlier than now/);
  await rejects(c.call('create_order_info', orderParam(rid, { start_time: '2026/06/15 11:00:00' })), 50104080);
  await rejects(c.call('create_order_info', orderParam(rid, { start_time: '2026-13-45 11:00:00' })), 50104080);
  await rejects(c.call('create_order_info', orderParam(rid, { finish_time: fmt(T0 + HOUR) })), E.FINISH_BEFORE_START);
  await rejects(c.call('create_order_info', orderParam(rid, { finish_time: fmt(T0) })), E.FINISH_BEFORE_START);
  await rejects(c.call('create_order_info', orderParam('r' + '0'.repeat(32))), 20017608, /residence id exists/);
  // start == now (second granularity) is allowed
  const ok = await c.call('create_order_info', orderParam(rid, { start_time: fmt(T0) }));
  assert.match(ok.order_id, /^o[0-9a-f]{32}$/);
  assert.match(ok.order_number, /^\d{20}$/);
  assert.match(ok.guest_id, /^g[0-9a-f]{32}$/);
  assert.deepEqual(Object.keys(ok).sort(), ['guest_id', 'order_id', 'order_number']);
  assert.ok(ok.order_number.startsWith('20260615100000'));
  const two = await c.call('create_order_info', orderParam(rid));
  assert.notEqual(two.order_number, ok.order_number);
});

test('get_order_info / get_order_list shapes and unknown order', async () => {
  const c = make();
  const { order_id, order_number, rid, guest_id } = await newOrder(c);
  const o = await c.call('get_order_info', { order_id });
  assert.deepEqual(o, {
    order_number, residence_id: rid, residence_no: '201', room_type_id: o.room_type_id, room_type_name: 'Superior King',
    start_time: fmt(T0 + HOUR), finish_time: fmt(T0 + 24 * HOUR), order_state: 'check_in', source: 'OPERA', remark: 'OPERA #1', enable_booking: false,
    guests: [{ guest_id, ...guest }],
  });
  const list = await c.call('get_order_list', { page_size: 10, page_index: 1 });
  assert.equal(list.length, 1);
  assert.equal(list[0].order_id, order_id);
  assert.equal(list[0].order_state, 'check_in');
  assert.equal(list[0].guests[0].guest_name, 'Ann Lee');
  await rejects(c.call('get_order_info', { order_id: 'o' + '1'.repeat(32) }), 20017008, /order id exists/);
});

test('pagination: page_size / page_index (1-based), newest first', async () => {
  const c = make();
  const ids: string[] = [];
  for (const no of ['201', '202', '203', '204', '205']) ids.push((await newOrder(c, no)).order_id);
  const p1 = await c.call('get_order_list', { page_size: 2, page_index: 1 });
  const p2 = await c.call('get_order_list', { page_size: 2, page_index: 2 });
  const p3 = await c.call('get_order_list', { page_size: 2, page_index: 3 });
  const p4 = await c.call('get_order_list', { page_size: 2, page_index: 4 });
  assert.deepEqual([p1.length, p2.length, p3.length, p4.length], [2, 2, 1, 0]);
  assert.deepEqual([...p1, ...p2, ...p3].map((o: any) => o.order_id).sort(), [...ids].sort());
  assert.equal((await c.call('get_guest_list', { page_size: 3, page_index: 1 })).length, 3);
  assert.equal((await c.call('get_guest_list', { page_size: 3, page_index: 2 })).length, 2);
  assert.equal((await c.call('get_room_type_list', { page_size: 2, page_index: 3 })).length, 1);
});

test('order lifecycle: check_in -> checked_in -> checked_out with room side effects', async () => {
  const c = make();
  const { rid, order_id } = await newOrder(c, '202');
  assert.equal((await info(c, rid)).occupied, false);
  await c.call('update_room_state', { residence_id: rid, dirty: false });

  await c.call('update_order_info', updParam(order_id, 'checked_in'));
  let r = await info(c, rid);
  assert.equal(r.occupied, true);
  assert.equal(r.order_id, order_id);
  assert.equal(r.dirty, false);
  assert.equal((await c.call('get_order_info', { order_id })).order_state, 'checked_in');

  // same-state update allowed (e.g. edit remark)
  await c.call('update_order_info', updParam(order_id, 'checked_in', { remark: 'changed', start_time: fmt(T0 - HOUR) }));
  assert.equal((await c.call('get_order_info', { order_id })).remark, 'changed');

  // cannot go back / delete once in house
  await rejects(c.call('update_order_info', updParam(order_id, 'check_in')), E.ORDER_STATE_TRANSITION);
  await rejects(c.call('delete_order_info', { order_id }), E.ORDER_DELETE_STATE);

  c.advance(2 * HOUR);
  await c.call('update_order_info', updParam(order_id, 'checked_out', { finish_time: fmt(c.clock()), start_time: fmt(T0 - HOUR) }));
  r = await info(c, rid);
  assert.equal(r.occupied, false);
  assert.equal(r.dirty, true);
  assert.equal(r.order_id, '');
  const o = await c.call('get_order_info', { order_id });
  assert.equal(o.order_state, 'checked_out');
  assert.equal(o.finish_time, fmt(c.clock()));

  await rejects(c.call('update_order_info', updParam(order_id, 'checked_in')), E.ORDER_STATE_TRANSITION);
  await rejects(c.call('delete_order_info', { order_id }), E.ORDER_DELETE_STATE);
  // update again as checked_out is a no-op transition
  await c.call('update_order_info', updParam(order_id, 'checked_out', { start_time: fmt(T0 - HOUR) }));
});

test('order state transitions: check_in cannot jump to checked_out', async () => {
  const c = make();
  const { order_id } = await newOrder(c);
  await rejects(c.call('update_order_info', updParam(order_id, 'checked_out')), E.ORDER_STATE_TRANSITION);
  await c.call('update_order_info', updParam(order_id, 'check_in', { remark: 'same state ok' }));
  await rejects(c.call('update_order_info', updParam(order_id, 'weird')), 50104080);
});

test('update_order_info: requires all fields, valid times, existing order, pending start >= now', async () => {
  const c = make();
  const { order_id } = await newOrder(c);
  for (const k of ['order_id', 'start_time', 'finish_time', 'order_state', 'source', 'remark']) {
    await rejects(c.call('update_order_info', updParam(order_id, 'checked_in', { [k]: '' })), 50104080);
    const p: any = updParam(order_id, 'checked_in');
    delete p[k];
    await rejects(c.call('update_order_info', p), 50104080);
  }
  const p: any = updParam(order_id, 'checked_in');
  delete p.enable_booking;
  await rejects(c.call('update_order_info', p), 50104080);
  await rejects(c.call('update_order_info', updParam(order_id, 'checked_in', { start_time: 'soon' })), 50104080);
  await rejects(c.call('update_order_info', updParam('o' + '2'.repeat(32), 'checked_in')), 20017008);
  await rejects(c.call('update_order_info', updParam(order_id, 'checked_in', { start_time: fmt(T0 - 5000) })), 50105580);
  await rejects(c.call('update_order_info', updParam(order_id, 'checked_in', { finish_time: fmt(T0) })), E.FINISH_BEFORE_START);
});

test('check-in is refused when the room is already occupied by another order; room move works', async () => {
  const c = make();
  const a = await newOrder(c, '203');
  const b = await newOrder(c, '203');
  await c.call('update_order_info', updParam(a.order_id, 'checked_in'));
  await rejects(c.call('update_order_info', updParam(b.order_id, 'checked_in')), E.RESIDENCE_OCCUPIED);
  await c.call('update_order_info', updParam(a.order_id, 'checked_out', { start_time: fmt(T0 - HOUR) }));
  await c.call('update_order_info', updParam(b.order_id, 'checked_in'));
  assert.equal((await info(c, a.rid)).order_id, b.order_id);
});

test('delete_order_info: only pending orders, removes guests', async () => {
  const c = make();
  const { order_id, guest_id } = await newOrder(c);
  assert.equal((await c.call('get_guest_list', { page_size: 10, page_index: 1 })).some((g: any) => g.guest_id === guest_id), true);
  await c.call('delete_order_info', { order_id });
  await rejects(c.call('get_order_info', { order_id }), 20017008);
  await rejects(c.call('delete_order_info', { order_id }), 20017008);
  assert.equal((await c.call('get_guest_list', { page_size: 10, page_index: 1 })).length, 0);
});

test('update_room_state sets dirty; unknown residence', async () => {
  const c = make();
  const rid = await residence(c, '202'); // clean
  assert.equal((await info(c, rid)).dirty, false);
  assert.deepEqual(await c.call('update_room_state', { residence_id: rid, dirty: true }), {});
  assert.equal((await info(c, rid)).dirty, true);
  await c.call('update_room_state', { residence_id: rid, dirty: false });
  assert.equal((await info(c, rid)).dirty, false);
  await rejects(c.call('update_room_state', { residence_id: 'rzzz', dirty: true }), 20017608);
  await rejects(c.call('get_room_info', { residence_id: 'rzzz' }), 20017608, /residence id exists/);
});

test('guests: create_guest_info adds a guest to an order', async () => {
  const c = make();
  const { order_id } = await newOrder(c);
  const g = await c.call('create_guest_info', { ...guest, guest_name: 'Bob', order_id });
  assert.match(g.guest_id, /^g[0-9a-f]{32}$/);
  const o = await c.call('get_order_info', { order_id });
  assert.deepEqual(o.guests.map((x: any) => x.guest_name), ['Ann Lee', 'Bob']);
  await rejects(c.call('create_guest_info', { ...guest, order_id: 'onone' }), 20017008);
  const list = await c.call('get_guest_list', { page_size: 10, page_index: 1 });
  assert.equal(list.length, 2);
  assert.equal(list[0].guest_name, 'Bob');
});

test('authorization records: create / list / delete + validation', async () => {
  const c = make();
  const { rid, guest_id } = await newOrder(c);
  const base = { access_type: 'password', pin_code: '123456', rf_card_number: 'x', guest_id, residence_id: rid, start_time: fmt(T0), finish_time: fmt(T0 + 24 * HOUR) };
  const rec = await c.call('create_authorization_record_info', { ...base, rf_card_number: '' });
  assert.match(rec.record_id, /^u[0-9a-f]{32}$/);
  assert.match(rec.authorization_number, /^\d{20}$/);
  assert.equal(rec.qr_code_url, '');
  const list = await c.call('get_authorization_record_list', { page_size: 5, page_index: 1 });
  assert.equal(list.length, 1);
  assert.equal(list[0].record_id, rec.record_id);
  assert.equal(list[0].residence_no, '201');
  assert.equal(list[0].guest_name, 'Ann Lee');
  assert.equal(list[0].authorization_status, 'effective');
  assert.equal(JSON.stringify(list).includes('123456'), false, 'pin code is never returned');
  c.advance(48 * HOUR);
  assert.equal((await c.call('get_authorization_record_list', { page_size: 5, page_index: 1 }))[0].authorization_status, 'expired');

  await rejects(c.call('create_authorization_record_info', { ...base, access_type: 'fax' }), 50104080);
  await rejects(c.call('create_authorization_record_info', { ...base, guest_id: '' }), 50104080);
  await rejects(c.call('create_authorization_record_info', { ...base, pin_code: 'abc' }), 50104080);
  await rejects(c.call('create_authorization_record_info', { ...base, access_type: 'rf_card', rf_card_number: '' }), 50104080);
  await rejects(c.call('create_authorization_record_info', { ...base, residence_id: 'rnone' }), 20017608);
  await rejects(c.call('create_authorization_record_info', { ...base, guest_id: 'gnone' }), E.GUEST_NOT_FOUND);
  await rejects(c.call('create_authorization_record_info', { ...base, finish_time: base.start_time }), E.FINISH_BEFORE_START);
  // auto-generated pin
  const auto = await c.call('create_authorization_record_info', { ...base, pin_code: undefined, start_time: fmt(c.clock()), finish_time: fmt(c.clock() + HOUR) });
  assert.match((c.sim.dump() as any).authRecords.find((a: any) => a.record_id === auto.record_id).pin_code, /^\d{6}$/);

  await c.call('delete_authorization_record_info', { record_id: rec.record_id });
  assert.equal((await c.call('get_authorization_record_list', { page_size: 5, page_index: 1 })).length, 1);
  await rejects(c.call('delete_authorization_record_info', { record_id: rec.record_id }), E.AUTH_RECORD_NOT_FOUND);
  await rejects(c.call('delete_authorization_record_info', { record_id: '' }), 50104080);
});

// ─────────────────────────────────────────────── devices
const flat = (d: GrmsDevice[]): GrmsDevice[] => d.flatMap((x) => [x, ...flat(x.sub_devices)]);
async function devs(c: Ctx, no = '201') {
  const rid = await residence(c, no);
  const list = await c.call<GrmsDevice[]>('get_device_list', { page_size: 20, page_index: 1, residence_id: rid, show_ability: true });
  return { rid, list, all: flat(list) };
}
const ability = (all: GrmsDevice[], type: string) => {
  const d = all.find((x) => x.abilities.some((a) => a.ability_type === type))!;
  return { d, a: d.abilities.find((a) => a.ability_type === type)! };
};

test('get_device_list: seeded tree modelled on UAT room 101', async () => {
  const c = make();
  const { list, all } = await devs(c);
  assert.equal(list.length, 1);
  const panel = list[0];
  assert.equal(panel.product_name, 'HyPanel Elite 10');
  assert.equal(panel.device_type, 'PH59');
  assert.equal(panel.parent_device_id, '');
  assert.deepEqual(panel.sub_devices.map((s) => s.device_name), ['HyPanel Elite 10 201 - relay', 'IR Controller', 'Ceiling Light', 'Door Lock']);
  const relay = panel.sub_devices[0];
  assert.equal(relay.abilities[0].ability_type, 'switch');
  assert.equal(relay.abilities[0].ability_attribute, null);
  assert.equal(relay.parent_device_id, panel.device_id);
  const ir = panel.sub_devices[1];
  assert.deepEqual(ir.abilities.map((a) => a.attribute.type), ['temperature', 'humidity']);
  const ac = ir.sub_devices[0];
  assert.equal(ac.device_name, 'Midea AC');
  assert.equal(ac.parent_device_id, ir.device_id);
  assert.deepEqual(ac.abilities[0].attribute.support_hvac_mode, ['cool', 'heat', 'auto', 'fan_only', 'dry']);
  assert.equal(ac.abilities[0].state, 'off');
  assert.equal(ability(all, 'light').a.state, 'off');
  assert.equal(ability(all, 'lock').a.state, 'locked');
  assert.ok(all.every((d) => d.online));
  // deterministic and room specific
  const other = await devs(make(), '202');
  assert.notEqual(other.list[0].device_id, panel.device_id);
  assert.equal((await devs(make())).list[0].device_id, panel.device_id);
});

test('get_device_list: filters (show_ability, sub_device_type, parallel_sub_device, residence)', async () => {
  const c = make();
  const rid = await residence(c);
  const noAb = await c.call<GrmsDevice[]>('get_device_list', { page_size: 10, page_index: 1, residence_id: rid });
  assert.ok(flat(noAb).every((d) => d.abilities.length === 0));
  assert.equal(noAb[0].sub_devices.length, 4);
  const typed = await c.call<GrmsDevice[]>('get_device_list', { page_size: 10, page_index: 1, residence_id: rid, sub_device_type: ['Lock'] });
  assert.deepEqual(typed[0].sub_devices.map((s) => s.device_type), ['Lock']);
  const par = await c.call<GrmsDevice[]>('get_device_list', { page_size: 20, page_index: 1, residence_id: rid, parallel_sub_device: true, show_ability: true });
  assert.equal(par.length, 6); // panel, relay, IR, AC, light, lock
  assert.ok(par.every((d) => d.sub_devices.length === 0));
  const allRooms = await c.call<GrmsDevice[]>('get_device_list', { page_size: 1000, page_index: 1 });
  assert.equal(allRooms.length, pms.rooms.length);
  await rejects(c.call('get_device_list', { page_size: 10, page_index: 1, residence_id: 'rnone' }), 20017608);
  await rejects(c.call('get_device_list', { page_size: 10, page_index: 1, show_ability: 'yes' }), 50104080);
  const info1 = await c.call<GrmsDevice>('get_device_info', { device_id: noAb[0].device_id });
  assert.equal(info1.device_id, noAb[0].device_id);
  assert.equal(info1.abilities.length, 1);
  assert.equal(info1.sub_devices.length, 4);
  await rejects(c.call('get_device_info', { device_id: 'dnone' }), E.DEVICE_NOT_FOUND);
});

test('control_device: switch / light / climate / lock', async () => {
  const c = make();
  const { rid, all } = await devs(c);
  const state = async (type: string) => ability(flat(await c.call<GrmsDevice[]>('get_device_list', { page_size: 20, page_index: 1, residence_id: rid, show_ability: true })), type).a;
  const ctl = (type: string, control: string, attribute?: Record<string, unknown>) => {
    const { d, a } = ability(all, type);
    return c.call('control_device', { device_id: d.device_id, ability_id: a.ability_id, control, ...(attribute ? { attribute } : {}) });
  };
  // light
  assert.deepEqual(await ctl('light', 'turn_on', { brightness: 70 }), {});
  assert.deepEqual([(await state('light')).state, (await state('light')).attribute.brightness], ['on', 70]);
  await ctl('light', 'toggle');
  assert.equal((await state('light')).state, 'off');
  await ctl('light', 'toggle');
  assert.equal((await state('light')).state, 'on');
  await ctl('light', 'turn_off');
  assert.equal((await state('light')).state, 'off');
  assert.equal((await state('light')).attribute.brightness, 70);
  for (const bad of [101, -1, 50.5, '70']) await rejects(ctl('light', 'turn_on', { brightness: bad }), E.ATTRIBUTE_INVALID);
  await ctl('light', 'turn_on', { brightness: 0 });
  await ctl('light', 'turn_on', { brightness: 100 });
  await rejects(ctl('light', 'turn_on', { color: 'red' }), E.ATTRIBUTE_INVALID);
  await rejects(ctl('light', 'turn_off', { brightness: 10 }), E.ATTRIBUTE_INVALID);
  assert.equal((await state('light')).state, 'on', 'failed control leaves state untouched');
  // switch
  await ctl('switch', 'turn_on');
  assert.equal((await state('switch')).state, 'on');
  await rejects(ctl('switch', 'turn_on', { brightness: 5 }), E.ATTRIBUTE_INVALID);
  await rejects(ctl('switch', 'unlock'), E.CONTROL_UNSUPPORTED);
  // climate
  await ctl('climate', 'turn_on', { preset_temperature: 22, hvac_mode: 'heat', fan_mode: 'high', swing_mode: 'fix_1' });
  const ac = await state('climate');
  assert.equal(ac.state, 'on');
  assert.deepEqual([ac.attribute.preset_temperature, ac.attribute.hvac_mode, ac.attribute.fan_mode, ac.attribute.swing_mode], [22, 'heat', 'high', 'fix_1']);
  assert.deepEqual(ac.attribute.support_hvac_mode, ['cool', 'heat', 'auto', 'fan_only', 'dry']);
  for (const bad of [{ preset_temperature: 15 }, { preset_temperature: 31 }, { preset_temperature: 'hot' }, { hvac_mode: 'turbo' }, { fan_mode: 'max' }, { swing_mode: 'wild' }, { support_hvac_mode: ['cool'] }]) {
    await rejects(ctl('climate', 'turn_on', bad), E.ATTRIBUTE_INVALID);
  }
  await ctl('climate', 'turn_on', { preset_temperature: 16 });
  await ctl('climate', 'turn_on', { preset_temperature: 30 });
  await ctl('climate', 'turn_off');
  assert.equal((await state('climate')).state, 'off');
  // lock
  await ctl('lock', 'unlock');
  assert.equal((await state('lock')).state, 'unlocked');
  await ctl('lock', 'lock');
  assert.equal((await state('lock')).state, 'locked');
  await rejects(ctl('lock', 'turn_on'), E.CONTROL_UNSUPPORTED);
  // sensors are read-only
  await rejects(ctl('sensor', 'turn_on'), E.CONTROL_UNSUPPORTED);
  await rejects(ctl('binary_sensor', 'toggle'), E.CONTROL_UNSUPPORTED);
});

test('control_device: unknown device / ability, attribute type', async () => {
  const c = make();
  const { all } = await devs(c);
  const { d, a } = ability(all, 'light');
  await rejects(c.call('control_device', { device_id: 'dnone', ability_id: a.ability_id, control: 'turn_on' }), E.DEVICE_NOT_FOUND);
  await rejects(c.call('control_device', { device_id: d.device_id, ability_id: 'enone', control: 'turn_on' }), E.ABILITY_NOT_FOUND);
  // ability of another device
  const other = ability(all, 'lock');
  await rejects(c.call('control_device', { device_id: d.device_id, ability_id: other.a.ability_id, control: 'lock' }), E.ABILITY_NOT_FOUND);
  await rejects(c.call('control_device', { device_id: d.device_id, ability_id: a.ability_id, control: 'turn_on', attribute: [1] }), 50104080);
  // control state is per room
  const { all: all2 } = await devs(c, '202');
  assert.equal(ability(all2, 'light').a.state, 'off');
});

test('scenes: list, Welcome / Check-out Energy Saving / Sleep', async () => {
  const c = make();
  const scenes = await c.call('get_scene_list', { page_size: 10, page_index: 1 });
  assert.deepEqual(scenes.map((s: any) => s.scene_name), ['Welcome', 'Check-out Energy Saving', 'Sleep']);
  assert.ok(scenes.every((s: any) => /^s[0-9a-f]{32}$/.test(s.scene_id) && s.enable_auto === false));
  assert.equal((await c.call('get_scene_list', { page_size: 2, page_index: 2 })).length, 1);
  const id = (n: string) => scenes.find((s: any) => s.scene_name === n).scene_id;
  const a = await devs(c, '201'), b = await devs(c, '202');
  const st = async (no: string, type: string) => ability(flat(await c.call<GrmsDevice[]>('get_device_list', { page_size: 5, page_index: 1, residence_id: await residence(c, no), show_ability: true })), type).a;

  await c.call('manual_trigger_scene', { scene_id: id('Welcome'), residences: [{ residence_id: a.rid }] });
  assert.equal((await st('201', 'light')).state, 'on');
  assert.equal((await st('201', 'light')).attribute.brightness, 80);
  let ac = await st('201', 'climate');
  assert.deepEqual([ac.state, ac.attribute.hvac_mode, ac.attribute.preset_temperature], ['on', 'cool', 24]);
  assert.equal((await st('202', 'light')).state, 'off', 'other rooms untouched');

  await c.call('manual_trigger_scene', { scene_id: id('Sleep'), residences: [{ residence_id: a.rid }, { residence_id: b.rid }] });
  assert.equal((await st('201', 'light')).state, 'off');
  ac = await st('202', 'climate');
  assert.deepEqual([ac.state, ac.attribute.preset_temperature, ac.attribute.fan_mode], ['on', 26, 'low']);
  assert.equal((await st('202', 'lock')).state, 'locked');

  await c.call('manual_trigger_scene', { scene_id: id('Welcome'), residences: [{ residence_id: a.rid }] });
  const relay = ability(a.all, 'switch');
  await c.call('control_device', { device_id: relay.d.device_id, ability_id: relay.a.ability_id, control: 'turn_on' });
  await c.call('manual_trigger_scene', { scene_id: id('Check-out Energy Saving'), residences: [{ residence_id: a.rid }] });
  assert.equal((await st('201', 'light')).state, 'off');
  assert.equal((await st('201', 'climate')).state, 'off');
  assert.equal((await st('201', 'switch')).state, 'off');

  await rejects(c.call('manual_trigger_scene', { scene_id: 'snone', residences: [{ residence_id: a.rid }] }), E.SCENE_NOT_FOUND);
  await rejects(c.call('manual_trigger_scene', { scene_id: id('Welcome'), residences: [{ residence_id: 'rnone' }] }), 20017608);
});

test('get_project_info: timezone and live counters', async () => {
  const c = make();
  const p0 = await c.call('get_project_info');
  assert.equal(p0.timezone, 'Asia/Shanghai');
  assert.equal(p0.room.occupancy_rate_today, 0);
  assert.equal(p0.room.dirty, pms.rooms.filter((r) => r.hkStatus === 'Dirty' || r.hkStatus === 'Pickup').length);
  assert.equal(p0.device.total, pms.rooms.length * 6);
  const { order_id } = await newOrder(c);
  assert.equal((await c.call('get_project_info')).room.to_stay, 1);
  await c.call('update_order_info', updParam(order_id, 'checked_in'));
  const p1 = await c.call('get_project_info');
  assert.equal(p1.room.to_stay, 0);
  assert.equal(p1.room.checked_in_today, 1);
  assert.equal(p1.room.number_of_staying_today, 1);
  assert.equal(p1.room.vacant_today, pms.rooms.length - 1);
});

// ─────────────────────────────────────────────── sim controls
test('apply: setRoomState (dirty / dnd)', async () => {
  const c = make();
  const rid = await residence(c, '202');
  c.sim.apply({ type: 'setRoomState', residenceId: rid, dirty: true });
  let r = await info(c, rid);
  assert.deepEqual([r.dirty, r.dnd], [true, false]);
  c.sim.apply({ type: 'setRoomState', residenceId: rid, dnd: true });
  r = await info(c, rid);
  assert.deepEqual([r.dirty, r.dnd], [true, true]);
  c.sim.apply({ type: 'setRoomState', residenceId: rid, dirty: false, dnd: false });
  r = await info(c, rid);
  assert.deepEqual([r.dirty, r.dnd], [false, false]);
  assert.throws(() => c.sim.apply({ type: 'setRoomState', residenceId: 'rnone', dirty: true }), (e: any) => e instanceof GrmsError && e.code === 20017608);
  // dnd is not changed by regular commands
  await c.call('update_room_state', { residence_id: rid, dirty: true });
  c.sim.apply({ type: 'setRoomState', residenceId: rid, dnd: true });
  await c.call('update_room_state', { residence_id: rid, dirty: false });
  assert.equal((await info(c, rid)).dnd, true);
});

test('apply: guestSelfCheckout behaves like a check-out', async () => {
  const c = make();
  const { rid, order_id } = await newOrder(c, '204');
  assert.throws(() => c.sim.apply({ type: 'guestSelfCheckout', orderId: order_id }), (e: any) => e.code === E.ORDER_STATE_TRANSITION);
  await c.call('update_order_info', updParam(order_id, 'checked_in'));
  c.advance(3 * HOUR);
  c.sim.apply({ type: 'guestSelfCheckout', orderId: order_id });
  const r = await info(c, rid);
  assert.deepEqual([r.occupied, r.dirty, r.order_id], [false, true, '']);
  const o = await c.call('get_order_info', { order_id });
  assert.equal(o.order_state, 'checked_out');
  assert.equal(o.finish_time, fmt(c.clock()));
  assert.throws(() => c.sim.apply({ type: 'guestSelfCheckout', orderId: 'onone' }), (e: any) => e.code === 20017008);
});

test('apply: raiseAlarm adds records (newest first, paginated)', async () => {
  const c = make();
  const rid = await residence(c, '205');
  assert.deepEqual(await c.call('get_alarm_record_list', { page_size: 10, page_index: 1 }), []);
  c.sim.apply({ type: 'raiseAlarm', residenceId: rid, alarmType: 'smoke', message: 'Smoke in bathroom' });
  c.advance(60_000);
  c.sim.apply({ type: 'raiseAlarm', residenceId: rid, alarmType: 'sos' });
  c.sim.apply({ type: 'raiseAlarm', residenceId: rid, alarmType: 'low_power' });
  c.sim.apply({ type: 'raiseAlarm', residenceId: rid, alarmType: 'water_leak' });
  const list = await c.call('get_alarm_record_list', { page_size: 10, page_index: 1 });
  assert.deepEqual(list.map((a: any) => a.alarm_type), ['moist_alarm', 'low_power', 'sos_alarm', 'smoke_alarm']);
  assert.deepEqual(Object.keys(list[3]).sort(), ['alarm_time', 'alarm_type', 'residence_id']);
  assert.equal(list[3].alarm_time, fmt(T0));
  assert.equal(list[2].alarm_time, fmt(T0 + 60_000));
  assert.equal(list[0].residence_id, rid);
  assert.equal((await c.call('get_alarm_record_list', { page_size: 3, page_index: 2 })).length, 1);
  assert.equal((c.sim.dump() as any).alarms[0].message, 'Smoke in bathroom');
  assert.throws(() => c.sim.apply({ type: 'raiseAlarm', residenceId: 'rnone', alarmType: 'sos' }), (e: any) => e.code === 20017608);
});

test('faults profile "uat" reproduces platform failures; "none" restores', async () => {
  const c = make({ faults: 'uat' });
  const rid = await residence(c);
  const msg = (e: any) => e.message;
  await assert.rejects(info(c, rid), (e: any) => e.code === 20950001 && msg(e) === 'api room bind body' && /^[0-9a-f]{32}$/.test(e.traceId));
  await rejects(c.call('update_room_state', { residence_id: rid, dirty: true }), 20950001, /api room bind body/);
  await rejects(c.call('create_order_info', orderParam(rid)), 20950005, /api order bind body/);
  await rejects(c.call('get_project_info'), 24400347, /project timezone bind header/);
  await rejects(c.call('get_alarm_record_list', { page_size: 1, page_index: 1 }), 20950004, /api notification bind body/);
  // validation still wins / non-faulty commands still work
  await rejects(c.call('get_room_info', { residence_id: 'rnone' }), 20017608);
  await rejects(c.call('create_order_info', orderParam(rid, { start_time: fmt(T0 - 1000) })), 50105580);
  await rejects(c.call('create_order_info', orderParam(rid, { remark: '' })), 50104080);
  await rejects(c.call('get_order_info', { order_id: 'onone' }), 20017008);
  assert.equal((await c.call('get_room_list')).length, 1);
  assert.equal((await c.call('get_order_list', { page_size: 5, page_index: 1 })).length, 0);
  assert.equal((await c.call('get_device_list', { page_size: 1, page_index: 1, residence_id: rid })).length, 1);
  assert.equal((await c.call('get_scene_list', { page_size: 5, page_index: 1 })).length, 3);
  assert.equal((c.sim.dump() as any).orders.length, 0, 'faulty create_order_info creates nothing');
  assert.equal((c.sim.dump() as any).faults, 'uat');

  c.sim.apply({ type: 'setFaults', profile: 'none' });
  assert.equal((await info(c, rid)).dirty, (await info(c, rid)).dirty);
  await c.call('update_room_state', { residence_id: rid, dirty: true });
  await newOrder(c);
  assert.equal((await c.call('get_project_info')).timezone, 'Asia/Shanghai');
  c.sim.apply({ type: 'setFaults', profile: 'uat' });
  await rejects(c.call('get_project_info'), 24400347);
  assert.throws(() => c.sim.apply({ type: 'setFaults', profile: 'bogus' as any }));
});

test('tokenInfo, transport kind, latency, call counter, immutability', async () => {
  const c = make();
  assert.equal(c.sim.kind, 'sim');
  assert.deepEqual(c.sim.tokenInfo(), { expiresAt: T0 + 7200_000, scope: 'hotel' });
  c.advance(1000);
  assert.equal(c.sim.tokenInfo()!.expiresAt, T0 + 1000 + 7200_000);

  await c.call('get_room_list');
  await rejects(c.call('get_order_info', { order_id: 'x' }), 20017008);
  assert.equal((c.sim.dump() as any).calls, 2);

  // results are copies
  const tree = await c.call('get_room_list');
  tree[0].floors.length = 0;
  assert.ok((await c.call('get_room_list'))[0].floors.length > 0);
  const param = orderParam(await residence(c));
  const before = JSON.stringify(param);
  await c.call('create_order_info', param);
  assert.equal(JSON.stringify(param), before);

  // latency
  const slow = createGrmsSimulator(pms, { latencyMs: 40, now: () => T0 });
  const t0 = performance.now();
  await slow.call('get_room_list', {});
  assert.ok(performance.now() - t0 >= 35);
  const fast = createGrmsSimulator(pms, { now: () => T0 });
  const t1 = performance.now();
  await fast.call('get_room_list', {});
  assert.ok(performance.now() - t1 < 30);
});

test('trace ids look like real ones; ids are unique', async () => {
  const c = make();
  const traces = new Set<string>();
  for (let i = 0; i < 20; i++) {
    try { await c.call('get_order_info', { order_id: '' }); } catch (e: any) { assert.match(e.traceId, /^[0-9a-f]{32}$/); traces.add(e.traceId); }
  }
  assert.equal(traces.size, 20);
  const ids = new Set<string>();
  for (const no of ['201', '202', '203']) ids.add((await newOrder(c, no)).order_id);
  assert.equal(ids.size, 3);
});

test('dump exposes the internal db', async () => {
  const c = make();
  await newOrder(c);
  const d = c.sim.dump() as any;
  assert.equal(d.rooms.length, pms.rooms.length);
  assert.equal(d.orders.length, 1);
  assert.equal(d.guests.length, 1);
  assert.deepEqual(d.authRecords, []);
  assert.equal(d.scenes.length, 3);
  assert.ok(Object.keys(d.devices).length === pms.rooms.length);
  assert.deepEqual(d.alarms, []);
  d.orders.length = 0; // dump is a copy
  assert.equal((c.sim.dump() as any).orders.length, 1);
});

test('seedInHouse creates checked_in orders for in-house OPERA reservations', async () => {
  const c = make({ seedInHouse: true });
  const inHouse = pms.reservations.filter((r) => r.status === 'InHouse' && r.roomId);
  const list = await c.call('get_order_list', { page_size: 500, page_index: 1 });
  assert.equal(list.length, inHouse.length);
  assert.ok(list.every((o: any) => o.order_state === 'checked_in'));
  const rv = inHouse[0];
  const rm = pms.rooms.find((r) => r.id === rv.roomId)!;
  const r = await info(c, await residence(c, rm.number));
  assert.equal(r.occupied, true);
  assert.ok(r.order_id);
});
