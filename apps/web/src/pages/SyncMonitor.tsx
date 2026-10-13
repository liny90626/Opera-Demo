import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { drift, EVENTS, type BusinessEvent, type ChangeSource, type Delivery, type Subscriber } from '@opera-demo/core';
import { useStore } from '../store';
import { useT } from '../i18n';
import { Alert, Button, Confirm, DataTable, Drawer, EmptyState, Field, PageHeader, Select, Tabs, TextInput, cx } from '../components/ui';
import { roomNo } from '../components/status';
import './SyncMonitor.css';

const fmtSec = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString('en-GB') : '—');
const OHIP_VERIFIED = new Set<string>([EVENTS.HK_STATUS, EVENTS.OOO_PLACED, EVENTS.OOO_RELEASED, EVENTS.OOS_PLACED, EVENTS.OOS_RELEASED, EVENTS.SERVICE_STATUS]);
const SOURCES: { v: ChangeSource; label: string }[] = [
  { v: 'OPERA_UI', label: 'OPERA UI' },
  { v: 'MOBILE', label: 'Mobile' },
  { v: 'OHIP_API', label: 'OHIP API' },
  { v: 'PBX', label: 'PBX' },
];

/** Number that flashes when its value changes. */
function Num({ v }: { v: number | string }) {
  const prev = useRef(v);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (prev.current !== v) {
      prev.current = v;
      setN((x) => x + 1);
    }
  }, [v]);
  return <span key={n} className={n ? 'flash' : undefined}>{v}</span>;
}

function DeliveryBadge({ status }: { status: Delivery['status'] }) {
  return (
    <span className={cx('badge', status === 'DELIVERED' ? 'ok' : status === 'FAILED' ? 'err' : 'warn')}>
      <span className={`sm-dot ${status}`} style={{ marginRight: 0 }} />
      {status}
    </span>
  );
}

function SourceTag({ s }: { s: ChangeSource }) {
  return <span className={`sm-src ${s}`}>{s.replace('_', ' ')}</span>;
}

