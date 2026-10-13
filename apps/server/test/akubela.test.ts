import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { roomViews } from '@opera-demo/core';
import { createApp } from '../src/app.ts';
import { createRealTransport } from '../src/akubela/client.ts';

// ───────────────────────────── real client against a local fake GRMS
interface Fake {
  url: string;
  tokenCalls: { grant: string; body: URLSearchParams }[];
  cmdCalls: { command: string; id: string; auth: string }[];
  behavior: { cmd: (n: number, body: any, auth: string) => { status: number; body?: unknown; delayMs?: number } };
  setTtl(n: number): void;
  close(): Promise<void>;
}

async function fakeGrms(): Promise<Fake> {
  const f: Fake = { url: '', tokenCalls: [], cmdCalls: [], behavior: { cmd: () => ({ status: 200, body: { success: true, timestamp: 1, result: { ok: true } } }) }, setTtl: () => {}, close: async () => {} };
  let ttl = 7200;
  let seq = 0;
  f.setTtl = (n) => (ttl = n);
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (status: number, body: unknown, delay = 0) => setTimeout(() => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }, delay);
      if (req.url!.endsWith('/oauth2/token')) {
        const form = new URLSearchParams(raw);
        f.tokenCalls.push({ grant: form.get('grant_type')!, body: form });
        seq++;
        return send(200, { success: true, timestamp: 1, result: { access_token: `AT${seq}`, refresh_token: `RT${seq}`, token_type: 'bearer', expires_in: ttl } });
      }
      const body = JSON.parse(raw);
      const auth = String(req.headers.authorization);
      f.cmdCalls.push({ command: body.command, id: body.id, auth });
      const r = f.behavior.cmd(f.cmdCalls.length, body, auth);
      send(r.status, r.body ?? {}, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  f.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  return f;
}

test('client: token caching, form encoding, command shape', async () => {
  const fake = await fakeGrms();
  let t = 1_000_000;
  const c = createRealTransport({ baseUrl: fake.url, clientId: 'cid', clientSecret: 'sec', now: () => t });
  try {
    await Promise.all([c.call('get_room_list', {}), c.call('get_room_list', {}), c.call('get_room_list', {})]);
    assert.equal(fake.tokenCalls.length, 1, 'single-flight token fetch');
    const tc = fake.tokenCalls[0].body;
    assert.deepEqual([tc.get('grant_type'), tc.get('scope'), tc.get('client_id'), tc.get('client_secret')], ['client_credentials', 'hotel', 'cid', 'sec']);
    assert.match(fake.cmdCalls[0].id, /^c[0-9a-f]{32}$/);
    assert.equal(fake.cmdCalls[0].auth, 'Bearer AT1');
    await c.call('x', {}, { commandId: 'opera-job-1' });
    assert.equal(fake.cmdCalls.at(-1)!.id, 'opera-job-1');
    assert.equal(fake.tokenCalls.length, 1, 'cached');
    assert.equal(c.tokenInfo()!.scope, 'hotel');

    t += (7200 - 100) * 1000; // inside the 120 s safety window -> refresh_token grant
    await c.call('get_room_list', {});
    assert.equal(fake.tokenCalls.length, 2);
    assert.equal(fake.tokenCalls[1].grant, 'refresh_token');
    assert.equal(fake.tokenCalls[1].body.get('refresh_token'), 'RT1');
    assert.equal(fake.cmdCalls.at(-1)!.auth, 'Bearer AT2');
  } finally {
    await fake.close();
  }
});

test('client: error envelope, auth retry, 5xx retryable, redaction', async () => {
  const fake = await fakeGrms();
  const c = createRealTransport({ baseUrl: fake.url, clientId: 'cid', clientSecret: 'TOPSECRET' });
  try {
    fake.behavior.cmd = () => ({ status: 200, body: { success: false, timestamp: 1, result: { code: 20950001, message: 'api room bind body', detail: { trace_id: 'tf36-abc' } } } });
    await assert.rejects(c.call('get_room_info', {}), (e: any) => e.name === 'GrmsError' && e.code === 20950001 && e.traceId === 'tf36-abc' && e.retryable === false && !e.message.includes('TOPSECRET'));

    fake.behavior.cmd = () => ({ status: 503, body: { success: false, result: { code: 20000000, message: `Internal TOPSECRET`, detail: { trace_id: 't5' } } } });
    await assert.rejects(c.call('x', {}), (e: any) => e.retryable === true && e.httpStatus === 503 && !e.message.includes('TOPSECRET'));

    // 401 once -> token refreshed -> retry succeeds
    const before = fake.tokenCalls.length;
    fake.behavior.cmd = (n, _b, auth) => (auth === `Bearer AT${fake.tokenCalls.length}` && fake.tokenCalls.length > before ? { status: 200, body: { success: true, result: { fine: 1 } } } : { status: 401, body: { success: false, result: { code: 40100000, message: 'token invalid', detail: { trace_id: 'tt' } } } });
    assert.deepEqual(await c.call('x', {}), { fine: 1 });
    assert.ok(fake.tokenCalls.length > before);
  } finally {
    await fake.close();
  }
});

