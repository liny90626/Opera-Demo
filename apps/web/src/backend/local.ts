import { PmsEngine, applyChanges, handleOhip, createAkubelaService, handleAkubelaRequest, type AkubelaServiceApi, type AkubelaState, type Actor, type ChangeSet, type Command, type CommandResult, type OhipRequest, type Snapshot } from '@opera-demo/core';
import type { AkubelaResult, Backend, ConnectionState, OhipResult } from './types';

const KEY = 'opera-demo/state/v2';
const CHANNEL = 'opera-demo/sync/v1';
const AKU_CHANNEL = 'opera-demo/akubela/v1';
const LEADER_KEY = 'opera-demo/akubela/leader';
const LEADER_STALE_MS = 6000;
const LEADER_BEAT_MS = 2000;
const RPC_TIMEOUT_MS = 5000;

type AkuMsg =
  | { t: 'state'; state: AkubelaState }
  | { t: 'hello' }
  | { t: 'req'; id: string; method: string; path: string; body?: unknown }
  | { t: 'res'; id: string; result: AkubelaResult };

function readStored(): Snapshot | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return undefined;
    const s = JSON.parse(raw) as Snapshot;
    return s?.rooms?.length && s.subscribers ? s : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs the PMS engine inside the browser (GitHub Pages build, no server).
 * State persists in localStorage; BroadcastChannel keeps every open tab in sync,
 * so "front desk" and "mobile attendant" tabs behave like separate clients of one PMS.
 */
export class LocalBackend implements Backend {
  readonly kind = 'local' as const;
  private engine: PmsEngine;
  private channel: BroadcastChannel | null = null;
  private listeners = new Set<(cs: ChangeSet, origin: 'self' | 'remote') => void>();