function SubCard({ sub, drifts, selected, onSelect }: { sub: Subscriber; drifts: number; selected: boolean; onSelect: () => void }) {
  const t = useT();
  const { exec, snapshot } = useStore();
  const [rate, setRate] = useState(Math.round(sub.failureRate * 100));
  const timer = useRef<number>();
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setRate(Math.round(sub.failureRate * 100));
  }, [sub.failureRate]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onRate = (v: number) => {
    dragging.current = true;
    setRate(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      dragging.current = false;
      void exec({ type: 'setSubscriber', subscriberId: sub.id, failureRate: v / 100 }, { silentSuccess: true });
    }, 350);
  };

  // mirror sample: keys touched by the latest delivered events
  const sample = useMemo(() => {
    const keys: string[] = [];
    if (sub.kind === 'CHANNEL') return Object.keys(sub.mirror).slice(0, 3);
    for (const d of snapshot.deliveries) {
      if (d.subscriberId !== sub.id || d.status !== 'DELIVERED') continue;
      const ev = snapshot.events.find((e) => e.id === d.eventId);
      for (const id of ev?.roomIds ?? []) if (id in sub.mirror && !keys.includes(id)) keys.push(id);
      if (keys.length >= 3) break;
    }
    return keys.slice(0, 3);
  }, [snapshot.deliveries, snapshot.events, sub]);

  return (
    <div className={cx('sm-card', selected && 'sel', !sub.enabled && 'off', sub.failureRate > 0 && 'fail', drifts > 0 && !sub.failureRate && 'drift')} onClick={onSelect} data-sub={sub.id}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>{sub.name}</h3>
        <span className="badge neutral mono">{sub.id}</span>
      </div>
      <div className="row-wrap" onClick={(e) => e.stopPropagation()}>
        <label className="sm-switch">
          <input type="checkbox" checked={sub.enabled} onChange={(e) => void exec({ type: 'setSubscriber', subscriberId: sub.id, enabled: e.target.checked }, { silentSuccess: true })} />
          {sub.enabled ? t('Enabled', '已启用') : t('Disabled', '已停用')}
        </label>
        <span className={cx('badge', drifts > 0 ? 'err' : 'ok')} title={t('Keys where the external mirror differs from PMS truth', '外部镜像与 PMS 真值不一致的键数')}>
          {t('Drift', '漂移')} <Num v={drifts} />
        </span>
      </div>
      <div className="desc">{sub.description}</div>
      <div className="sm-card-body col" style={{ gap: 8 }}>
        <div className="nums">
          <span>{t('Delivered', '已投递')} <b><Num v={sub.delivered} /></b></span>
          <span className="bad">{t('Failed', '失败')} <b><Num v={sub.failed} /></b></span>
          <span className="muted">{t('Last', '最近')} {fmtSec(sub.lastDeliveryAt)}</span>
        </div>
        <div className="sm-slider" onClick={(e) => e.stopPropagation()}>
          <span style={{ whiteSpace: 'nowrap' }}>{t('Failure rate', '失败率')}</span>
          <input type="range" min={0} max={100} step={5} value={rate} onChange={(e) => onRate(+e.target.value)} aria-label="failure rate" />
          <b style={{ width: 38, textAlign: 'right', color: rate ? '#c0262d' : undefined }}>{rate}%</b>
        </div>
        <div className="chips">
          {sub.events.slice(0, 4).map((e) => (
            <span key={e} className="sm-chip">{e}</span>
          ))}
          {sub.events.length > 4 && <span className="sm-chip" title={sub.events.join(', ')}>+{sub.events.length - 4}</span>}
        </div>
        <div className="sm-mirror">
          {sample.length === 0 && <span className="subtle">{t('mirror: no recent changes', '镜像：暂无近期变化')}</span>}
          {sample.map((k) => (
            <span key={k}>{sub.kind === 'CHANNEL' ? k : roomNo(k)} → {sub.mirror[k]}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function SyncMonitor() {
  const t = useT();
  const { snapshot, exec, toast, backendKind, conn } = useStore();
  const [sp, setSp] = useSearchParams();
  const subs = snapshot.subscribers;
  const selId = sp.get('sub') ?? '';
  const sel = subs.find((s) => s.id === selId) ?? null;
  const [tab, setTab] = useState<'events' | 'sub' | 'log'>(sel ? 'sub' : 'events');
  const select = (id: string) => {
    const next = new URLSearchParams(sp);
    next.set('sub', id);
    setSp(next, { replace: true });
    setTab('sub');
  };
  useEffect(() => {
    if (sel) setTab('sub');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId]);

  // ticker for events/min
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const i = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(i);
  }, []);
  const perMin = snapshot.events.filter((e) => now - new Date(e.timestamp).getTime() < 60000).length;

  const driftBySub = useMemo(() => {
    const m = new Map<string, ReturnType<typeof drift>>();
    for (const s of subs) m.set(s.id, drift(snapshot, s));
    return m;
  }, [snapshot, subs]);
  const totalDrift = [...driftBySub.values()].reduce((a, d) => a + d.length, 0);
  const failedTotal = snapshot.deliveries.filter((d) => d.status === 'FAILED').length;

  const bySource = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of snapshot.events) m[e.source] = (m[e.source] ?? 0) + 1;
    return m;
  }, [snapshot.events]);
  const lastSeq = snapshot.events[0]?.seq ?? 0;

  const retryFailed = async (subId?: string) => {
    const list = snapshot.deliveries.filter((d) => d.status === 'FAILED' && (!subId || d.subscriberId === subId));
    if (!list.length) {
      toast('info', t('No failed deliveries to retry', '没有需要重试的失败投递'));
      return;
    }
    if (!subId) {
      await exec({ type: 'retryAllFailed' });
      return;
    }
    let ok = 0;
    for (const d of list) {
      const r = await exec({ type: 'retryDelivery', deliveryId: d.id }, { silentSuccess: true, silentError: true });
      if (r.ok) ok++;
    }
    toast(ok === list.length ? 'success' : 'warning', `${ok}/${list.length} ${t('retried deliveries processed', '条重试已处理')}`);
  };

  return (
    <div className="page">
      <PageHeader
        title={t('OHIP Sync Monitor', 'OHIP 同步监控')}
        breadcrumb={[{ label: 'Integration (OHIP)' }, { label: 'Sync Monitor' }]}
        sub={t(
          'How a room-status change leaves the PMS: every change becomes a Business Event, fanned out to subscribed external systems.',
          '房态变更如何离开 PMS：每次变更生成 Business Event，再分发给订阅的外部系统。',
        )}
        actions={
          <div className="row-wrap">
            <span className={cx('badge', conn === 'online' ? 'ok' : 'warn')}>
              <span className="badge-dot" style={{ background: conn === 'online' ? '#2e9e3a' : '#e0a000' }} />
              {backendKind === 'http' ? t('Streaming (SSE)', '流式 (SSE)') : t('Streaming (BroadcastChannel)', '流式 (BroadcastChannel)')}
            </span>
            <span className="badge info">{t('Events/min', '事件/分钟')} {perMin}</span>
            <Link to="/integration/api-console" className="btn btn-secondary">API Console →</Link>
          </div>
        }
      />

      {/* ---------------- architecture strip ---------------- */}
      <div className="card sm-arch" aria-label="architecture">
        <div className="sm-col">
          <div className="sm-col-h">{t('1 · Inbound sources', '1 · 入站来源')}</div>
          {SOURCES.map((s) => (
            <div key={s.v} className={`sm-box src ${s.v}`}>
              <span>{s.label}</span>
              <b><Num v={bySource[s.v] ?? 0} /></b>
            </div>
          ))}
        </div>
        <div className="sm-arrow">➜</div>
        <div className="sm-col">
          <div className="sm-col-h">{t('2 · PMS engine', '2 · PMS 引擎')}</div>
          <div className="sm-box sm-core">
            <div className="big">PMS</div>
            <div className="muted" style={{ fontSize: 12 }}>{t('single source of truth', '唯一真值')}</div>
            <div className="mono" style={{ fontSize: 12 }}>{snapshot.hotel.hotelId} · {snapshot.hotel.businessDate}</div>
          </div>
        </div>
        <div className="sm-arrow">➜</div>
        <div className="sm-col">
          <div className="sm-col-h">{t('3 · Business Events', '3 · 业务事件')}</div>
          <div className="sm-box sm-bus">
            <div className="big"><Num v={snapshot.events.length} /></div>
            <div className="muted" style={{ fontSize: 12 }}>{t('events · last seq', '事件 · 最新 seq')} #<Num v={lastSeq} /></div>
            <div style={{ fontSize: 12 }} className={failedTotal ? '' : 'subtle'}>
              <span className={cx('badge', failedTotal ? 'err' : 'ok')}>{failedTotal} {t('failed deliveries', '失败投递')}</span>
            </div>
          </div>
        </div>
        <div className="sm-arrow">➜</div>
        <div className="sm-col">
          <div className="sm-col-h">{t('4 · Subscribers (external systems)', '4 · 订阅者（外部系统）')}</div>
          {subs.map((s) => {
            const d = driftBySub.get(s.id)?.length ?? 0;
            return (
              <div key={s.id} className={cx('sm-box sm-sub', selId === s.id && 'sel', !s.enabled && 'off')} onClick={() => select(s.id)}>
                <span className="nm">{s.name}</span>
                <span className="row" style={{ gap: 6 }}>
                  <span title="delivered" className="badge ok"><Num v={s.delivered} /></span>
                  {s.failed > 0 && <span title="failed" className="badge err"><Num v={s.failed} /></span>}
                  {d > 0 && <span title="drift" className="badge warn">Δ{d}</span>}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ---------------- subscriber cards ---------------- */}
      <div className="sm-cards">
        {subs.map((s) => (
          <SubCard key={s.id} sub={s} drifts={driftBySub.get(s.id)?.length ?? 0} selected={selId === s.id} onSelect={() => select(s.id)} />
        ))}
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'events', label: t('Business Events', '业务事件流'), count: snapshot.events.length },
          { key: 'sub', label: sel ? `${t('Subscriber', '订阅者')}: ${sel.name}` : t('Subscriber detail · Drift', '订阅者详情 · 漂移'), count: totalDrift },
          { key: 'log', label: t('Delivery Log', '投递日志'), count: snapshot.deliveries.length },
        ]}
      />

      {tab === 'events' && <EventsTab />}
      {tab === 'sub' && <SubDetail sub={sel} onPick={select} retryFailed={retryFailed} />}
      {tab === 'log' && <DeliveryLog retryFailed={() => retryFailed()} />}

      <details className="card card-pad sm-note" style={{ marginTop: 16 }}>
        <summary>{t('How OHIP Streaming vs Polling maps to this demo', 'OHIP Streaming 与 Polling 在本 Demo 中的对应关系')}</summary>
        <div className="col" style={{ marginTop: 8 }}>
          <div>
            <b>Streaming API (WebSocket / GraphQL subscription)</b> — {t(
              'OHIP pushes each Business Event to the subscriber the moment it happens. In this demo that is the live stream the browser is connected to (SSE from the server, or BroadcastChannel between tabs in local mode): new rows slide in at the top of the event list without any request.',
              'OHIP 在事件发生时即时推送给订阅方。本 Demo 里对应浏览器连接的实时流（服务端模式用 SSE，本地模式用多标签页 BroadcastChannel）：事件列表顶部无需请求即滑入新行。',
            )}
          </div>
          <div>
            <b>Polling API</b> — {t(
              'The consumer asks "what happened since I last looked?". Here: ',
              '消费方主动询问“自上次以来发生了什么”。这里对应：',
            )}
            <code>GET /api/events?sinceSeq=N</code> {t('returns events with seq > N plus', '返回 seq > N 的事件，以及')} <code>lastSeq</code>; {t('try it in the', '可在')}{' '}
            <Link to="/integration/api-console">API Console</Link> {t('(Polling panel).', '的 Polling 面板中尝试。')}
          </div>
          <div className="muted">
            {t(
              'Either way delivery is at-least-once and may fail: a failed delivery leaves the external mirror stale (drift). Retry replays the delivery; Full resync rebuilds the mirror from PMS truth (like a Data Extract / reconciliation job).',
              '无论哪种方式投递都是“至少一次”且可能失败：失败会让外部镜像过期（漂移）。Retry 重放投递；Full resync 以 PMS 真值重建镜像（类似数据抽取/对账任务）。',
            )}
          </div>
        </div>
      </details>
    </div>
  );
}

