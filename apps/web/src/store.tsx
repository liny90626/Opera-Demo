import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  applyChanges,
  type AkubelaState,
  roomViews,
  type Actor,
  type ChangeSet,
  type Command,
  type CommandResult,
  type OhipRequest,
  type RoomView,
  type Snapshot,
} from '@opera-demo/core';
import { createBackend, type AkubelaResult, type Backend, type ConnectionState, type OhipResult } from './backend';
import { LangContext, type Lang } from './i18n';

export type Role = 'frontdesk' | 'hk' | 'attendant' | 'integration';
export const ROLES: Record<Role, { en: string; zh: string; user: string; home: string }> = {
  frontdesk: { en: 'Front Desk Agent', zh: '前台接待', user: 'OC-FD1', home: '/front-desk/arrivals' },
  hk: { en: 'Housekeeping Supervisor', zh: '房务主管', user: 'OC-HK1', home: '/inventory/housekeeping-board' },
  attendant: { en: 'Room Attendant', zh: '客房服务员', user: 'HK-MOBILE', home: '/mobile' },
  integration: { en: 'Integration Admin', zh: '集成管理员', user: 'OC-INT', home: '/integration/sync-monitor' },
};

export interface ToastMsg {
  id: number;
  kind: 'success' | 'warning' | 'error' | 'info';
  text: string;
}

export interface ExecOptions {
  /** Don't toast errors (caller handles errorCode itself, e.g. offers Queue on ROOM_NOT_READY). */
  silentError?: boolean;
  /** Don't toast the success message. */
  silentSuccess?: boolean;
  actor?: Actor;
}

interface StoreValue {
  snapshot: Snapshot;
  views: RoomView[];
  viewById: Map<string, RoomView>;
  backendKind: 'http' | 'local';
  conn: ConnectionState;
  exec: (cmd: Command, opts?: ExecOptions) => Promise<CommandResult>;
  ohip: (req: OhipRequest) => Promise<OhipResult>;
  /** Akubela GRMS integration state (null = integration not available / not loaded yet). */
  akubela: AkubelaState | null;
  /** Call an integration REST route. `path` may be relative to /api/integrations/akubela (e.g. '/poll'). Toasts GRMS errors. */
  akubelaCall: (method: string, path: string, body?: unknown, opts?: { silent?: boolean }) => Promise<AkubelaResult>;
  role: Role;
  setRole: (r: Role) => void;
  lang: Lang;
  setLang: (l: Lang) => void;
  actor: Actor;
  toasts: ToastMsg[];
  toast: (kind: ToastMsg['kind'], text: string) => void;
  dismissToast: (id: number) => void;
  /** Increments whenever a change made by ANOTHER client arrives (drives the sync pulse). */
  remotePulse: number;
  /** roomId -> timestamp of a recent change (for flash highlighting, any origin). */
  recentRooms: Record<string, number>;
}

const Ctx = createContext<StoreValue | null>(null);

const readPref = <T extends string>(k: string, d: T): T => {
  try {
    return (localStorage.getItem(k) as T) ?? d;
  } catch {
    return d;
  }
};
const writePref = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
};

