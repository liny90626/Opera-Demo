import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PmsEngine, createAkubelaService, handleAkubelaRequest, GrmsError, type AkubelaServiceApi, type GrmsTransport, type PmsPort } from '../src/index.ts';

const mkPms = (): PmsPort => {
  const e = new PmsEngine(undefined, { businessDate: '2026-06-15', random: () => 0.99 });
  return { snapshot: () => e.state, exec: (c, a) => e.exec(c, a) };
};
const mkSvc = (extra: Partial<Parameters<typeof createAkubelaService>[0]> = {}) =>
  createAkubelaService({ pms: mkPms(), realTransportFactory: null, initialMode: 'sim', autoStart: false, ...extra });
const A = '/api/integrations/akubela';

test('service: starts in sim, switches modes, carries settings', async () => {
  const svc = mkSvc();
  try {
    assert.equal(svc.state().mode, 'sim');
    assert.ok(svc.simulator());
    assert.ok(svc.connector());
    svc.connector()!.updateSettings({ syncHkStatus: false });
    await svc.setMode('off');
    assert.equal(svc.state().mode, 'off');
    assert.equal(svc.connector(), null);
    assert.equal(svc.simulator(), null);
    assert.equal(svc.state().settings.syncHkStatus, false);
    assert.equal((await svc.test()).ok, false);
    await assert.rejects(svc.setMode('real'), /not/i);
    await svc.setMode('sim');
    assert.equal(svc.state().mode, 'sim');
    assert.equal(svc.state().settings.syncHkStatus, false, 'settings survive mode switches');
    assert.ok(svc.state().residences.length > 0, 'master data refreshed');
    const t = await svc.test();
    assert.equal(t.ok, true);
    assert.ok(t.residences > 0);
  } finally {
    svc.dispose();
  }
});

test('service: real mode uses factory; failing master data lands in lastError', async () => {
  const failing: GrmsTransport = {
    kind: 'real',
    tokenInfo: () => null,
    call: async () => {
      throw new GrmsError('boom', 20950001, 'trace-1', 200, false);
    },
  };
  const svc = mkSvc({ realTransportFactory: () => failing });
  try {
    await svc.setMode('real');
    assert.equal(svc.state().mode, 'real');
    assert.equal(svc.simulator(), null);
    assert.equal(svc.state().lastError?.code, 20950001);
    const t = await svc.test();
    assert.deepEqual([t.ok, t.code, t.traceId], [false, 20950001, 'trace-1']);
  } finally {
    svc.dispose();
  }
});

test('service: initial real without factory falls back to sim', () => {
  const svc = mkSvc({ initialMode: 'real' });
  assert.equal(svc.state().mode, 'sim');
  svc.dispose();
});

async function call(svc: AkubelaServiceApi, method: string, path: string, body?: unknown) {
  return handleAkubelaRequest(svc, method, path, body);
}