// ======================================================================= Events
function EventsTab() {
  const t = useT();
  const { snapshot } = useStore();
  const [evName, setEvName] = useState('');
  const [module, setModule] = useState('');
  const [source, setSource] = useState('');
  const [room, setRoom] = useState('');
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState(0);
  const [limit, setLimit] = useState(60);
  const [open, setOpen] = useState<BusinessEvent | null>(null);
  const mountSeq = useRef(snapshot.events[0]?.seq ?? 0);

  const names = useMemo(() => [...new Set(snapshot.events.map((e) => e.eventName))].sort(), [snapshot.events]);
  const delByEvent = useMemo(() => {
    const m = new Map<string, Delivery[]>();
    for (const d of snapshot.deliveries) (m.get(d.eventId) ?? m.set(d.eventId, []).get(d.eventId)!).push(d);
    return m;
  }, [snapshot.deliveries]);

  const newCount = paused ? snapshot.events.filter((e) => e.seq > frozen).length : 0;
  const rows = useMemo(() => {
    const q = room.trim().replace(/^0+/, '');
    return snapshot.events.filter(
      (e) =>
        (!paused || e.seq <= frozen) &&
        (!evName || e.eventName === evName) &&
        (!module || e.module === module) &&
        (!source || e.source === source) &&
        (!q || e.roomIds.some((r) => r.replace(/^0+/, '').includes(q)) || e.primaryKey.includes(q)),
    );
  }, [snapshot.events, paused, frozen, evName, module, source, room]);

  const openLive = open ? snapshot.events.find((e) => e.id === open.id) ?? open : null;

  return (
    <div>
      <div className="sm-filters">
        <Field label="Event">
          <Select value={evName} onChange={setEvName} placeholder={t('All events', '全部事件')} options={names.map((n) => ({ value: n, label: n }))} />
        </Field>
        <Field label="Source">
          <Select value={source} onChange={setSource} placeholder={t('All sources', '全部来源')} options={SOURCES.map((s) => ({ value: s.v, label: s.label })).concat([{ value: 'NIGHT_AUDIT', label: 'Night Audit' }])} />
        </Field>
        <Field label="Module">
          <Select
            value={module}
            onChange={setModule}
            placeholder={t('All modules', '全部模块')}
            options={['HOUSEKEEPING', 'FRONT_DESK', 'RESERVATION', 'INVENTORY', 'NIGHT_AUDIT'].map((m) => ({ value: m, label: m }))}
          />
        </Field>
        <Field label="Room">
          <TextInput value={room} onChange={setRoom} placeholder="305" />
        </Field>
        <Button
          variant={paused ? 'primary' : 'secondary'}
          onClick={() => {
            setFrozen(snapshot.events[0]?.seq ?? 0);
            setPaused(!paused);
          }}
        >
          {paused ? `▶ ${t('Resume', '继续')}${newCount ? ` (${newCount} ${t('new', '条新')})` : ''}` : `⏸ ${t('Pause', '暂停')}`}
        </Button>
        {(evName || module || source || room) && (
          <Button
            variant="link"
            onClick={() => {
              setEvName('');
              setModule('');
              setSource('');
              setRoom('');
            }}
          >
            {t('Clear filters', '清除过滤')}
          </Button>
        )}
        <span className="muted" style={{ fontSize: 12 }}>{rows.length} / {snapshot.events.length}</span>
      </div>

      <div className="table-wrap">
        {rows.length === 0 ? (
          <EmptyState
            title={snapshot.events.length ? t('No events match the filters', '没有符合过滤条件的事件') : t('No business events yet', '暂无业务事件')}
            hint={t('Change a room status from the Housekeeping Board, Mobile, or the API Console.', '请在房务看板、手机端或 API 控制台修改一个房态。')}
          />
        ) : (
          <table className="dt">
            <thead>
              <tr>
                <th className="num">Seq</th>
                <th>{t('Time', '时间')}</th>
                <th>Event</th>
                <th>Room</th>
                <th>Source</th>
                <th>{t('Summary', '摘要')}</th>
                <th>{t('Delivery', '投递')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map((e) => {
                const ds = delByEvent.get(e.id) ?? [];
                const okN = ds.filter((d) => d.status === 'DELIVERED').length;
                const bad = ds.some((d) => d.status === 'FAILED');
                return (
                  <tr key={e.id} className={cx('sm-ev-row clickable', e.seq > mountSeq.current && 'sm-ev-new')} onClick={() => setOpen(e)}>
                    <td className="num mono">{e.seq}</td>
                    <td className="mono">{fmtSec(e.timestamp)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {e.eventName}{' '}
                      <span className={cx('badge', OHIP_VERIFIED.has(e.eventName) ? 'info' : 'neutral')} title={OHIP_VERIFIED.has(e.eventName) ? t('Name verified against OHIP business events', '名称已在 OHIP 文档中核实') : t('Demo-defined event name', 'Demo 自定义事件名')}>
                        {OHIP_VERIFIED.has(e.eventName) ? 'OHIP' : 'DEMO'}
                      </span>
                    </td>
                    <td className="mono">{e.roomIds.length > 2 ? `${e.roomIds.length} rooms` : e.roomIds.map(roomNo).join(', ') || '—'}</td>
                    <td><SourceTag s={e.source} /></td>
                    <td>{e.summary}</td>
                    <td>
                      {ds.length === 0 ? (
                        <span className="subtle">—</span>
                      ) : (
                        <span className={cx('badge', bad ? 'err' : 'ok')}>
                          <span className={`sm-dot ${bad ? 'FAILED' : 'DELIVERED'}`} style={{ marginRight: 0 }} />
                          {okN}/{ds.length}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {rows.length > limit && (
        <div style={{ textAlign: 'center', marginTop: 8 }}>
          <Button onClick={() => setLimit(limit + 100)}>{t('Show more', '显示更多')}</Button>
        </div>
      )}

      <EventDrawer ev={openLive} deliveries={openLive ? delByEvent.get(openLive.id) ?? [] : []} onClose={() => setOpen(null)} />
    </div>
  );
}

function EventDrawer({ ev, deliveries, onClose }: { ev: BusinessEvent | null; deliveries: Delivery[]; onClose: () => void }) {
  const t = useT();
  const { snapshot, exec, toast } = useStore();
  if (!ev) return null;
  const json = JSON.stringify(ev, null, 2);
  return (
    <Drawer open title={`#${ev.seq} ${ev.eventName}`} onClose={onClose} width={560}>
      <div className="col" style={{ gap: 12 }}>
        <div className="row-wrap">
          <SourceTag s={ev.source} />
          <span className="badge neutral">{ev.module}</span>
          <span className="muted">{ev.summary}</span>
        </div>
        <div>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
            <b>JSON payload</b>
            <Button
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(json);
                toast('info', t('Copied', '已复制'));
              }}
            >
              Copy
            </Button>
          </div>
          <pre className="sm-json">{json}</pre>
        </div>
        <div>
          <b>{t('Deliveries per subscriber', '各订阅者投递情况')}</b>
          <table className="dt" style={{ marginTop: 6 }}>
            <thead>
              <tr><th>Subscriber</th><th>Status</th><th className="num">Att.</th><th className="num">ms</th><th /></tr>
            </thead>
            <tbody>
              {snapshot.subscribers.map((s) => {
                const d = deliveries.find((x) => x.subscriberId === s.id);
                const subscribed = s.events.includes(ev.eventName);
                return (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td>{d ? <DeliveryBadge status={d.status} /> : <span className="subtle">{!subscribed ? t('not subscribed', '未订阅') : s.enabled ? t('no delivery', '无投递') : t('disabled', '已停用')}</span>}</td>
                    <td className="num">{d?.attempts ?? '—'}</td>
                    <td className="num">{d?.latencyMs ?? '—'}</td>
                    <td>{d?.status === 'FAILED' && <Button size="sm" onClick={() => void exec({ type: 'retryDelivery', deliveryId: d.id })}>Retry</Button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Drawer>
  );
}

// ======================================================================= Subscriber detail
function SubDetail({ sub, onPick, retryFailed }: { sub: Subscriber | null; onPick: (id: string) => void; retryFailed: (id: string) => Promise<void> }) {
  const t = useT();
  const { snapshot, exec } = useStore();
  const [q, setQ] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const items = useMemo(() => (sub ? drift(snapshot, sub) : []), [snapshot, sub]);
  const mirrorRows = useMemo(() => {
    if (!sub) return [];
    const s = q.trim().toLowerCase();
    const driftKeys = new Set(items.map((i) => i.key));
    return Object.entries(sub.mirror)
      .filter(([k, v]) => !s || k.toLowerCase().includes(s) || roomNo(k).includes(s) || v.toLowerCase().includes(s))
      .map(([k, v]) => ({ k, v, drifted: driftKeys.has(k) }));
  }, [sub, q, items]);

  if (!sub)
    return (
      <EmptyState
        title={t('Select a subscriber', '请选择一个订阅者')}
        hint={t('Click a subscriber card above to inspect its drift, mirror and deliveries.', '点击上方订阅者卡片，查看其漂移、镜像与投递。')}
        action={<div className="row-wrap" style={{ justifyContent: 'center' }}>{snapshot.subscribers.map((s) => <Button key={s.id} size="sm" onClick={() => onPick(s.id)}>{s.id}</Button>)}</div>}
      />
    );

  const keyLabel = (k: string) => (sub.kind === 'CHANNEL' ? k : `${roomNo(k)}`);
  const failed = snapshot.deliveries.filter((d) => d.subscriberId === sub.id && d.status === 'FAILED');
  const deliveries = snapshot.deliveries.filter((d) => d.subscriberId === sub.id);

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="card card-pad">
        <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
          <div>
            <b style={{ fontSize: 15 }}>{sub.name}</b> <span className="badge neutral mono">{sub.id}</span>{' '}
            <span className="badge neutral">{sub.kind}</span>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{sub.description}</div>
          </div>
          <div className="sm-act" style={{ margin: 0 }}>
            <Button disabled={!sub.enabled || failed.length === 0} onClick={() => void retryFailed(sub.id)}>
              {t('Retry failed', '重试失败')} ({failed.length})
            </Button>
            <Button variant="primary" onClick={() => setConfirm(true)}>{t('Full Resync', '全量重同步')}</Button>
          </div>
        </div>
        {!sub.enabled && <Alert kind="warning">{t('Disabled – events are not delivered; use Full resync after re-enabling.', '已停用：事件不会投递；重新启用后请执行 Full resync。')}</Alert>}
        {sub.failureRate > 0 && <Alert kind="info">{t(`Failure injection active: ${Math.round(sub.failureRate * 100)}% of deliveries fail, leaving this mirror stale.`, `已注入故障：${Math.round(sub.failureRate * 100)}% 的投递会失败，使该镜像过期。`)}</Alert>}
      </div>

      <div className="sm-pair">
        <div>
          <h3 className="section-title">
            {t('Drift', '漂移')} <span className={cx('badge', items.length ? 'err' : 'ok')}>{items.length}</span>
          </h3>
          <div className="table-wrap" style={{ maxHeight: 360 }}>
            {items.length === 0 ? (
              <EmptyState title={`✔ ${t('In sync', '已同步')}`} hint={t('External mirror equals PMS truth for every key.', '外部镜像与 PMS 真值完全一致。')} />
            ) : (
              <table className="dt">
                <thead>
                  <tr><th>{sub.kind === 'CHANNEL' ? 'Room type' : 'Room'}</th><th>PMS truth (expected)</th><th>External mirror (actual)</th></tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.key}>
                      <td className="sm-drift-k">{keyLabel(i.key)}</td>
                      <td style={{ color: '#1c6b25', fontWeight: 600 }}>{i.expected}</td>
                      <td style={{ color: '#b3242b' }}>{i.actual ?? <span className="subtle">(missing)</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <div>
          <h3 className="section-title">{t('Mirror browser', '镜像浏览')} <span className="muted" style={{ fontSize: 12 }}>({Object.keys(sub.mirror).length})</span></h3>
          <TextInput value={q} onChange={setQ} placeholder={t('Search key, e.g. 305', '搜索键，如 305')} />
          <div className="table-wrap" style={{ maxHeight: 316, marginTop: 6 }}>
            <table className="dt">
              <thead><tr><th>Key</th><th>Mirror value</th></tr></thead>
              <tbody>
                {mirrorRows.slice(0, 200).map((r) => (
                  <tr key={r.k} style={r.drifted ? { background: '#fff4f4' } : undefined}>
                    <td className="sm-drift-k">{keyLabel(r.k)}</td>
                    <td>{r.v} {r.drifted && <span className="badge err">drift</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {mirrorRows.length === 0 && <EmptyState title={t('No matching keys', '没有匹配的键')} />}
          </div>
        </div>
      </div>

      <div>
        <h3 className="section-title">{t('Deliveries to this subscriber', '该订阅者的投递')}</h3>
        <DeliveryTable rows={deliveries.slice(0, 50)} showSub={false} />
      </div>

      <Confirm
        open={confirm}
        title="Full Resync"
        message={`${t('Rebuild mirror from PMS', '以 PMS 真值重建镜像')} (${Object.keys(sub.mirror).length} ${t('records', '条记录')}) — ${sub.name}`}
        confirmLabel={busy ? '…' : 'Full Resync'}
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          setBusy(true);
          await exec({ type: 'resyncSubscriber', subscriberId: sub.id });
          setBusy(false);
          setConfirm(false);
        }}
      />
    </div>
  );
}

// ======================================================================= Delivery log
function DeliveryTable({ rows, showSub = true }: { rows: Delivery[]; showSub?: boolean }) {
  const t = useT();
  const { snapshot, exec } = useStore();
  const name = (id: string) => snapshot.subscribers.find((s) => s.id === id)?.name ?? id;
  return (
    <DataTable
      rows={rows}
      rowKey={(d) => d.id}
      pageSize={15}
      empty={<EmptyState title={t('No deliveries yet', '暂无投递记录')} />}
      columns={[
        { key: 'time', header: t('Time', '时间'), render: (d) => <span className="mono">{fmtSec(d.timestamp)}</span> },
        ...(showSub ? [{ key: 'sub', header: 'Subscriber', render: (d: Delivery) => name(d.subscriberId) }] : []),
        { key: 'ev', header: 'Event', render: (d) => d.eventName },
        { key: 'st', header: 'Status', render: (d) => <DeliveryBadge status={d.status} /> },
        { key: 'att', header: 'Attempts', align: 'right', render: (d) => d.attempts },
        { key: 'lat', header: 'Latency', align: 'right', render: (d) => `${d.latencyMs} ms` },
        { key: 'act', header: '', render: (d) => d.status === 'FAILED' && <Button size="sm" onClick={() => void exec({ type: 'retryDelivery', deliveryId: d.id })}>Retry</Button> },
      ]}
    />
  );
}

function DeliveryLog({ retryFailed }: { retryFailed: () => void }) {
  const t = useT();
  const { snapshot } = useStore();
  const [subF, setSubF] = useState('');
  const [stF, setStF] = useState('');
  const rows = snapshot.deliveries.filter((d) => (!subF || d.subscriberId === subF) && (!stF || d.status === stF));
  const nFailed = snapshot.deliveries.filter((d) => d.status === 'FAILED').length;
  return (
    <div>
      <div className="sm-filters">
        <Field label="Subscriber">
          <Select value={subF} onChange={setSubF} placeholder={t('All', '全部')} options={snapshot.subscribers.map((s) => ({ value: s.id, label: s.name }))} />
        </Field>
        <Field label="Status">
          <Select value={stF} onChange={setStF} placeholder={t('All', '全部')} options={['DELIVERED', 'FAILED', 'RETRYING', 'PENDING'].map((s) => ({ value: s, label: s }))} />
        </Field>
        <Button disabled={!nFailed} onClick={retryFailed}>{t('Retry all failed', '重试全部失败')} ({nFailed})</Button>
      </div>
      <DeliveryTable rows={rows} />
    </div>
  );
}
