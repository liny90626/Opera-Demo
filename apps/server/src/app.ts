import express, { type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  PmsEngine,
  handleOhip,
  OHIP_ROUTES,
  createAkubelaService,
  handleAkubelaRequest,
  maskSecret,
  AKUBELA_API,
  type Actor,
  type AkubelaState,
  type ChangeSet,
  type Command,
  type GrmsTransport,
  type IntegrationMode,
  type PmsPort,
  type Snapshot,
} from '@opera-demo/core';
import { createRealTransport } from './akubela/client.ts';

export interface AkubelaOptions {
  /** Defaults: env AKUBELA_MODE, else real when credentials exist, else sim. */
  mode?: IntegrationMode;
  baseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  fetchImpl?: typeof fetch;
  roomMap?: Record<string, string>;
  hotelTimezone?: string;
  pollSeconds?: number;
  /** Start connector timers (drain/poll). Default false; src/index.ts enables it. */
  autoStart?: boolean;
  /** Persistence file (default: akubela.json next to dataFile; none without dataFile). */
  file?: string | null;
  /** Fully custom real transport (tests). */
  realTransportFactory?: (() => GrmsTransport) | null;
}

export interface AppOptions {
  /** JSON file used to persist state between restarts (omit for in-memory only). */
  dataFile?: string;
  /** Directory with the built web app to serve (apps/web/dist). */
  staticDir?: string;
  akubela?: AkubelaOptions;
}

export function parseRoomMap(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s ?? '').split(',')) {
    const [a, b] = part.split(':').map((x) => x.trim());
    if (a && b) out[a] = b;
  }
  return out;
}

