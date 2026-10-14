import { useState } from 'react';
import type { IntegrationMode } from '@opera-demo/core';
import { useStore } from '../store';
import { useT } from '../i18n';
import { Alert, Button, EmptyState, PageHeader, Tabs, cx } from '../components/ui';
import { RoomDetailDrawer } from '../components/RoomDialogs';
import { ModeBadge, ErrBadge, fmtClock, fmtStamp, useCountdown } from './akubela/shared';
import RoomsTab from './akubela/RoomsTab';
import OrdersTab from './akubela/OrdersTab';
import JobsTab from './akubela/JobsTab';
import LogTab from './akubela/LogTab';
import DevicesTab from './akubela/DevicesTab';
import SettingsTab from './akubela/SettingsTab';
import SimTab from './akubela/SimTab';
import RealUatModal from './akubela/RealUatModal';
import './Akubela.css';

type TabKey = 'rooms' | 'orders' | 'jobs' | 'log' | 'devices' | 'settings' | 'sim';

function FlowStrip() {
  const t = useT();
  return (
    <div className="card aku-flow">
      <div className="aku-master">
        <b>{t('OPERA is the master → GRMS follows', '主系统 OPERA → 同步到 GRMS')}</b>
      </div>
      <div className="aku-box">
        <b>OPERA PMS</b>
        <span>{t('check-in / out, room move, HK status', '入住/退房、换房、房务状态')}</span>
      </div>
      <div className="aku-arrow">
        <span>{t('business events', '业务事件')}</span>→
      </div>
      <div className="aku-box core">
        <b>{t('Connector', '连接器')}</b>
        <span>{t('job queue · retry · mapping', '作业队列 · 重试 · 映射')}</span>
      </div>
      <div className="aku-arrow">
        <span>hotel-commands</span>⇄
      </div>
      <div className="aku-box grms">
        <b>Akubela GRMS</b>
        <span>{t('orders · lock PIN · devices · scenes', '订单 · 门锁 PIN · 设备 · 场景')}</span>
      </div>
      <div className="aku-back">↩ {t('polling brings back only GRMS-side facts: DND, guest self check-out, alarms (clean/dirty only in bidirectional mode)', '轮询仅回写 GRMS 侧事实：请勿打扰、自助退房、告警（净/脏房仅在双向模式下回写）')}</div>
    </div>
  );
}

