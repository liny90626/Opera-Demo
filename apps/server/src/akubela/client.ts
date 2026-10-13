// Real GRMS transport: OAuth2 client-credentials + single hotel-commands endpoint. Never logs secrets.
import { randomBytes } from 'node:crypto';
import { GrmsError, type GrmsTransport } from '@opera-demo/core';

export interface RealTransportOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

const TOKEN_PATH = '/api/v1.0/invoke/open-ability/method/oauth2/token';
const CMD_PATH = '/api/v1.0/invoke/open-ability/method/hotel-commands';
const SCOPE = 'hotel';
/** Codes that mean "token invalid/expired" -> refresh and retry. */
const AUTH_CODES = new Set([20000401, 20000402, 20000403, 40100000, 40100001]);

interface Token {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number; // epoch ms (real expiry)
  refreshAt: number; // expiry - 120s
}

function newCommandId(): string {
  return 'c' + randomBytes(16).toString('hex');
}

export function createRealTransport(o: RealTransportOptions): GrmsTransport {
  const f = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const timeoutMs = o.timeoutMs ?? 15000;
  const base = o.baseUrl.replace(/\/+$/, '');
  let token: Token | null = null;
  let inflight: Promise<Token> | null = null;

  const redact = (s: string) => {
    let out = s;
    for (const secret of [o.clientSecret, token?.accessToken, token?.refreshToken]) if (secret) out = out.split(secret).join('***');
    return out;
  };

  async function http(path: string, init: RequestInit): Promise<{ status: number; json: any }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await f(base + path, { ...init, signal: ctrl.signal });
      const text = await res.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json: json ?? { _raw: text.slice(0, 200) } };
    } catch (e) {
      const aborted = (e as Error)?.name === 'AbortError' || ctrl.signal.aborted;
      throw new GrmsError(aborted ? `GRMS request timed out after ${timeoutMs} ms` : `GRMS network error: ${redact(String((e as Error)?.message ?? e))}`, aborted ? -2 : -1, undefined, undefined, true);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Convert a failed envelope/HTTP response into a GrmsError. */
  function toError(status: number, json: any): GrmsError {
    const r = json?.result;
    const code = typeof r?.code === 'number' ? r.code : typeof json?.code === 'number' ? json.code : status || -1;
    const message = redact(String(r?.message ?? json?.message ?? json?.error_description ?? json?.error ?? json?._raw ?? `HTTP ${status}`));
    const traceId: string | undefined = r?.detail?.trace_id ?? json?.detail?.trace_id;
    const retryable = status >= 500 || AUTH_CODES.has(code) || status === 401;
    return new GrmsError(message, code, traceId, status, retryable);
  }

  async function requestToken(form: Record<string, string>): Promise<Token> {
    const { status, json } = await http(TOKEN_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
    const r = json?.result ?? json;
    if (status >= 400 || json?.success === false || !r?.access_token) throw toError(status, json);
    const ttl = Number(r.expires_in) > 0 ? Number(r.expires_in) : 3600;
    const t = now();
    return {
      accessToken: String(r.access_token),
      refreshToken: r.refresh_token ? String(r.refresh_token) : null,
      expiresAt: t + ttl * 1000,
      refreshAt: t + Math.max(0, ttl - 120) * 1000,
    };
  }

  const fresh = () =>
    requestToken({ grant_type: 'client_credentials', client_id: o.clientId, client_secret: o.clientSecret, scope: SCOPE });

  async function acquire(force: boolean): Promise<Token> {
    if (!force && token && now() < token.refreshAt) return token;
    if (inflight) return inflight;
    const old = token;
    inflight = (async () => {
      try {
        if (old?.refreshToken) {
          try {
            token = await requestToken({ grant_type: 'refresh_token', refresh_token: old.refreshToken, client_id: o.clientId, client_secret: o.clientSecret, scope: SCOPE });
            return token;
          } catch {
            /* fall back to a new client-credentials grant */
          }
        }
        token = await fresh();
        return token;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  async function send(command: string, param: Record<string, unknown>, id: string, t: Token) {
    return http(CMD_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${t.accessToken}` },
      body: JSON.stringify({ command, id, param }),
    });
  }

  return {
    kind: 'real',
    tokenInfo: () => (token && now() < token.expiresAt ? { expiresAt: token.expiresAt, scope: SCOPE } : null),
    async call<T = unknown>(command: string, param: Record<string, unknown>, opts?: { commandId?: string }): Promise<T> {
      const id = opts?.commandId ?? newCommandId();
      let t = await acquire(false);
      let { status, json } = await send(command, param, id, t);
      const failed = (s: number, j: any) => s >= 400 || j?.success === false;
      if (failed(status, json)) {
        const e = toError(status, json);
        if (status === 401 || AUTH_CODES.has(e.code)) {
          t = await acquire(true);
          ({ status, json } = await send(command, param, id, t));
          if (!failed(status, json)) return json?.result as T;
          throw toError(status, json);
        }
        throw e;
      }
      return json?.result as T;
    },
  };
}
