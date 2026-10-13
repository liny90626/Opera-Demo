import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PmsEngine, roomViews, roomSummary, roomStatusTile, applyChanges, drift, addDays, EVENTS } from '../src/index.ts';

const mk = () => new PmsEngine(undefined, { businessDate: '2026-06-15', random: () => 0.99 });
const ui = { name: 'TEST', source: 'OPERA_UI' as const };

test('seed has consistent data', () => {
  const e = mk();
  const s = e.snapshot();
  assert.equal(s.rooms.length, 97);
  const views = roomViews(s);
  const sum = roomSummary(s, views);
  assert.equal(sum.outOfOrder, 1);
  assert.equal(sum.outOfService, 1);
  assert.equal(sum.inventory, 96);
  assert.ok(sum.discrepancies >= 3, 'seeded discrepancies');
  // no room double-booked by in-house guests
  const inh = s.reservations.filter((r) => r.status === 'InHouse').map((r) => r.roomId);
  assert.equal(new Set(inh).size, inh.length);
  const tile = roomStatusTile(views);
  const total = tile.reduce((a, t) => a + t.occupied + t.assigned + t.vacant, 0);
  assert.equal(total, 95); // 97 minus OOO and OOS
  assert.equal(s.subscribers.length, 5);
});

test('check-in requires Inspected room, queue then ready flow', () => {
  const e = mk();
  const s = e.snapshot();
  const views = roomViews(s);
  const dirtyArr = views.find((v) => v.arrival && v.hkStatus === 'Dirty')!;
  const res = dirtyArr.arrival!;
  const r1 = e.exec({ type: 'checkIn', reservationId: res.id }, ui);
  assert.equal(r1.ok, false);
  assert.equal(r1.errorCode, 'ROOM_NOT_READY');
  if (!res.queue) assert.ok(e.exec({ type: 'queueReservation', reservationId: res.id }, ui).ok);
  e.exec({ type: 'setParameters', parameters: { allowCheckInClean: false } }, ui);
  const c = e.exec({ type: 'setHkStatus', roomIds: [dirtyArr.id], status: 'Clean' }, ui);
  assert.ok(c.ok);
  assert.equal(e.exec({ type: 'checkIn', reservationId: res.id }, ui).errorCode, 'ROOM_NOT_READY'); // Clean not enough when parameter off
  const i = e.exec({ type: 'setHkStatus', roomIds: [dirtyArr.id], status: 'Inspected' }, ui);
  assert.ok(i.changes!.events!.some((ev) => ev.eventName === EVENTS.QUEUE_ROOM_READY));
  const ci = e.exec({ type: 'checkIn', reservationId: res.id }, ui);
  assert.ok(ci.ok, ci.error);
  const v = roomViews(e.snapshot()).find((x) => x.id === dirtyArr.id)!;
  assert.equal(v.foStatus, 'Occupied');
  assert.equal(v.resvStatus, 'Arrived');
  assert.equal(e.snapshot().reservations.find((r) => r.id === res.id)!.queue, null);
});

test('check-out sets room Dirty and syncs subscribers', () => {
  const e = mk();
  const due = roomViews(e.snapshot()).find((v) => v.resvStatus === 'Due Out')!;
  const r = e.exec({ type: 'checkOut', reservationId: due.inHouse!.id }, ui);
  assert.ok(r.ok);
  const v = roomViews(e.snapshot()).find((x) => x.id === due.id)!;
  assert.equal(v.hkStatus, 'Dirty');
  assert.equal(v.foStatus, 'Vacant');
  assert.equal(v.resvStatus, 'Departed');
  const pbx = e.snapshot().subscribers.find((x) => x.kind === 'PBX')!;
  assert.equal(pbx.mirror[due.id], 'Line Barred');
  for (const sub of e.snapshot().subscribers) assert.deepEqual(drift(e.snapshot(), sub), [], sub.name);
});

test('failed delivery creates drift, retry heals it', () => {
  const e = mk();
  e.exec({ type: 'setSubscriber', subscriberId: 'SUB-LOCK', failureRate: 1 }, ui);
  const due = roomViews(e.snapshot()).find((v) => v.resvStatus === 'Due Out')!;
  e.exec({ type: 'checkOut', reservationId: due.inHouse!.id }, ui);
  const lock = () => e.snapshot().subscribers.find((x) => x.id === 'SUB-LOCK')!;
  assert.equal(drift(e.snapshot(), lock()).length, 1);
  e.exec({ type: 'setSubscriber', subscriberId: 'SUB-LOCK', failureRate: 0 }, ui);
  const rr = e.exec({ type: 'retryAllFailed' }, ui);
  assert.ok(rr.ok, rr.error);
  assert.equal(drift(e.snapshot(), lock()).length, 0);
});

test('OOO rules: occupied blocked, vacant reduces inventory, release applies return status', () => {
  const e = mk();
  const s = e.snapshot();
  const occ = roomViews(s).find((v) => v.foStatus === 'Occupied')!;
  const bad = e.exec({ type: 'placeOutOfOrder', roomIds: [occ.id], oooType: 'OOO', from: s.hotel.businessDate, to: s.hotel.businessDate, reasonCode: 'PLB', returnStatus: 'Dirty' }, ui);
  assert.equal(bad.errorCode, 'ROOM_OCCUPIED');
  const vac = roomViews(s).find((v) => v.foStatus === 'Vacant' && !v.arrival && !v.outOfOrder && !s.reservations.some((r) => r.roomId === v.id && r.status === 'Reserved'))!;
  const ok = e.exec({ type: 'placeOutOfOrder', roomIds: [vac.id], oooType: 'OOO', from: s.hotel.businessDate, to: addDays(s.hotel.businessDate, 1), reasonCode: 'ELE', returnStatus: 'Inspected' }, ui);
  assert.ok(ok.ok, ok.error);
  assert.equal(roomSummary(e.snapshot()).outOfOrder, 2);
  const chn = e.snapshot().subscribers.find((x) => x.kind === 'CHANNEL')!;
  assert.equal(drift(e.snapshot(), chn).length, 0);
  // HK status change on OOO room is refused
  assert.equal(e.exec({ type: 'setHkStatus', roomIds: [vac.id], status: 'Clean' }, ui).ok, false);
  const rel = e.exec({ type: 'releaseOutOfOrder', roomIds: [vac.id] }, ui);
  assert.ok(rel.ok);
  assert.equal(e.snapshot().rooms.find((r) => r.id === vac.id)!.hkStatus, 'Inspected');
});

