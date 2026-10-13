/** Shared helpers for the Akubela GRMS integration UI (page tabs + RoomDetailDrawer GRMS section). */
import { useCallback, useEffect, useState } from 'react';
import type { GrmsAbility, GrmsDevice, GrmsOrderState, IntegrationMode, JobStatus, RoomView } from '@opera-demo/core';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { Button, cx } from '../../components/ui';

export const fmtClock = (iso: string | number | null | undefined) => (iso ? new Date(iso).toLocaleTimeString('en-GB') : '—');
export const fmtStamp = (iso: string | number | null | undefined) => (iso ? new Date(iso).toLocaleString('en-GB', { hour12: false }) : '—');

/** PMS-side expectation of the GRMS flags. */
export function pmsFlags(v: RoomView) {
  return { dirty: v.hkStatus === 'Dirty', occupied: v.foStatus === 'Occupied', dnd: v.serviceStatus === 'DND' };
}

export function Flag({ v, bad }: { v: boolean | null | undefined; bad?: boolean }) {
  const t = useT();
  if (v == null) return <span className="subtle">—</span>;
  return <span className={cx('badge', bad ? 'err' : v ? 'info' : 'neutral')}>{v ? t('Yes', '是') : t('No', '否')}</span>;
}

export function ModeBadge({ mode }: { mode: IntegrationMode }) {
  const t = useT();
  const label = mode === 'real' ? t('Real UAT', '真实 UAT') : mode === 'sim' ? t('Simulator', '模拟器') : t('Off', '关闭');
  return <span className={cx('badge', mode === 'real' ? 'ok' : mode === 'sim' ? 'warn' : 'neutral')}>{label}</span>;
}

export function JobBadge({ status }: { status: JobStatus }) {
  const cls: Record<JobStatus, string> = { PENDING: 'info', RUNNING: 'warn', SUCCEEDED: 'ok', FAILED: 'err', DEAD: 'err', SKIPPED: 'neutral' };
  return <span className={cx('badge', cls[status])}>{status}</span>;
}

export function OrderStateBadge({ state }: { state: GrmsOrderState }) {
  const cls: Record<GrmsOrderState, string> = { check_in: 'info', checked_in: 'ok', checked_out: 'neutral' };
  return <span className={cx('badge', cls[state])}>{state}</span>;
}

export function ErrBadge({ e }: { e: { code: number; message: string; traceId?: string } | null | undefined }) {
  if (!e) return null;
  return (
    <span className="badge err" title={`${e.message}${e.traceId ? `\ntrace_id: ${e.traceId}` : ''}`}>
      {e.code}
    </span>
  );
}

/** "12m 03s" style countdown to an epoch-ms instant; re-renders every second. */
export function useCountdown(expiresAt: number | null | undefined): string {
  const [, tick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(i);
  }, []);
  if (!expiresAt) return '—';
  const s = Math.floor((expiresAt - Date.now()) / 1000);
  if (s <= 0) return 'expired';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

export function MaskedPin({ pin }: { pin?: string }) {
  const [show, setShow] = useState(false);
  const t = useT();
  if (!pin) return <span className="subtle">—</span>;
  return (
    <span className="row" style={{ gap: 6 }}>
      <code>{show ? pin : '••••••'}</code>
      <button type="button" className="btn btn-link btn-sm" onClick={() => setShow((s) => !s)}>
        {show ? t('Hide', '隐藏') : t('Reveal', '显示')}
      </button>
    </span>
  );
}

const asArray = <T,>(b: unknown, key: string): T[] => {
  if (Array.isArray(b)) return b as T[];
  const o = (b ?? {}) as Record<string, unknown>;
  const v = o[key] ?? o.data ?? o.result;
  return Array.isArray(v) ? (v as T[]) : [];
};

/** Loads the GRMS devices of a room (live call). */
export function useDevices(roomId: string | null, enabled = true) {
  const { akubelaCall, akubela } = useStore();
  const [devices, setDevices] = useState<GrmsDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!roomId || !enabled) return;
    setLoading(true);
    const r = await akubelaCall('GET', `/rooms/${encodeURIComponent(roomId)}/devices`, undefined, { silent: true });
    setLoading(false);
    if (r.status >= 400 || r.status === 0) {
      const b = (r.body ?? {}) as Record<string, unknown>;
      setError(`${String(b.message ?? b.error ?? `HTTP ${r.status}`)}${b.code != null ? ` [${String(b.code)}]` : ''}${b.traceId ? ` trace ${String(b.traceId)}` : ''}`);
      setDevices(null);
    } else {
      setError(null);
      setDevices(asArray<GrmsDevice>(r.body, 'devices'));
    }
  }, [roomId, enabled, akubelaCall]);
  useEffect(() => {
    setDevices(null);
    void load();
  }, [load, akubela?.mode]);
  return { devices, error, loading, reload: load };
}

export function useScenes(enabled = true) {
  const { akubelaCall } = useStore();
  const [scenes, setScenes] = useState<{ scene_id: string; scene_name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!enabled) return;
    const r = await akubelaCall('GET', '/scenes', undefined, { silent: true });
    if (r.status >= 400 || r.status === 0) {
      const b = (r.body ?? {}) as Record<string, unknown>;
      setError(`${String(b.message ?? b.error ?? `HTTP ${r.status}`)}${b.code != null ? ` [${String(b.code)}]` : ''}`);
    } else {
      setError(null);
      setScenes(asArray(r.body, 'scenes'));
    }
  }, [enabled, akubelaCall]);
  useEffect(() => {
    void load();
  }, [load]);
  return { scenes, error, reload: load };
}

