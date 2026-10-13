/**
 * Live Akubela GRMS UAT check.  Usage: npm run akubela:verify [-- --write] [--residence <id>]
 * Read-only by default. --write runs a full order/room-state cycle on one residence (creates real data!).
 * Credentials come from env (AKUBELA_CLIENT_ID / AKUBELA_CLIENT_SECRET / AKUBELA_BASE_URL) or the repo-root .env.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GrmsError, type GrmsTransport } from '@opera-demo/core';
import { createRealTransport } from '../src/akubela/client.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(here, '../../../.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const args = process.argv.slice(2);
const write = args.includes('--write');
const resArg = args.indexOf('--residence') >= 0 ? args[args.indexOf('--residence') + 1] : undefined;
const { AKUBELA_CLIENT_ID: id, AKUBELA_CLIENT_SECRET: secret } = process.env;
const baseUrl = process.env.AKUBELA_BASE_URL ?? 'https://api.cbcloud.uat.akubela.com';
if (!id || !secret) {
  console.error('Missing AKUBELA_CLIENT_ID / AKUBELA_CLIENT_SECRET (set env vars or .env)');
  process.exit(2);
}

const t: GrmsTransport = createRealTransport({ baseUrl, clientId: id, clientSecret: secret });
let pass = 0;
let fail = 0;

async function step<T>(name: string, fn: () => Promise<T>, summarize: (r: T) => string = () => ''): Promise<T | undefined> {
  const t0 = Date.now();
  try {
    const r = await fn();
    pass++;
    console.log(`PASS  ${name}  ${summarize(r)} (${Date.now() - t0} ms)`);
    return r;
  } catch (e) {
    fail++;
    const g = e as GrmsError;
    console.log(`FAIL  ${name}  code=${g.code ?? '-'} trace_id=${g.traceId ?? '-'} ${g.message}`);
    return undefined;
  }
}

const utc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
type Building = { floors: { residences: { residence_id: string; residence_name: string }[] }[] };

console.log(`Akubela UAT verify — ${baseUrl} — mode: ${write ? 'READ + WRITE' : 'read-only'}`);
await step('oauth token (scope=hotel)', () => t.call('get_room_list', {}).then(() => t.tokenInfo()), (i) => `expires in ${i ? Math.round((i.expiresAt - Date.now()) / 1000) : '?'} s`);
const rooms = await step('get_room_list', () => t.call<Building[]>('get_room_list', {}), (r) => `${r.length} building(s)`);
const residences = (rooms ?? []).flatMap((b) => b.floors.flatMap((f) => f.residences));
console.log(`      residences: ${residences.map((r) => r.residence_name).join(', ') || '(none)'}`);
await step('get_room_type_list', () => t.call<unknown[]>('get_room_type_list', { page_size: 50, page_index: 1 }), (r) => `${r.length} type(s)`);
await step('get_order_list', () => t.call<unknown[]>('get_order_list', { page_size: 20, page_index: 1 }), (r) => `${r.length} order(s)`);
for (const r of residences) {
  await step(`get_device_list [${r.residence_name}]`, () => t.call<unknown[]>('get_device_list', { page_size: 50, page_index: 1, residence_id: r.residence_id, show_ability: true, parallel_sub_device: false }), (x) => `${x.length} device(s)`);
  await step(`get_room_info [${r.residence_name}]`, () => t.call<Record<string, unknown>>('get_room_info', { residence_id: r.residence_id }), (x) => `dirty=${x.dirty} occupied=${x.occupied} dnd=${x.dnd}`);
}

if (write) {
  const target = residences.find((r) => r.residence_id === resArg || r.residence_name === resArg) ?? residences[0];
  if (!target) {
    console.log('FAIL  no residence available for the write cycle');
    fail++;
  } else {
    console.log(`--- write cycle on residence ${target.residence_name} (${target.residence_id})`);
    const start = Date.now() + 120_000;
    const finish = start + 3600_000;
    const guest = { guest_name: 'Verify Guest', email: 'verify@opera-demo.local', phone: 'N/A', id_card: 'N/A', passport: 'N/A' };
    const created = await step('create_order_info (start=now+2min)', () => t.call<{ order_id: string }>('create_order_info', { residence_id: target.residence_id, start_time: utc(start), finish_time: utc(finish), source: 'OPERA', remark: 'akubela:verify', enable_booking: false, guest }), (r) => `order_id=${r?.order_id}`);
    const orderId = created?.order_id;
    const upd = (state: string, finishT = utc(finish)) => () => t.call('update_order_info', { order_id: orderId, start_time: utc(start), finish_time: finishT, order_state: state, source: 'OPERA', remark: 'akubela:verify', enable_booking: false });
    if (orderId) {
      await step('update_order_info → checked_in', upd('checked_in'));
      await step('update_order_info → checked_out', upd('checked_out', utc(Date.now() + 60_000)));
    } else {
      console.log('SKIP  order updates (no order_id)');
    }
    await step('update_room_state dirty=true', () => t.call('update_room_state', { residence_id: target.residence_id, dirty: true }));
    await step('update_room_state dirty=false', () => t.call('update_room_state', { residence_id: target.residence_id, dirty: false }));
    if (orderId) await step('delete_order_info', () => t.call('delete_order_info', { order_id: orderId }));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