test('discrepancy detect & resolve; PBX code inbound', () => {
  const e = mk();
  const vac = roomViews(e.snapshot()).find((v) => v.foStatus === 'Vacant' && v.discrepancies.length === 0 && !v.oooActive)!;
  const r = e.exec({ type: 'pbxStatusCode', roomNumber: vac.number, code: '5' }, { name: 'PBX', source: 'PBX' });
  assert.ok(r.ok);
  let v = roomViews(e.snapshot()).find((x) => x.id === vac.id)!;
  assert.deepEqual(v.discrepancies, ['Sleep']);
  assert.equal(r.changes!.events![0].source, 'PBX');
  e.exec({ type: 'resolveDiscrepancy', roomId: vac.id }, ui);
  v = roomViews(e.snapshot()).find((x) => x.id === vac.id)!;
  assert.deepEqual(v.discrepancies, []);
});

test('assign room validations and room move', () => {
  const e = mk();
  const s = e.snapshot();
  const D = s.hotel.businessDate;
  const unassigned = s.reservations.find((r) => r.status === 'Reserved' && r.arrival === D && !r.roomId)!;
  const occ = roomViews(s).find((v) => v.foStatus === 'Occupied' && v.roomType === unassigned.roomType && v.inHouse!.departure > D)!;
  assert.equal(e.exec({ type: 'assignRoom', reservationId: unassigned.id, roomId: occ.id }, ui).errorCode, 'ROOM_UNAVAILABLE');
  const show = s.rooms.find((r) => r.conditionCode === 'SHW')!;
  assert.equal(e.exec({ type: 'assignRoom', reservationId: unassigned.id, roomId: show.id, force: true }, ui).errorCode, 'ROOM_CONDITION');
  const free = roomViews(s).find((v) => v.foStatus === 'Vacant' && !v.arrival && v.hkStatus === 'Inspected' && !v.outOfOrder && !v.conditionCode && v.roomType === unassigned.roomType && !s.reservations.some((r) => r.roomId === v.id && r.status === 'Reserved'))!;
  const a = e.exec({ type: 'assignRoom', reservationId: unassigned.id, roomId: free.id }, ui);
  assert.ok(a.ok, a.error);
  assert.ok(e.exec({ type: 'checkIn', reservationId: unassigned.id }, ui).ok);
  const target = roomViews(e.snapshot()).find((v) => v.foStatus === 'Vacant' && !v.arrival && v.hkStatus === 'Inspected' && !v.outOfOrder && !v.conditionCode && !e.snapshot().reservations.some((r) => r.roomId === v.id && r.status === 'Reserved'))!;
  const mv = e.exec({ type: 'roomMove', reservationId: unassigned.id, toRoomId: target.id, reason: 'Noise' }, ui);
  assert.ok(mv.ok, mv.error);
  assert.equal(e.snapshot().rooms.find((r) => r.id === free.id)!.hkStatus, 'Dirty');
});

test('night audit blocked by due outs, then rolls date', () => {
  const e = mk();
  const D = e.snapshot().hotel.businessDate;
  assert.equal(e.exec({ type: 'nightAudit' }, ui).errorCode, 'DUE_OUTS_PENDING');
  for (const r of e.snapshot().reservations.filter((r) => r.status === 'InHouse' && r.departure <= D)) e.exec({ type: 'checkOut', reservationId: r.id }, ui);
  const na = e.exec({ type: 'nightAudit' }, ui);
  assert.ok(na.ok, na.error);
  assert.equal(e.snapshot().hotel.businessDate, addDays(D, 1));
  assert.ok(na.changes!.reset);
  const occ = roomViews(e.snapshot()).filter((v) => v.foStatus === 'Occupied');
  assert.ok(occ.every((v) => v.hkStatus === 'Dirty'));
  assert.ok(e.snapshot().reservations.every((r) => !(r.status === 'Reserved' && r.arrival <= D)));
});

test('applyChanges merges incremental change sets', () => {
  const e = mk();
  let client = structuredClone(e.snapshot());
  const due = roomViews(client).find((v) => v.resvStatus === 'Due Out')!;
  const r = e.exec({ type: 'checkOut', reservationId: due.inHouse!.id }, ui);
  client = applyChanges(client, r.changes!);
  assert.deepEqual(client.rooms, e.snapshot().rooms);
  assert.deepEqual(client.reservations, e.snapshot().reservations);
  assert.equal(client.version, e.snapshot().version);
  assert.equal(client.events[0].id, e.snapshot().events[0].id);
});

test('failed command rolls back state', () => {
  const e = mk();
  const before = JSON.stringify(e.snapshot());
  const r = e.exec({ type: 'setHkStatus', roomIds: ['9999'], status: 'Clean' }, ui);
  assert.equal(r.ok, false);
  assert.equal(JSON.stringify(e.snapshot()), before);
});
