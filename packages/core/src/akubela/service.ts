// Akubela service: holds the integration mode, builds transport + connector, supports live mode switching.
import type { BusinessEvent } from '../types.ts';
import { createAkubelaConnector } from './connector.ts';
import { createGrmsSimulator } from './simulator.ts';
import {
  DEFAULT_SETTINGS,
  GrmsError,
  type AkubelaConnectorApi,
  type AkubelaServiceApi,
  type AkubelaServiceDeps,
  type AkubelaState,
  type GrmsSimulatorApi,
  type GrmsTransport,
  type IntegrationMode,
} from './contract.ts';

type LastError = NonNullable<AkubelaState['lastError']>;

function toLastError(e: unknown): LastError {
  if (e instanceof GrmsError) return { code: e.code, message: e.message, traceId: e.traceId };
  return { code: -1, message: e instanceof Error ? e.message : String(e) };
}

function countResidences(result: unknown): number {
  if (!Array.isArray(result)) return 0;
  let n = 0;
  for (const b of result as { floors?: { residences?: unknown[] }[] }[]) for (const f of b.floors ?? []) n += f.residences?.length ?? 0;
  return n;
}

export function createAkubelaService(deps: AkubelaServiceDeps): AkubelaServiceApi {
  const now = deps.now ?? Date.now;
  let mode: IntegrationMode = deps.initialMode;
  let transport: GrmsTransport | null = null;
  let sim: GrmsSimulatorApi | null = null;
  let connector: AkubelaConnectorApi | null = null;
  let extraError: LastError | null = null;
  let offVersion = 0;
  let offSettings = { ...DEFAULT_SETTINGS, ...(deps.initialState?.settings ?? {}) };
  let offMappings = deps.initialState?.mappings ?? [];
  let disposed = false;

  const build = (m: IntegrationMode, initialState: Partial<AkubelaState> | undefined) => {
    if (m === 'real') {
      if (!deps.realTransportFactory) throw new Error('Real GRMS transport is not available in this environment');
      transport = deps.realTransportFactory();
      sim = null;
    } else if (m === 'sim') {
      sim = createGrmsSimulator(deps.pms.snapshot(), { now });
      transport = sim;
    } else {
      transport = null;
      sim = null;
    }
    mode = m;
    if (m === 'off') {
      connector = null;
      return;
    }
    connector = createAkubelaConnector({
      transport,
      mode: m,
      pms: deps.pms,
      now: deps.now,
      onStateChange: deps.onStateChange ? () => deps.onStateChange!(state()) : undefined,
      onNotice: deps.onNotice,
      initialState,
      roomMap: deps.roomMap,
      baseUrl: m === 'real' ? deps.baseUrl ?? null : null,
      clientIdMasked: m === 'real' ? deps.clientIdMasked ?? null : null,
    });
  };

  const refresh = async () => {
    if (!connector) return;
    try {
      await connector.refreshMasterData();
    } catch (e) {
      extraError = toLastError(e);
    }
  };

  const offState = (): AkubelaState => ({
    mode: 'off',
    baseUrl: null,
    clientIdMasked: null,
    connected: false,
    token: null,
    lastPollAt: null,
    lastError: null,
    settings: offSettings,
    residences: [],
    roomTypes: [],
    mappings: offMappings,
    links: [],
    grmsRooms: {},
    externalOrders: [],
    jobs: [],
    apiLog: [],
    alarms: [],
    stats: { jobsSucceeded: 0, jobsFailed: 0, inboundApplied: 0 },
    version: offVersion,
  });

  const state = (): AkubelaState => {
    if (!connector) return offState();
    const s = connector.getState();
    return extraError && !s.lastError ? { ...s, lastError: extraError } : s;
  };

  // initial build: real without a factory degrades to sim
  try {
    build(deps.initialMode, deps.initialState);
  } catch {
    build('sim', deps.initialState);
  }
  if (deps.autoStart) (connector as AkubelaConnectorApi | null)?.start();

  return {
    state,
    connector: () => connector,
    simulator: () => sim,

    async setMode(next) {
      if (disposed) return;
      if (next === 'real' && !deps.realTransportFactory) throw new Error('Real GRMS transport is not configured (set AKUBELA_CLIENT_ID / AKUBELA_CLIENT_SECRET)');
      const prev = connector ? connector.getState() : null;
      connector?.stop();
      const carry: Partial<AkubelaState> = { settings: prev?.settings ?? offSettings, mappings: prev?.mappings ?? offMappings };
      if (prev) {
        offSettings = prev.settings;
        offMappings = prev.mappings;
      }
      extraError = null;
      offVersion++;
      build(next, carry);
      if (connector) {
        await refresh();
        if (deps.autoStart) connector.start();
      }
      deps.onStateChange?.(state());
    },

    async test() {
      if (!transport) return { ok: false, message: 'Integration is off', residences: 0 };
      try {
        const result = await transport.call('get_room_list', {});
        const residences = countResidences(result);
        return { ok: true, message: `Token OK, ${residences} residence(s) found (${transport.kind})`, residences };
      } catch (e) {
        const err = toLastError(e);
        return { ok: false, message: err.message, residences: 0, code: err.code, traceId: err.traceId };
      }
    },

    onPmsEvents(events: BusinessEvent[]) {
      if (connector && events.length) connector.handleEvents(events);
    },

    dispose() {
      disposed = true;
      connector?.stop();
    },
  };
}
