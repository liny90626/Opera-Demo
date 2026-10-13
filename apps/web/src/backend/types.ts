import type { AkubelaState, Actor, ChangeSet, Command, CommandResult, OhipRequest, Snapshot } from '@opera-demo/core';

export type ConnectionState = 'connecting' | 'online' | 'offline';

export interface OhipResult {
  status: number;
  body: unknown;
  durationMs: number;
}

/** Transport-agnostic backend used by the UI. */
export interface Backend {
  readonly kind: 'http' | 'local';
  load(): Promise<Snapshot>;
  exec(cmd: Command, actor: Actor): Promise<CommandResult>;
  /** Send an OHIP-style REST request (API console). */
  ohip(req: OhipRequest): Promise<OhipResult>;
  /** Subscribe to change sets made by anybody (including this client). */
  /** Akubela GRMS integration REST call (path = full `/api/integrations/akubela/...`). status 501 = unavailable. */
  akubela(method: string, path: string, body?: unknown): Promise<AkubelaResult>;
  /** Subscribe to Akubela integration state pushes (SSE `event: akubela` / in-browser service). */
  subscribeAkubela(onState: (s: AkubelaState) => void): () => void;
  subscribe(onChange: (cs: ChangeSet, origin: 'self' | 'remote') => void, onState: (s: ConnectionState) => void): () => void;
}

export interface AkubelaResult {
  status: number;
  body: unknown;
}