const isOn = (a: GrmsAbility) => ['on', 'open', 'true', 'opened'].includes(String(a.state).toLowerCase());

/** One ability row with simple controls (switch/light/climate). */
function AbilityControl({ device, ability, onDone }: { device: GrmsDevice; ability: GrmsAbility; onDone: () => void }) {
  const { akubelaCall } = useStore();
  const t = useT();
  const [sending, setBusy] = useState(false);
  // offline devices cannot be controlled (GRMS would reject the command)
  const busy = sending || !device.online;
  const attr = ability.attribute ?? {};
  const [bri, setBri] = useState(Number(attr.brightness ?? 50));
  const [temp, setTemp] = useState(Number(attr.preset_temperature ?? attr.temperature ?? attr.target_temperature ?? 24));
  useEffect(() => {
    setBri(Number(attr.brightness ?? 50));
    setTemp(Number(attr.preset_temperature ?? attr.temperature ?? attr.target_temperature ?? 24));
  }, [attr.brightness, attr.preset_temperature, attr.temperature, attr.target_temperature]);
  const send = async (control: string, attribute?: Record<string, unknown>) => {
    setBusy(true);
    await akubelaCall('POST', '/devices/control', { device_id: device.device_id, ability_id: ability.ability_id, control, ...(attribute ? { attribute } : {}) });
    setBusy(false);
    onDone();
  };
  const type = ability.ability_type;
  const on = isOn(ability);
  const head = (
    <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
      <span>
        {ability.ability_name} <span className="subtle">({type})</span>
      </span>
      <span className={cx('badge', on ? 'ok' : 'neutral')}>{String(ability.state)}</span>
    </div>
  );
  if (type === 'switch' || type === 'light' || type === 'climate') {
    return (
      <div className="aku-ability">
        {head}
        <div className="row-wrap" style={{ marginTop: 6 }}>
          <Button size="sm" disabled={busy || on} onClick={() => send('turn_on')}>
            {t('On', '开')}
          </Button>
          <Button size="sm" disabled={busy || !on} onClick={() => send('turn_off')}>
            {t('Off', '关')}
          </Button>
          {type === 'light' && (
            <label className="row" style={{ gap: 6, flex: 1, minWidth: 140 }}>
              <input type="range" min={1} max={100} value={bri} style={{ flex: 1 }} onChange={(e) => setBri(Number(e.target.value))} onMouseUp={() => send('turn_on', { brightness: bri })} onTouchEnd={() => send('turn_on', { brightness: bri })} onKeyUp={() => send('turn_on', { brightness: bri })} />
              <span className="mono">{bri}%</span>
            </label>
          )}
          {type === 'climate' && (
            <>
              <Button size="sm" disabled={busy} onClick={() => { const n = Math.max(16, temp - 1); setTemp(n); void send('turn_on', { preset_temperature: n }); }}>
                −
              </Button>
              <span className="mono">{temp}°C</span>
              <Button size="sm" disabled={busy} onClick={() => { const n = Math.min(30, temp + 1); setTemp(n); void send('turn_on', { preset_temperature: n }); }}>
                +
              </Button>
              <select className="select" style={{ width: 'auto' }} disabled={busy} value={String(attr.hvac_mode ?? '')} onChange={(e) => send('turn_on', { hvac_mode: e.target.value })}>
                <option value="">{t('Mode…', '模式…')}</option>
                {['cool', 'heat', 'fan_only', 'dry', 'auto'].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="aku-ability">
      {head}
      {Object.keys(attr).length > 0 && <div className="subtle mono" style={{ fontSize: 11 }}>{JSON.stringify(attr)}</div>}
    </div>
  );
}

export function DeviceCard({ device, onDone, depth = 0 }: { device: GrmsDevice; onDone: () => void; depth?: number }) {
  const t = useT();
  return (
    <div className="aku-device" style={{ marginLeft: depth * 12 }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        <b>{device.device_name}</b>
        <span className={cx('badge', device.online ? 'ok' : 'err')}>{device.online ? t('Online', '在线') : t('Offline', '离线')}</span>
      </div>
      <div className="subtle" style={{ fontSize: 12 }}>
        {device.product_name} · {device.device_type}
      </div>
      <div className="col" style={{ gap: 6, marginTop: 6 }}>
        {device.abilities?.map((a) => (
          <AbilityControl key={a.ability_id} device={device} ability={a} onDone={onDone} />
        ))}
      </div>
      {device.sub_devices?.map((d) => (
        <DeviceCard key={d.device_id} device={d} onDone={onDone} depth={depth + 1} />
      ))}
    </div>
  );
}

export function DeviceList({ roomId }: { roomId: string }) {
  const t = useT();
  const { devices, error, loading, reload } = useDevices(roomId);
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button size="sm" onClick={reload} disabled={loading}>
          {loading ? t('Loading…', '加载中…') : t('Reload', '刷新')}
        </Button>
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      {devices && !devices.length && <div className="subtle">{t('No devices returned for this room.', '该房间没有返回设备。')}</div>}
      {devices?.map((d) => (
        <DeviceCard key={d.device_id} device={d} onDone={() => setTimeout(reload, 400)} />
      ))}
    </div>
  );
}
