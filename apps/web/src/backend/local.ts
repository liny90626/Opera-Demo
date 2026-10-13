import { PmsEngine, applyChanges, handleOhip, type Actor, type ChangeSet, type Command, type CommandResult, type OhipRequest, type Snapshot } from '@opera-demo/core';
import type { Backend, ConnectionState, OhipResult } from './types';

const KEY = 'opera-demo/state/v1';
const CHANNEL = 'opera-demo/sync/v1';

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

  constructor() {
    this.engine = new PmsEngine(readStored());
    try {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = (e) => {
        const cs = e.data as ChangeSet;
        this.engine.state = applyChanges(this.engine.state, cs);
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
}
