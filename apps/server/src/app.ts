import express, { type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { PmsEngine, handleOhip, OHIP_ROUTES, type Actor, type ChangeSet, type Command, type Snapshot } from '@opera-demo/core';

export interface AppOptions {
  /** JSON file used to persist state between restarts (omit for in-memory only). */
  dataFile?: string;
  /** Directory with the built web app to serve (apps/web/dist). */
  staticDir?: string;
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
    if (result.changes) broadcast(result.changes);
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
    for (const cs of out.changes) broadcast(cs);
    res.status(out.status).json(out.body);
  });

  if (opts.staticDir && fs.existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir));
    app.get('*', (_req, res) => res.sendFile(path.join(opts.staticDir!, 'index.html')));
  }

  return { app, engine, clients };
}