export function StoreProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const [backend, setBackend] = useState<Backend | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [conn, setConn] = useState<ConnectionState>('connecting');
  const [role, setRoleState] = useState<Role>(() => readPref<Role>('opera-demo/role', 'frontdesk'));
  const [lang, setLangState] = useState<Lang>(() => readPref<Lang>('opera-demo/lang', 'zh'));
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const [remotePulse, setRemotePulse] = useState(0);
  const [recentRooms, setRecentRooms] = useState<Record<string, number>>({});
  const [akubela, setAkubela] = useState<AkubelaState | null>(null);
  const toastId = useRef(0);

  const toast = useCallback((kind: ToastMsg['kind'], text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-4), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4500);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const b = await createBackend();
      if (cancelled) return;
      const s = await b.load();
      if (cancelled) return;
      setBackend(b);
      setSnapshot(s);
      const unsubAku = b.subscribeAkubela((st) => setAkubela(st));
      const unsubMain = b.subscribe(
        (cs: ChangeSet, origin) => {
          setSnapshot((prev) => {
            if (!prev) return prev;
            // version gap => we missed a change set (e.g. dropped SSE): re-sync the full snapshot
            if (!cs.reset && cs.version > prev.version + 1) {
              b.load().then((s2) => setSnapshot((cur) => (!cur || s2.version >= cur.version ? s2 : cur))).catch(() => undefined);
            }
            return applyChanges(prev, cs);
          });
          const ids = cs.reset ? [] : (cs.rooms ?? []).map((r) => r.id);
          if (ids.length) {
            const now = Date.now();
            setRecentRooms((m) => {
              const next: Record<string, number> = {};
              for (const [k, v] of Object.entries(m)) if (now - v < 3000) next[k] = v;
              for (const id of ids) next[id] = now;
              return next;
            });
          }
          if (origin === 'remote' && (cs.rooms || cs.reservations || cs.reset || cs.events)) setRemotePulse((p) => p + 1);
        },
        (st) => {
          setConn(st);
          // after a reconnect, re-sync the whole snapshot (we may have missed events)
          if (st === 'online') b.load().then((s2) => setSnapshot((prev) => (!prev || s2.version >= prev.version ? s2 : prev))).catch(() => undefined);
        },
      );
      unsub = () => {
        unsubMain();
        unsubAku();
      };
    })().catch((e) => {
      console.error(e);
      setConn('offline');
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  const actor: Actor = useMemo(() => ({ name: ROLES[role].user, source: role === 'attendant' ? 'MOBILE' : 'OPERA_UI' }), [role]);

  const exec = useCallback(
    async (cmd: Command, opts: ExecOptions = {}) => {
      if (!backend) throw new Error('backend not ready');
      let res: CommandResult;
      try {
        res = await backend.exec(cmd, opts.actor ?? actor);
      } catch (e) {
        toast('error', `Network error: ${String(e)}`);
        return { ok: false, error: String(e), errorCode: 'NETWORK', warnings: [], changes: null } as CommandResult;
      }
      if (!res.ok) {
        if (!opts.silentError) toast('error', res.error ?? 'Error');
      } else {
        if (res.message && !opts.silentSuccess) toast('success', res.message);
        res.warnings.forEach((w) => toast('warning', w));
      }
      return res;
    },
    [backend, actor, toast],
  );

  const ohip = useCallback(
    (req: OhipRequest) => {
      if (!backend) throw new Error('backend not ready');
      return backend.ohip(req);
    },
    [backend],
  );

  const akubelaCall = useCallback(
    async (method: string, path: string, body?: unknown, opts: { silent?: boolean } = {}) => {
      if (!backend) throw new Error('backend not ready');
      const full = path.startsWith('/api/') ? path : `/api/integrations/akubela${path}`;
      const res = await backend.akubela(method, full, body);
      if (res.status >= 400 || res.status === 0) {
        if (!opts.silent) {
          const b = (res.body ?? {}) as Record<string, unknown>;
          const msg = String(b.message ?? b.error ?? `HTTP ${res.status}`);
          const code = b.code ?? b.grmsCode;
          const trace = b.traceId ?? b.trace_id;
          toast('error', `GRMS: ${msg}${code != null ? ` [${String(code)}]` : ''}${trace ? ` trace ${String(trace)}` : ''}`);
        }
      } else {
        // state-bearing responses refresh immediately (SSE / broadcast will follow)
        const b = res.body as { state?: AkubelaState } | null;
        if (b?.state?.settings) setAkubela(b.state);
      }
      return res;
    },
    [backend, toast],
  );

  const setRole = useCallback((r: Role) => {
    setRoleState(r);
    writePref('opera-demo/role', r);
  }, []);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    writePref('opera-demo/lang', l);
  }, []);

  const views = useMemo(() => (snapshot ? roomViews(snapshot) : []), [snapshot]);
  const viewById = useMemo(() => new Map(views.map((v) => [v.id, v])), [views]);

  // test/debug hook used by the end-to-end acceptance script (harmless in production)
  useEffect(() => {
    (window as unknown as { __operaDemo?: unknown }).__operaDemo = { exec, snapshot, backend: backend?.kind };
  }, [exec, snapshot, backend]);

  if (!snapshot || !backend) return <LangContext.Provider value={lang}>{fallback}</LangContext.Provider>;

  const value: StoreValue = {
    snapshot,
    views,
    viewById,
    backendKind: backend.kind,
    conn,
    exec,
    ohip,
    akubela,
    akubelaCall,
    role,
    setRole,
    lang,
    setLang,
    actor,
    toasts,
    toast,
    dismissToast,
    remotePulse,
    recentRooms,
  };
  return (
    <LangContext.Provider value={lang}>
      <Ctx.Provider value={value}>{children}</Ctx.Provider>
    </LangContext.Provider>
  );
}

export function useStore(): StoreValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStore outside StoreProvider');
  return v;
}

/** true if the room changed within the last ~2.5 s (use for flash highlight). */
export function useIsRecent(roomId: string): boolean {
  const { recentRooms } = useStore();
  const ts = recentRooms[roomId];
  const [, force] = useState(0);
  useEffect(() => {
    if (!ts) return;
    const left = 2500 - (Date.now() - ts);
    if (left <= 0) return;
    const t = setTimeout(() => force((x) => x + 1), left);
    return () => clearTimeout(t);
  }, [ts]);
  return !!ts && Date.now() - ts < 2500;
}
