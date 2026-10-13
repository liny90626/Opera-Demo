import type { AkubelaState, Actor, ChangeSet, Command, CommandResult, OhipRequest, Snapshot } from '@opera-demo/core';
import type { AkubelaResult, Backend, ConnectionState, OhipResult } from './types';

/** Talks to apps/server: REST commands + Server-Sent Events for realtime sync. */
export class HttpBackend implements Backend {
  readonly kind = 'http' as const;
  private pendingSelf = new Set<number>();
  private akuListeners = new Set<(s: AkubelaState) => void>();
  constructor(private base = '') {}

  async load(): Promise<Snapshot> {
    const r = await fetch(`${this.base}/api/snapshot`);
    if (!r.ok) throw new Error(`snapshot ${r.status}`);
    return r.json();
  }

  async exec(command: Command, actor: Actor): Promise<CommandResult> {
    const r = await fetch(`${this.base}/api/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command, actor }),
    });
    const res = (await r.json()) as CommandResult;
    if (res.changes) this.pendingSelf.add(res.changes.version);
    return res;
  }

  async ohip(req: OhipRequest): Promise<OhipResult> {
    const t0 = performance.now();
    const qs = req.query && Object.keys(req.query).length ? `?${new URLSearchParams(req.query as Record<string, string>)}` : '';
    const r = await fetch(`${this.base}${req.path}${qs}`, {
      method: req.method,
      headers: { 'content-type': 'application/json', ...(req.headers as Record<string, string>) },
      body: req.method === 'GET' || req.body === undefined ? undefined : JSON.stringify(req.body),
    });
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      body = null;
    }
    return { status: r.status, body, durationMs: Math.round(performance.now() - t0) };
  }

  async akubela(method: string, path: string, body?: unknown): Promise<AkubelaResult> {
    try {
      const r = await fetch(`${this.base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body),
      });
      let b: unknown = null;
      try {
        b = await r.json();
      } catch {
        b = null;
      }
      return { status: r.status, body: b };
    } catch (e) {
      return { status: 0, body: { error: String(e) } };
    }
  }

  subscribeAkubela(onState: (s: AkubelaState) => void) {
    this.akuListeners.add(onState);
    void this.akubela('GET', '/api/integrations/akubela/state').then((r) => {
      if (r.status === 200 && r.body && typeof r.body === 'object' && 'settings' in r.body) onState(r.body as AkubelaState);
    });
    return () => {
      this.akuListeners.delete(onState);
    };
  }

  subscribe(onChange: (cs: ChangeSet, origin: 'self' | 'remote') => void, onState: (s: ConnectionState) => void) {
    let es: EventSource | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      onState('connecting');
      es = new EventSource(`${this.base}/api/stream`);
      es.addEventListener('hello', () => onState('online'));
      es.addEventListener('akubela', (e) => {
        try {
          const st = JSON.parse((e as MessageEvent).data) as AkubelaState;
          this.akuListeners.forEach((l) => l(st));
        } catch {
          /* ignore malformed push */
        }
      });
      es.addEventListener('change', (e) => {
        const cs = JSON.parse((e as MessageEvent).data) as ChangeSet;
        const self = this.pendingSelf.delete(cs.version);
        onChange(cs, self ? 'self' : 'remote');
      });
      es.onerror = () => {
        onState('offline');
        es?.close();
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }
}