export default function Akubela() {
  const t = useT();
  const { akubela: st, akubelaCall, backendKind, toast } = useStore();
  const [tab, setTab] = useState<TabKey>('rooms');
  const [drawer, setDrawer] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [uatOpen, setUatOpen] = useState(false);
  const { backendUrl, backendError, connectBackend } = useStore();
  const left = useCountdown(st?.token?.expiresAt);

  if (!st) {
    return (
      <div className="page">
        <PageHeader title={t('Akubela GRMS', 'Akubela 客控云')} breadcrumb={[{ label: t('Integration', '集成') }, { label: 'Akubela GRMS' }]} />
        <FlowStrip />
        <div className="card card-pad">
          <EmptyState
            title={t('Integration not available', '集成暂不可用')}
            hint={t('The Akubela GRMS service did not start in this session (server not configured, or another browser tab is running the connector). Reload in a moment.', '本次会话中 Akubela GRMS 服务未启动（服务端未配置，或其它浏览器标签页正在运行连接器）。请稍后刷新。')}
          />
        </div>
      </div>
    );
  }

  const run = async (key: string, method: string, path: string, body?: unknown, okMsg?: string) => {
    setBusy(key);
    const r = await akubelaCall(method, path, body);
    setBusy(null);
    if (r.status < 400 && okMsg) {
      const b = (r.body ?? {}) as { ok?: boolean; message?: string };
      if (b.ok === false) toast('error', b.message ?? 'failed');
      else toast('success', b.message ?? okMsg);
    }
  };
  const setMode = (m: IntegrationMode) => run('mode', 'POST', '/mode', { mode: m }, t('Mode changed', '模式已切换'));
  const isLocal = backendKind === 'local';
  const pushAll = async () => {
    setBusy('push');
    const r = await akubelaCall('POST', '/push');
    setBusy(null);
    if (r.status < 400) toast('success', t(`${(r.body as { jobs?: number } | undefined)?.jobs ?? 0} jobs queued`, `已排队 ${(r.body as { jobs?: number } | undefined)?.jobs ?? 0} 个作业`));
  };
  const recentAlarms = st.alarms.filter((a) => Date.now() - new Date(a.ts).getTime() < 10 * 60_000);
  const tabs: { key: TabKey; label: string; count?: number }[] = [
    { key: 'rooms', label: t('Rooms', '房间'), count: st.mappings.filter((m) => m.residenceId).length },
    { key: 'orders', label: t('Orders', '订单'), count: st.links.length },
    { key: 'jobs', label: t('Jobs', '作业'), count: st.jobs.filter((j) => j.status === 'PENDING' || j.status === 'FAILED' || j.status === 'DEAD').length || undefined },
    { key: 'log', label: t('API Log', 'API 日志'), count: st.apiLog.length },
    { key: 'devices', label: t('Devices & Scenes', '设备与场景') },
    { key: 'settings', label: t('Settings', '设置') },
    ...(st.mode === 'sim' ? [{ key: 'sim' as TabKey, label: t('Simulator', '模拟器') }] : []),
  ];
  const curTab = tabs.some((x) => x.key === tab) ? tab : 'rooms';

  return (
    <div className="page">
      <PageHeader
        title={
          <span className="row" style={{ gap: 10 }}>
            Akubela GRMS <ModeBadge mode={st.mode} />
            <span className={cx('badge', st.connected ? 'ok' : 'err')}>{st.connected ? t('Connected', '已连接') : t('Disconnected', '未连接')}</span>
          </span>
        }
        sub={t('Guest-room management integration: OPERA reservations, room status and in-room devices', '客控集成：OPERA 预订、房态与房内设备')}
        breadcrumb={[{ label: t('Integration', '集成') }, { label: 'Akubela GRMS' }]}
        actions={
          <div className="row" style={{ gap: 4 }} role="group" aria-label="mode">
            {(['off', 'sim', 'real'] as IntegrationMode[]).map((m) => {
              const disabled = busy === 'mode';
              return (
                <Button
                  key={m}
                  size="sm"
                  variant={st.mode === m ? 'primary' : 'secondary'}
                  disabled={disabled}
                  title={m === 'real' && isLocal ? t('Requires the Node backend with credentials – click for how', '需要带凭据的 Node 后端，点击查看方法') : undefined}
                  onClick={() => (m === 'real' && isLocal ? setUatOpen(true) : st.mode !== m && setMode(m))}
                >
                  {m === 'real' ? t('Real UAT', '真实 UAT') : m === 'sim' ? t('Simulator', '模拟器') : t('Off', '关闭')}
                </Button>
              );
            })}
          </div>
        }
      />

      <FlowStrip />

      {recentAlarms.length > 0 && (
        <Alert kind="error">
          <b>{t('GRMS alarms', 'GRMS 告警')}:</b>{' '}
          {recentAlarms.slice(0, 3).map((a) => (
            <span key={a.id} style={{ marginRight: 12 }}>
              {fmtClock(a.ts)} · <b>{a.type}</b> {a.roomId ? `· ${a.roomId.replace(/^0+/, '')}` : ''} {a.message}
            </span>
          ))}
          {recentAlarms.length > 3 && <span>+{recentAlarms.length - 3}</span>}
        </Alert>
      )}

      <div className="card card-pad aku-conn">
        <dl className="aku-kv">
          <div><dt>{t('Base URL', '接口地址')}</dt><dd className="mono">{st.baseUrl ?? (st.mode === 'sim' ? t('(in-browser simulator)', '（内置模拟器）') : '—')}</dd></div>
          <div>
            <dt>{t('Sync mode', '同步模式')}</dt>
            <dd>
              <span className={cx('badge', st.settings.syncMode === 'bidirectional' ? 'warn' : 'ok')}>
                {st.settings.syncMode === 'bidirectional' ? t('Bidirectional', '双向同步') : t('OPERA master', 'OPERA 主系统')}
              </span>
            </dd>
          </div>
          <div><dt>{t('Last push', '最近推送')}</dt><dd>{fmtStamp(st.lastPushAt)}</dd></div>
          {backendUrl && <div><dt>{t('Backend', '后端')}</dt><dd className="mono">{backendUrl} <a href="#/integration/akubela" onClick={(e) => { e.preventDefault(); connectBackend(null); }}>{t('disconnect', '断开')}</a></dd></div>}
          {backendError && <div><dt>{t('Backend error', '后端错误')}</dt><dd style={{ color: 'var(--oc-danger)' }}>{backendError}</dd></div>}
          <div><dt>Client ID</dt><dd className="mono">{st.clientIdMasked ?? '—'}</dd></div>
          <div><dt>{t('Token expires in', '令牌剩余')}</dt><dd className="mono">{st.token ? left : '—'}</dd></div>
          <div><dt>{t('Last poll', '最近轮询')}</dt><dd>{fmtStamp(st.lastPollAt)}</dd></div>
          <div>
            <dt>{t('Last error', '最近错误')}</dt>
            <dd>
              {st.lastError ? (
                <span title={st.lastError.message}>
                  <ErrBadge e={st.lastError} /> <span className="aku-trunc2">{st.lastError.message}</span>
                  {st.lastError.traceId && <div className="mono subtle" style={{ fontSize: 11 }}>trace_id {st.lastError.traceId}</div>}
                </span>
              ) : (
                '—'
              )}
            </dd>
          </div>
        </dl>
        <div className="row-wrap">
          <Button size="sm" variant="primary" disabled={!!busy || st.mode === 'off'} onClick={pushAll}>
            {busy === 'push' ? '…' : t('Push OPERA → GRMS (full)', '推送 OPERA → GRMS（全量）')}
          </Button>
          <Button size="sm" disabled={!!busy || st.mode === 'off'} onClick={() => run('test', 'POST', '/test', undefined, t('Connection OK', '连接正常'))}>
            {busy === 'test' ? '…' : t('Test connection', '测试连接')}
          </Button>
          <Button size="sm" disabled={!!busy || st.mode === 'off'} onClick={() => run('poll', 'POST', '/poll', undefined, t('Polled', '已轮询'))}>
            {t('Poll now', '立即轮询')}
          </Button>
          <Button size="sm" disabled={!!busy || st.mode === 'off'} onClick={() => run('rec', 'POST', '/reconcile', undefined, t('Reconcile started', '已开始对账'))}>
            {t('Reconcile', '对账')}
          </Button>
        </div>
      </div>

      {st.mode === 'off' ? (
        <Alert kind="warning">{t('Integration is off. PMS changes are not sent to GRMS. Switch to Simulator or Real UAT above.', '集成已关闭，PMS 变更不会发送到 GRMS。请在右上角切换到模拟器或真实 UAT。')}</Alert>
      ) : (
        <>
          <Tabs tabs={tabs} value={curTab} onChange={setTab} />
          {curTab === 'rooms' && <RoomsTab st={st} onOpen={setDrawer} />}
          {curTab === 'orders' && <OrdersTab st={st} />}
          {curTab === 'jobs' && <JobsTab st={st} />}
          {curTab === 'log' && <LogTab st={st} />}
          {curTab === 'devices' && <DevicesTab st={st} />}
          {curTab === 'settings' && <SettingsTab st={st} />}
          {curTab === 'sim' && <SimTab st={st} />}
        </>
      )}
      <RealUatModal open={uatOpen} onClose={() => setUatOpen(false)} />
      <RoomDetailDrawer roomId={drawer} onClose={() => setDrawer(null)} />
    </div>
  );
}
