// REST router for /api/integrations/akubela/* (framework-agnostic; server and browser share it).
import {
  GrmsError,
  type AkubelaServiceApi,
  type AkubelaSettings,
  type IntegrationMode,
  type SimAction,
} from './contract.ts';

type Res = { status: number; body: unknown };
const PREFIX = '/api/integrations/akubela';
const MODES: IntegrationMode[] = ['real', 'sim', 'off'];

const bad = (message: string, status = 400): Res => ({ status, body: { error: message } });
const isObj = (b: unknown): b is Record<string, unknown> => !!b && typeof b === 'object' && !Array.isArray(b);
const str = (v: unknown) => typeof v === 'string' && v.length > 0;

const BOOL_KEYS = ['preRegisterOnAssign', 'syncHkStatus', 'acceptGrmsClean', 'acceptGrmsDnd', 'acceptGrmsCheckout', 'doorPinOnCheckIn', 'pushOnStart'] as const;
const STR_KEYS = ['hotelTimezone', 'orderSource'] as const;
const TIME_KEYS = ['checkInTime', 'checkOutTime'] as const;

function validateSettings(body: unknown): { patch: Partial<AkubelaSettings> } | { error: string } {
  if (!isObj(body)) return { error: 'body must be an object' };
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if ((BOOL_KEYS as readonly string[]).includes(k)) {
      if (typeof v !== 'boolean') return { error: `${k} must be boolean` };
    } else if ((STR_KEYS as readonly string[]).includes(k)) {
      if (!str(v)) return { error: `${k} must be a non-empty string` };
    } else if ((TIME_KEYS as readonly string[]).includes(k)) {
      if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return { error: `${k} must be HH:mm` };
    } else if (k === 'syncMode') {
      if (v !== 'opera-master' && v !== 'bidirectional') return { error: "syncMode must be 'opera-master' or 'bidirectional'" };
    } else if (k === 'welcomeSceneId' || k === 'checkoutSceneId') {
      if (v !== null && typeof v !== 'string') return { error: `${k} must be string or null` };
    } else if (k === 'pollSeconds') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 2 || v > 3600) return { error: 'pollSeconds must be a number between 2 and 3600' };
    } else return { error: `unknown setting: ${k}` };
    patch[k] = v;
  }
  return { patch: patch as Partial<AkubelaSettings> };
}

function validateSim(body: unknown): SimAction | string {
  if (!isObj(body) || typeof body.type !== 'string') return 'body must be a SimAction with a type';
  switch (body.type) {
    case 'setRoomState':
      if (!str(body.residenceId)) return 'residenceId is required';
      if (body.dirty !== undefined && typeof body.dirty !== 'boolean') return 'dirty must be boolean';
      if (body.dnd !== undefined && typeof body.dnd !== 'boolean') return 'dnd must be boolean';
      return body as unknown as SimAction;
    case 'guestSelfCheckout':
      return str(body.orderId) ? (body as unknown as SimAction) : 'orderId is required';
    case 'raiseAlarm':
      if (!str(body.residenceId)) return 'residenceId is required';
      if (!['sos', 'smoke', 'low_power', 'water_leak'].includes(body.alarmType as string)) return 'invalid alarmType';
      return body as unknown as SimAction;
    case 'setFaults':
      return body.profile === 'none' || body.profile === 'uat' ? (body as unknown as SimAction) : "profile must be 'none' or 'uat'";
    default:
      return `unknown sim action: ${body.type}`;
  }
}

function errRes(e: unknown): Res {
  if (e instanceof GrmsError) return { status: 502, body: { code: e.code, message: e.message, traceId: e.traceId } };
  const msg = e instanceof Error ? e.message : String(e);
  return { status: /not mapped/i.test(msg) ? 409 : 500, body: { error: msg } };
}

