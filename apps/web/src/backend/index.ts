import type { Backend } from './types';
import { HttpBackend } from './http';
import { LocalBackend } from './local';

export type { AkubelaResult, Backend, ConnectionState, OhipResult } from './types';

export const BACKEND_URL_KEY = 'opera-demo/backend-url';

/** Result of the last createBackend() call when a remote URL was configured but unreachable. */
export let lastBackendError: string | null = null;

/** Normalise to an origin-style base URL (no trailing slash); null if not an absolute http(s) URL. */
export function normalizeBackendUrl(s: string | null | undefined): string | null {
  const t = (s ?? '').trim();
  if (!/^https?:\/\//i.test(t)) return null;
  try {
    const u = new URL(t);
    return (u.origin + u.pathname).replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** The configured remote backend: `?backend=https://host` wins over the saved localStorage value. */
export function configuredBackendUrl(): string | null {
  const q = normalizeBackendUrl(new URLSearchParams(location.search).get('backend'));
  if (q) return q;
  try {
    return normalizeBackendUrl(localStorage.getItem(BACKEND_URL_KEY));
  } catch {
    return null;
  }
}

/**
 * Pick the backend: a configured remote URL (?backend=https://host or localStorage) is health-checked
 * and used if reachable, else we fall back to the in-browser engine and remember the error.
 * Otherwise VITE_BACKEND=local (GitHub Pages) runs the engine in the browser; else use the same-origin
 * Node server, falling back to local mode. `?backend=local|http` in the URL overrides the build default.
 */
export async function createBackend(): Promise<Backend> {
  lastBackendError = null;
  const override = new URLSearchParams(location.search).get('backend');
  const remote = override === 'local' || override === 'http' ? null : configuredBackendUrl();
  if (remote) {
    try {
      const r = await fetch(`${remote}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return new HttpBackend(remote);
      lastBackendError = `${remote}/api/health -> HTTP ${r.status}`;
    } catch (e) {
      lastBackendError = `${remote}: ${e instanceof Error ? e.message : String(e)}`;
    }
    console.warn(`[opera-demo] remote backend unreachable (${lastBackendError}) - running the PMS engine in the browser`);
    return new LocalBackend();
  }
  const mode = override ?? import.meta.env.VITE_BACKEND ?? 'http';
  if (mode === 'local') return new LocalBackend();
  try {
    const r = await fetch('/api/health', { signal: AbortSignal.timeout(1500) });
    if (r.ok) return new HttpBackend();
  } catch {
    /* fall through */
  }
  console.warn('[opera-demo] server not reachable - running the PMS engine in the browser');
  return new LocalBackend();
}