  // ---- Akubela GRMS (in-browser service, only the leader tab runs the connector)
  private tabId = Math.random().toString(36).slice(2);
  private akuChannel: BroadcastChannel | null = null;
  private svc: AkubelaServiceApi | null = null;
  private leader = false;
  private akuError: string | null = null;
  private akuState: AkubelaState | null = null;
  private akuListeners = new Set<(s: AkubelaState) => void>();
  private akuPending = new Map<string, (r: AkubelaResult) => void>();
  private akuTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.engine = new PmsEngine(readStored());
    this.initAkubela();
    try {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = (e) => {
        const cs = e.data as ChangeSet;
        this.engine.state = applyChanges(this.engine.state, cs);
        this.feedAkubela(cs);
        this.listeners.forEach((l) => l(cs, 'remote'));
      };
    } catch {
      this.channel = null;
    }
  }

  private persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.engine.state));
    } catch {
      /* storage full or blocked: keep running in memory */
    }
  }

  private publish(cs: ChangeSet) {
    this.persist();
    this.channel?.postMessage(cs);
    this.feedAkubela(cs);
    // simulate network latency so the realtime "sync pulse" is visible
    this.listeners.forEach((l) => l(cs, 'self'));
  }

  async load(): Promise<Snapshot> {
    const fresh = readStored();
    if (fresh && fresh.version > this.engine.state.version) this.engine.state = fresh;
    return structuredClone(this.engine.state);
  }

  async exec(cmd: Command, actor: Actor): Promise<CommandResult> {
    const res = this.engine.exec(cmd, actor);
    if (res.changes) this.publish(structuredClone(res.changes));
    return structuredClone({ ...res, changes: res.changes });
  }

  async ohip(req: OhipRequest): Promise<OhipResult> {
    const t0 = performance.now();
    const out = handleOhip(this.engine, req);
    for (const cs of out.changes) this.publish(structuredClone(cs));
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 120));
    return { status: out.status, body: structuredClone(out.body), durationMs: Math.round(performance.now() - t0) };
  }

  subscribe(onChange: (cs: ChangeSet, origin: 'self' | 'remote') => void, onState: (s: ConnectionState) => void) {
    this.listeners.add(onChange);
    onState('online');
    return () => {
      this.listeners.delete(onChange);
    };
  }

  // ------------------------------------------------------------------ Akubela

  private feedAkubela(cs: ChangeSet) {
    if (!this.svc || !cs.events?.length) return;
    const events = cs.events;
    queueMicrotask(() => {
      try {
        this.svc?.onPmsEvents(events);
      } catch (e) {
        console.warn('[akubela] onPmsEvents failed', e);
      }
    });
  }

  /** Simple leader election: a localStorage heartbeat; the freshest owner wins. */
  private tryLead(): boolean {
    try {
      const now = Date.now();
      const raw = localStorage.getItem(LEADER_KEY);
      const cur = raw ? (JSON.parse(raw) as { id: string; ts: number }) : null;
      if (cur && cur.id !== this.tabId && now - cur.ts <= LEADER_STALE_MS) return false;
      localStorage.setItem(LEADER_KEY, JSON.stringify({ id: this.tabId, ts: now }));
      const again = JSON.parse(localStorage.getItem(LEADER_KEY) ?? 'null') as { id: string } | null;
      return again?.id === this.tabId;
    } catch {
      return true; // storage blocked: single-tab assumption
    }
  }

  private initAkubela() {
    try {
      this.akuChannel = new BroadcastChannel(AKU_CHANNEL);
      this.akuChannel.onmessage = (e) => this.onAkuMsg(e.data as AkuMsg);
    } catch {
      this.akuChannel = null;
    }
    const beat = () => {
      const lead = this.tryLead();
      if (lead && !this.leader) {
        this.leader = true;
        this.startService();
      } else if (!lead && this.leader) {
        this.leader = false;
        this.stopService();
        this.akuChannel?.postMessage({ t: 'hello' } satisfies AkuMsg);
      }
    };
    beat();
    if (!this.leader) this.akuChannel?.postMessage({ t: 'hello' } satisfies AkuMsg);
    setInterval(beat, LEADER_BEAT_MS);
    addEventListener('beforeunload', () => {
      try {
        const cur = JSON.parse(localStorage.getItem(LEADER_KEY) ?? 'null') as { id: string } | null;
        if (cur?.id === this.tabId) localStorage.removeItem(LEADER_KEY);
      } catch {
        /* ignore */
      }
    });
  }

  private startService() {
    try {
      this.svc = createAkubelaService({
        pms: {
          snapshot: () => this.engine.state,
          exec: (cmd, actor) => {
            const res = this.engine.exec(cmd, actor);
            if (res.changes) this.publish(structuredClone(res.changes)); // publish() also feeds the events to the service
            return res;
          },
        },
        realTransportFactory: null,
        initialMode: 'sim',
        autoStart: true,
        onStateChange: (st) => this.pushAkuState(st),
      });
      this.akuError = null;
      this.pushAkuState(this.svc.state());
    } catch (e) {
      this.svc = null;
      this.akuError = e instanceof Error ? e.message : String(e);
      console.warn('[akubela] service unavailable:', this.akuError);
    }
  }

  private stopService() {
    try {
      this.svc?.dispose();
    } catch {
      /* ignore */
    }
    this.svc = null;
  }

  /** Throttled fan-out of the integration state to local listeners and follower tabs. */
  private pushAkuState(st: AkubelaState) {
    this.akuState = st;
    if (this.akuTimer) return;
    this.akuTimer = setTimeout(() => {
      this.akuTimer = null;
      const cur = this.akuState;
      if (!cur) return;
      const copy = structuredClone(cur);
      this.akuListeners.forEach((l) => l(copy));
      if (this.leader) this.akuChannel?.postMessage({ t: 'state', state: copy } satisfies AkuMsg);
    }, 200);
  }

  private onAkuMsg(m: AkuMsg) {
    if (m.t === 'state') {
      if (this.leader) return;
      this.akuState = m.state;
      this.akuListeners.forEach((l) => l(m.state));
    } else if (m.t === 'hello') {
      if (this.leader && this.svc) this.pushAkuState(this.svc.state());
    } else if (m.t === 'req') {
      if (!this.leader) return;
      void this.runAkubela(m.method, m.path, m.body).then((result) => this.akuChannel?.postMessage({ t: 'res', id: m.id, result } satisfies AkuMsg));
    } else if (m.t === 'res') {
      const r = this.akuPending.get(m.id);
      if (r) {
        this.akuPending.delete(m.id);
        r(m.result);
      }
    }
  }

  private async runAkubela(method: string, path: string, body: unknown): Promise<AkubelaResult> {
    if (!this.svc) return { status: 501, body: { error: this.akuError ?? 'Akubela integration is not available' } };
    try {
      const r = await handleAkubelaRequest(this.svc, method, path, body);
      return structuredClone(r);
    } catch (e) {
      return { status: 500, body: { error: e instanceof Error ? e.message : String(e) } };
    }
  }

  async akubela(method: string, path: string, body?: unknown): Promise<AkubelaResult> {
    if (this.leader) return this.runAkubela(method, path, body);
    if (!this.akuChannel) return { status: 501, body: { error: 'Akubela integration is not available' } };
    const id = Math.random().toString(36).slice(2);
    return new Promise<AkubelaResult>((resolve) => {
      const timer = setTimeout(() => {
        this.akuPending.delete(id);
        resolve({ status: 503, body: { error: 'Akubela leader tab did not respond' } });
      }, RPC_TIMEOUT_MS);
      this.akuPending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.akuChannel?.postMessage({ t: 'req', id, method, path, body } satisfies AkuMsg);
    });
  }

  subscribeAkubela(onState: (s: AkubelaState) => void) {
    this.akuListeners.add(onState);
    if (this.akuState) onState(this.akuState);
    return () => {
      this.akuListeners.delete(onState);
    };
  }
}