export async function handleAkubelaRequest(svc: AkubelaServiceApi, method: string, path: string, body: unknown): Promise<Res> {
  const m = method.toUpperCase();
  const p = path.split('?')[0].replace(/\/+$/, '');
  if (!p.startsWith(PREFIX + '/') && p !== PREFIX) return bad(`No route for ${m} ${path}`, 404);
  const rel = p.slice(PREFIX.length);
  const seg = rel.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  const conn = svc.connector();
  const noConn = () => bad('Integration is off', 409);

  try {
    // GET /state
    if (m === 'GET' && rel === '/state') return { status: 200, body: svc.state() };
    // POST /test
    if (m === 'POST' && rel === '/test') return { status: 200, body: await svc.test() };
    // POST /mode
    if (m === 'POST' && rel === '/mode') {
      const mode = isObj(body) ? body.mode : undefined;
      if (!MODES.includes(mode as IntegrationMode)) return bad("mode must be 'real', 'sim' or 'off'");
      try {
        await svc.setMode(mode as IntegrationMode);
      } catch (e) {
        return bad(e instanceof Error ? e.message : String(e));
      }
      return { status: 200, body: svc.state() };
    }
    // PUT /settings
    if (m === 'PUT' && rel === '/settings') {
      const v = validateSettings(body);
      if ('error' in v) return bad(v.error);
      if (!conn) return noConn();
      conn.updateSettings(v.patch);
      return { status: 200, body: svc.state().settings };
    }
    // PUT /mapping
    if (m === 'PUT' && rel === '/mapping') {
      if (!isObj(body) || !str(body.roomId)) return bad('roomId is required');
      if (body.residenceId !== null && !str(body.residenceId)) return bad('residenceId must be a string or null');
      if (!conn) return noConn();
      conn.setMapping(body.roomId as string, body.residenceId as string | null);
      return { status: 200, body: { mappings: svc.state().mappings } };
    }
    // POST /reconcile, /poll
    if (m === 'POST' && rel === '/reconcile') {
      if (!conn) return noConn();
      const issues = await conn.reconcile();
      return { status: 200, body: { issues } };
    }
    if (m === 'POST' && rel === '/push') {
      if (!conn) return noConn();
      return { status: 200, body: { jobs: await conn.pushAll() } };
    }
    if (m === 'POST' && rel === '/poll') {
      if (!conn) return noConn();
      await conn.poll();
      return { status: 200, body: svc.state() };
    }
    // POST /jobs/:id/retry
    if (m === 'POST' && seg.length === 3 && seg[0] === 'jobs' && seg[2] === 'retry') {
      if (!conn) return noConn();
      if (!conn.getState().jobs.some((j) => j.id === seg[1])) return bad(`Job ${seg[1]} not found`, 404);
      conn.retryJob(seg[1]);
      return { status: 200, body: { ok: true } };
    }
    // GET /rooms/:roomId/devices
    if (m === 'GET' && seg.length === 3 && seg[0] === 'rooms' && seg[2] === 'devices') {
      if (!conn) return noConn();
      return { status: 200, body: { devices: await conn.listDevices(seg[1]) } };
    }
    // POST /devices/control
    if (m === 'POST' && rel === '/devices/control') {
      if (!isObj(body) || !str(body.device_id) || !str(body.ability_id) || !str(body.control)) return bad('device_id, ability_id and control are required');
      if (body.attribute !== undefined && !isObj(body.attribute)) return bad('attribute must be an object');
      if (!conn) return noConn();
      await conn.controlDevice(body as { device_id: string; ability_id: string; control: string; attribute?: Record<string, unknown> });
      return { status: 200, body: { ok: true } };
    }
    // GET /scenes
    if (m === 'GET' && rel === '/scenes') {
      if (!conn) return noConn();
      return { status: 200, body: { scenes: await conn.listScenes() } };
    }
    // POST /scenes/:sceneId/trigger
    if (m === 'POST' && seg.length === 3 && seg[0] === 'scenes' && seg[2] === 'trigger') {
      if (!isObj(body) || !Array.isArray(body.roomIds) || !body.roomIds.every((r) => typeof r === 'string')) return bad('roomIds must be an array of strings');
      if (!conn) return noConn();
      await conn.triggerScene(seg[1], body.roomIds as string[]);
      return { status: 200, body: { ok: true } };
    }
    // POST /sim
    if (m === 'POST' && rel === '/sim') {
      const sim = svc.simulator();
      if (!sim) return bad('Simulator actions are only available in sim mode', 409);
      const a = validateSim(body);
      if (typeof a === 'string') return bad(a);
      sim.apply(a);
      return { status: 200, body: { ok: true } };
    }
    return bad(`No route for ${m} ${path}`, 404);
  } catch (e) {
    return errRes(e);
  }
}