export function createApp(opts: AppOptions = {}) {
  let initial: Snapshot | undefined;
  if (opts.dataFile && fs.existsSync(opts.dataFile)) {
    try {
      initial = JSON.parse(fs.readFileSync(opts.dataFile, 'utf8'));
    } catch {
      initial = undefined;
    }
  }
  const engine = new PmsEngine(initial);
  const clients = new Set<Response>();

  let saveTimer: NodeJS.Timeout | null = null;
  const persist = () => {
    if (!opts.dataFile || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      fs.mkdirSync(path.dirname(opts.dataFile!), { recursive: true });
      fs.writeFileSync(opts.dataFile!, JSON.stringify(engine.state));
    }, 500);
  };

  const broadcast = (cs: ChangeSet) => {
    const data = `event: change\ndata: ${JSON.stringify(cs)}\n\n`;
    for (const c of clients) c.write(data);
    persist();
  };

  // ── Akubela GRMS integration wiring
  const ak = opts.akubela ?? {};
  const env = process.env;
  const clientId = ak.clientId ?? env.AKUBELA_CLIENT_ID ?? '';
  const clientSecret = ak.clientSecret ?? env.AKUBELA_CLIENT_SECRET ?? '';
  const baseUrl = ak.baseUrl ?? env.AKUBELA_BASE_URL ?? 'https://api.cbcloud.uat.akubela.com';
  const hasCreds = !!(clientId && clientSecret);
  const envMode = env.AKUBELA_MODE as IntegrationMode | undefined;
  const mode: IntegrationMode = ak.mode ?? (envMode === 'real' || envMode === 'sim' || envMode === 'off' ? envMode : hasCreds ? 'real' : 'sim');
  const realFactory: (() => GrmsTransport) | null =
    ak.realTransportFactory !== undefined
      ? ak.realTransportFactory
      : hasCreds
        ? () => createRealTransport({ baseUrl, clientId, clientSecret, fetchImpl: ak.fetchImpl })
        : null;
  const akFile = ak.file !== undefined ? ak.file : opts.dataFile ? path.join(path.dirname(opts.dataFile), 'akubela.json') : null;

  let persisted: { mode?: IntegrationMode; settings?: AkubelaState['settings']; mappings?: AkubelaState['mappings']; links?: AkubelaState['links'] } = {};
  if (akFile && fs.existsSync(akFile)) {
    try {
      persisted = JSON.parse(fs.readFileSync(akFile, 'utf8'));
    } catch {
      persisted = {};
    }
  }
  const envSettings: Partial<AkubelaState['settings']> = {};
  const tz = ak.hotelTimezone ?? env.AKUBELA_HOTEL_TZ;
  if (tz) envSettings.hotelTimezone = tz;
  const poll = ak.pollSeconds ?? (env.AKUBELA_POLL_SECONDS ? Number(env.AKUBELA_POLL_SECONDS) : undefined);
  if (poll && poll > 0) envSettings.pollSeconds = poll;

  let akPushTimer: NodeJS.Timeout | null = null;
  let akSaveTimer: NodeJS.Timeout | null = null;
  const akPush = () => {
    if (akPushTimer) return;
    akPushTimer = setTimeout(() => {
      akPushTimer = null;
      if (!clients.size) return;
      const data = `event: ${AKUBELA_API.sseEvent}\ndata: ${JSON.stringify(svc.state())}\n\n`;
      for (const c of clients) c.write(data);
    }, 300);
    akPushTimer.unref();
  };
  const akSave = () => {
    if (!akFile) return;
    try {
      const s = svc.state();
      fs.mkdirSync(path.dirname(akFile), { recursive: true });
      // settings + mappings + links only; never secrets, logs or jobs
      fs.writeFileSync(akFile, JSON.stringify({ mode: s.mode, settings: s.settings, mappings: s.mappings.filter((m) => m.origin === 'manual'), links: s.links }));
    } catch { /* best effort */ }
  };
  const akPersist = () => {
    if (!akFile || akSaveTimer) return;
    akSaveTimer = setTimeout(() => {
      akSaveTimer = null;
      akSave();
    }, 500);
    akSaveTimer.unref();
  };

  const pms: PmsPort = {
    snapshot: () => engine.state,
    exec(cmd, actor) {
      const result = engine.exec(cmd, actor);
      if (result.changes) {
        broadcast(result.changes);
        if (result.changes.events?.length) svc.onPmsEvents(result.changes.events);
      }
      return result;
    },
  };

  const initialMode: IntegrationMode = mode;
  const svc = createAkubelaService({
    pms,
    realTransportFactory: realFactory,
    initialMode,
    initialState: {
      settings: { ...(persisted.settings ?? ({} as AkubelaState['settings'])), ...envSettings } as AkubelaState['settings'],
      mappings: persisted.mappings,
      // links only make sense against the real GRMS (the simulator starts empty on each boot)
      links: initialMode === 'real' && persisted.mode === 'real' ? persisted.links : undefined,
    },
    roomMap: { ...parseRoomMap(env.AKUBELA_ROOM_MAP), ...(ak.roomMap ?? {}) },
    baseUrl: initialMode === 'real' ? baseUrl : null,
    clientIdMasked: maskSecret(clientId),
    autoStart: ak.autoStart ?? false,
    onStateChange: () => {
      akPush();
      akPersist();
    },
    onNotice: (n) => {
      const data = `event: akubela-notice\ndata: ${JSON.stringify(n)}\n\n`;
      for (const c of clients) c.write(data);
    },
  });

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-app-key, x-hotelid, x-externalsystem, x-request-id, x-originating-application');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, version: engine.state.version, clients: clients.size }));
  app.get('/api/snapshot', (_req, res) => res.json(engine.state));
  app.get('/api/ohip-routes', (_req, res) => res.json(OHIP_ROUTES()));

  app.post('/api/commands', (req: Request, res: Response) => {
    const { command, actor } = req.body as { command: Command; actor?: Actor };
    if (!command || typeof command.type !== 'string') return res.status(400).json({ ok: false, error: 'command is required', warnings: [], changes: null });
    const result = engine.exec(command, actor ?? { name: 'OC-TW1', source: 'OPERA_UI' });
    if (result.changes) {
      broadcast(result.changes);
      if (result.changes.events?.length) svc.onPmsEvents(result.changes.events);
    }
    res.status(result.ok ? 200 : 422).json(result);
  });

  app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ version: engine.state.version })}\n\n`);
    res.write(`event: ${AKUBELA_API.sseEvent}\ndata: ${JSON.stringify(svc.state())}\n\n`);
    clients.add(res);
    const hb = setInterval(() => res.write(`: ping\n\n`), 20000);
    req.on('close', () => {
      clearInterval(hb);
      clients.delete(res);
    });
  });

  // OHIP-style REST façade (+ polling API)
  app.all(['/oauth/*', '/hsk/*', '/fof/*', '/csh/*', '/api/events'], (req, res) => {
    const out = handleOhip(engine, {
      method: req.method,
      path: req.path,
      query: req.query as Record<string, string>,
      headers: req.headers as Record<string, string>,
      body: req.body,
    });
    for (const cs of out.changes) {
      broadcast(cs);
      if (cs.events?.length) svc.onPmsEvents(cs.events);
    }
    res.status(out.status).json(out.body);
  });

  // Akubela GRMS integration REST (logic in @opera-demo/core handleAkubelaRequest)
  app.all('/api/integrations/akubela/*', async (req, res) => {
    const out = await handleAkubelaRequest(svc, req.method, req.path, req.body);
    res.status(out.status).json(out.body);
  });

  if (opts.staticDir && fs.existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir));
    app.get('*', (_req, res) => res.sendFile(path.join(opts.staticDir!, 'index.html')));
  }

  /** Stop timers (connector, debounced writers). Call when the HTTP server closes. */
  const dispose = () => {
    svc.dispose();
    for (const t of [akPushTimer, akSaveTimer, saveTimer]) if (t) clearTimeout(t);
    akPushTimer = akSaveTimer = saveTimer = null;
    akSave();
    for (const c of clients) c.end();
    clients.clear();
  };

  return { app, engine, clients, akubela: svc, dispose };
}
