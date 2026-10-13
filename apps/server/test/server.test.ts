import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { DEMO_TOKEN, roomViews } from '@opera-demo/core';

test('commands, SSE broadcast and OHIP façade', async () => {
  const { app, engine } = createApp();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const snap = await (await fetch(`${base}/api/snapshot`)).json();
    assert.equal(snap.rooms.length, 96);

    // open SSE stream and collect change events
    const ctrl = new AbortController();
    const stream = await fetch(`${base}/api/stream`, { signal: ctrl.signal });
    const reader = stream.body!.getReader();
    const received: string[] = [];
    const pump = (async () => {
      const dec = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          received.push(dec.decode(value));
        }
      } catch { /* aborted */ }
    })();

    const dirty = roomViews(engine.state).find((v) => v.hkStatus === 'Dirty' && !v.oooActive)!;
    const r = await fetch(`${base}/api/commands`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: { type: 'setHkStatus', roomIds: [dirty.id], status: 'Clean' } }),
    });
    assert.equal(r.status, 200);
    const bad = await fetch(`${base}/api/commands`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: { type: 'checkIn', reservationId: 'nope' } }),
    });
    assert.equal(bad.status, 422);

    const o = await fetch(`${base}/hsk/v1/hotels/DEMO1/rooms/status`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${DEMO_TOKEN}`, 'x-app-key': 'k', 'x-hotelid': 'DEMO1' },
      body: JSON.stringify({ roomList: [{ roomId: dirty.number }], housekeepingRoomStatus: 'Inspected' }),
    });
    assert.equal(o.status, 200);
    await new Promise((res) => setTimeout(res, 150));
    ctrl.abort();
    await pump;
    const all = received.join('');
    assert.match(all, /event: hello/);
    assert.ok((all.match(/event: change/g) ?? []).length >= 2, all.slice(0, 300));
    assert.equal(engine.state.rooms.find((x) => x.id === dirty.id)!.hkStatus, 'Inspected');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