test('rest: routes and validation', async () => {
  const svc = mkSvc();
  try {
    assert.equal((await call(svc, 'GET', `${A}/state`)).status, 200);
    assert.equal((await call(svc, 'GET', '/state')).status, 404, 'prefix required');
    assert.equal((await call(svc, 'GET', `${A}/nope`)).status, 404);
    assert.equal(((await call(svc, 'POST', `${A}/test`)).body as { ok: boolean }).ok, true);
    assert.equal((await call(svc, 'POST', `${A}/mode`, { mode: 'bogus' })).status, 400);
    assert.equal((await call(svc, 'POST', `${A}/mode`, { mode: 'real' })).status, 400, 'no real transport');

    assert.equal((await call(svc, 'PUT', `${A}/settings`, { syncHkStatus: 'yes' })).status, 400);
    assert.equal((await call(svc, 'PUT', `${A}/settings`, { checkInTime: '25:00' })).status, 400);
    assert.equal((await call(svc, 'PUT', `${A}/settings`, { bogus: 1 })).status, 400);
    const ok = await call(svc, 'PUT', `${A}/settings`, { doorPinOnCheckIn: true, pollSeconds: 30 });
    assert.equal(ok.status, 200);
    assert.equal(svc.state().settings.doorPinOnCheckIn, true);

    assert.equal((await call(svc, 'PUT', `${A}/mapping`, { residenceId: 'x' })).status, 400);
    assert.equal((await call(svc, 'PUT', `${A}/mapping`, { roomId: '0201', residenceId: null })).status, 200);

    assert.equal((await call(svc, 'POST', `${A}/poll`)).status, 200);
    assert.equal((await call(svc, 'POST', `${A}/reconcile`)).status, 200);
    const push = await call(svc, 'POST', `${A}/push`);
    assert.equal(push.status, 200);
    assert.equal(typeof (push.body as { jobs: number }).jobs, 'number');
    assert.equal((await call(svc, 'PUT', `${A}/settings`, { syncMode: 'bogus' })).status, 400);
    assert.equal((await call(svc, 'PUT', `${A}/settings`, { syncMode: 'bidirectional', pushOnStart: false })).status, 200);
    assert.equal((await call(svc, 'POST', `${A}/jobs/nope/retry`)).status, 404);
    assert.equal((await call(svc, 'GET', `${A}/scenes`)).status, 200);
    assert.equal((await call(svc, 'POST', `${A}/devices/control`, { device_id: 'd' })).status, 400);
    assert.equal((await call(svc, 'POST', `${A}/scenes/s1/trigger`, { roomIds: 'x' })).status, 400);

    const res = svc.state().residences[0];
    assert.equal((await call(svc, 'POST', `${A}/sim`, { type: 'nope' })).status, 400);
    assert.equal((await call(svc, 'POST', `${A}/sim`, { type: 'setRoomState', residenceId: res.residence_id, dirty: false })).status, 200);

    await call(svc, 'POST', `${A}/mode`, { mode: 'off' });
    assert.equal((await call(svc, 'POST', `${A}/sim`, { type: 'setFaults', profile: 'none' })).status, 409);
    assert.equal((await call(svc, 'POST', `${A}/poll`)).status, 409);
    assert.equal((await call(svc, 'POST', `${A}/push`)).status, 409);
    assert.equal((await call(svc, 'GET', `${A}/state`)).status, 200);
  } finally {
    svc.dispose();
  }
});

test('rest: GRMS errors map to 502', async () => {
  const failing: GrmsTransport = {
    kind: 'real',
    tokenInfo: () => null,
    call: async () => {
      throw new GrmsError('bind body', 20950001, 'tr-9', 200);
    },
  };
  const svc = mkSvc({ initialMode: 'real', realTransportFactory: () => failing });
  try {
    const r = await call(svc, 'GET', `${A}/rooms/0201/devices`);
    assert.equal(r.status, 409, 'room is unmapped because master data failed to load');
    const sc = await call(svc, 'GET', `${A}/scenes`);
    assert.equal(sc.status, 502);
    assert.deepEqual(sc.body, { code: 20950001, message: 'bind body', traceId: 'tr-9' });
  } finally {
    svc.dispose();
  }
});

test('service: pushes OPERA state to the simulator on start (room states, in-house orders, arrival pre-registered)', async () => {
  const pms = mkPms();
  const svc = createAkubelaService({ pms, realTransportFactory: null, initialMode: 'sim', autoStart: false });
  try {
    for (let i = 0; i < 200 && !svc.state().lastPushAt; i++) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 100));
    const snap = pms.snapshot();
    const dump = svc.simulator()!.dump() as any;
    for (const room of snap.rooms) {
      const g = dump.rooms.find((r: any) => r.residence_no === room.number);
      assert.equal(g.dirty, room.hkStatus === 'Dirty' || room.hkStatus === 'Pickup', `room ${room.number}`);
    }
    for (const r of snap.reservations.filter((x) => x.status === 'InHouse')) {
      assert.ok(dump.orders.some((o: any) => o.residence_no === snap.rooms.find((m) => m.id === r.roomId)!.number && o.order_state === 'checked_in'), r.guestName);
    }
    assert.ok(dump.orders.some((o: any) => o.residence_no === '101' && o.order_state === 'check_in'), 'room 101 pre-registered ' + JSON.stringify(dump.orders.map((o: any) => [o.residence_no, o.order_state])) + JSON.stringify(svc.state().jobs.filter((j) => j.status !== 'SUCCEEDED').map((j) => [j.summary, j.status, j.lastError])));
  } finally {
    svc.dispose();
  }
});
