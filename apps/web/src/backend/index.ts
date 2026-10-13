import type { Backend } from './types';
import { HttpBackend } from './http';
import { LocalBackend } from './local';

export type { AkubelaResult, Backend, ConnectionState, OhipResult } from './types';

/**
 * Pick the backend: VITE_BACKEND=local (GitHub Pages) runs the engine in the browser;
 * otherwise use the Node server, falling back to local mode if it is unreachable.
 * `?backend=local|http` in the URL overrides both.
 */
export async function createBackend(): Promise<Backend> {
  const override = new URLSearchParams(location.search).get('backend');
  const mode = override ?? import.meta.env.VITE_BACKEND ?? 'http';
  if (mode === 'local') return new LocalBackend();
  try {
    const r = await fetch('/api/health', { signal: AbortSignal.timeout(1500) });
    if (r.ok) return new HttpBackend();
  } catch {
    /* fall through */
  }
  console.warn('[opera-demo] server not reachable – running the PMS engine in the browser');
  return new LocalBackend();
}
