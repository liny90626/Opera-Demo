import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PmsEngine, handleOhip, DEMO_TOKEN, roomViews, drift } from '../src/index.ts';

const H = { authorization: `Bearer ${DEMO_TOKEN}`, 'x-app-key': 'k', 'x-hotelid': 'DEMO1' };

test('auth & header validation', () => {
  const e = new PmsEngine(undefined, { businessDate: '2026-06-15' });
  assert.equal(handleOhip(e, { method: 'GET', path: '/hsk/v1/hotels/DEMO1/housekeepingOverview' }).status, 401);
  assert.equal(handleOhip(e, { method: 'GET', path: '/hsk/v1/hotels/DEMO1/housekeepingOverview', headers: { ...H, 'x-hotelid': 'X' } }).status, 400);
  const t = handleOhip(e, { method: 'POST', path: '/oauth/v1/tokens', headers: { 'x-app-key': 'k' }, body: { grant_type: 'client_credentials' } });
  assert.equal((t.body as any).access_token, DEMO_TOKEN);
  const ov = handleOhip(e, { method: 'GET', path: '/hsk/v1/hotels/DEMO1/housekeepingOverview', query: { housekeepingRoomStatus: 'Dirty' }, headers: H });
  assert.equal(ov.status, 200);
  assert.ok((ov.body as any).housekeepingRoomInfo.totalResults > 0);
  assert.ok(e.snapshot().apiLog.length >= 4);
});

test('putRoomRelatedStatus updates rooms and emits events', () => {
  const e = new PmsEngine(undefined, { businessDate: '2026-06-15' });
  const dirty = roomViews(e.snapshot()).filter((v) => v.hkStatus === 'Dirty' && !v.oooActive).slice(0, 2);
  const r = handleOhip(e, { method: 'PUT', path: '/hsk/v1/hotels/DEMO1/rooms/status', headers: H, body: { roomList: dirty.map((d) => ({ roomId: d.number })), housekeepingRoomStatus: 'Clean' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.changes.some((c) => c.events?.some((ev) => ev.source === 'OHIP_API')));
  for (const d of dirty) assert.equal(e.snapshot().rooms.find((x) => x.id === d.id)!.hkStatus, 'Clean');
  const bad = handleOhip(e, { method: 'PUT', path: '/hsk/v1/hotels/DEMO1/rooms/status', headers: H, body: { roomList: [{ roomId: dirty[0].number }], housekeepingRoomStatus: 'PickUP' } });
  assert.equal(bad.status, 400);
});

test('OOO via API then complete; check-out via csh', () => {
  const e = new PmsEngine(undefined, { businessDate: '2026-06-15' });
  const s = e.snapshot();
  const vac = roomViews(s).find((v) => v.foStatus === 'Vacant' && !v.outOfOrder && !s.reservations.some((r) => r.roomId === v.id && r.status === 'Reserved'))!;
  const c = handleOhip(e, { method: 'POST', path: '/hsk/v1/hotels/DEMO1/rooms/outOfOrderRooms', headers: H, body: { criteria: { roomRangeList: [{ roomIds: [vac.number], roomOutOfOrder: { start: '2026-06-15', end: '2026-06-16', reasonCode: 'PLB', returnStatus: 'Clean' } }] } } });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const occ = roomViews(e.snapshot()).find((v) => v.foStatus === 'Occupied')!;
  const conflict = handleOhip(e, { method: 'POST', path: '/hsk/v1/hotels/DEMO1/rooms/outOfOrderRooms', headers: H, body: { criteria: { roomRangeList: [{ roomIds: [occ.number], roomOutOfOrder: { start: '2026-06-15', end: '2026-06-15', reasonCode: 'PLB' } }] } } });
  assert.equal(conflict.status, 409);
  const done = handleOhip(e, { method: 'PUT', path: '/hsk/v1/hotels/DEMO1/rooms/outOfOrderRooms', headers: H, body: { criteria: { roomRepairByRoomNumber: [{ roomId: vac.number }] } } });
  assert.equal(done.status, 200);
  const co = handleOhip(e, { method: 'POST', path: `/csh/v1/hotels/DEMO1/reservations/${occ.inHouse!.confirmationNo}/checkOuts`, headers: H });
  assert.equal(co.status, 200, JSON.stringify(co.body));
  for (const sub of e.snapshot().subscribers) assert.equal(drift(e.snapshot(), sub).length, 0);
  const poll = handleOhip(e, { method: 'GET', path: '/api/events', query: { sinceSeq: '0' } });
  assert.ok((poll.body as any).events.length >= 3);
});