test('client: timeout and network errors are retryable', async () => {
  const fake = await fakeGrms();
  const c = createRealTransport({ baseUrl: fake.url, clientId: 'cid', clientSecret: 's', timeoutMs: 100 });
  try {
    fake.behavior.cmd = () => ({ status: 200, body: { success: true, result: {} }, delayMs: 600 });
    await assert.rejects(c.call('x', {}), (e: any) => e.retryable === true && /timed out/.test(e.message));
  } finally {
    await fake.close();
  }
  await assert.rejects(c.call('x', {}), (e: any) => e.retryable === true);
});

test('client: bad credentials surface the token error', async () => {
  const fake = await fakeGrms();
  const c = createRealTransport({ baseUrl: fake.url, clientId: 'cid', clientSecret: 's', fetchImpl: async (u, init) => (String(u).endsWith('/token') ? new Response(JSON.stringify({ success: false, result: { code: 20000003, message: 'invalid client', detail: { trace_id: 'tk' } } }), { status: 401 }) : fetch(u, init)) });
  try {
    await assert.rejects(c.call('x', {}), (e: any) => e.code === 20000003 && e.traceId === 'tk');
  } finally {
    await fake.close();
  }
});

// ───────────────────────────── server wiring (sim mode)
test('server: PMS commands flow to GRMS sim and state is exposed (REST + SSE)', async () => {
  const app = createApp({ akubela: { mode: 'sim', autoStart: false, file: null } });
  const server = app.app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const st0 = await (await fetch(`${base}/api/integrations/akubela/state`)).json();
    assert.equal(st0.mode, 'sim');
    assert.equal(st0.clientIdMasked, null);

    // SSE collects akubela events
    const ctrl = new AbortController();
    const stream = await fetch(`${base}/api/stream`, { signal: ctrl.signal });
    const reader = stream.body!.getReader();
    let sse = '';
    void (async () => {
      const dec = new TextDecoder();
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; sse += dec.decode(value); } } catch { /* aborted */ }
    })();

    const view = roomViews(app.engine.state).find((v) => v.arrival && v.hkStatus === 'Inspected' && !v.oooActive);
    assert.ok(view, 'seed has an inspected arrival');
    const resv = view!.arrival!;
    const r = await post('/api/commands', { command: { type: 'checkIn', reservationId: resv.id } });
    assert.equal(r.status, 200);

    const conn = app.akubela.connector()!;
    for (let i = 0; i < 6 && !app.akubela.state().links.some((l) => l.reservationId === resv.id && l.state === 'checked_in'); i++) await conn.drain();
    const link = app.akubela.state().links.find((l) => l.reservationId === resv.id);
    assert.equal(link?.state, 'checked_in');

    await new Promise((res) => setTimeout(res, 450));
    assert.match(sse, /event: akubela/);
    const st = await (await fetch(`${base}/api/integrations/akubela/state`)).json();
    assert.ok(st.links.some((l: any) => l.reservationId === resv.id));

    // inbound: GRMS-side change is applied to the PMS and broadcast
    const rs = await post('/api/integrations/akubela/test', {});
    assert.equal(((await rs.json()) as { ok: boolean }).ok, true);
    ctrl.abort();
  } finally {
    app.dispose();
    server.closeAllConnections?.();
    await new Promise((res) => server.close(res));
  }
});

test('server: mode defaults to sim without credentials; dispose is clean', () => {
  const saved = { ...process.env };
  delete process.env.AKUBELA_CLIENT_ID; delete process.env.AKUBELA_CLIENT_SECRET; delete process.env.AKUBELA_MODE;
  try {
    const a = createApp({ akubela: { file: null } });
    assert.equal(a.akubela.state().mode, 'sim');
    a.dispose();
    const b = createApp({ akubela: { file: null, clientId: 'id-1234567890', clientSecret: 's3cret', mode: 'off' } });
    assert.equal(b.akubela.state().mode, 'off');
    b.dispose();
  } finally {
    process.env = saved;
  }
});
