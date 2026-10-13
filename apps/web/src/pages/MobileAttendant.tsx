import { useEffect, useMemo, useRef, useState } from 'react';
import type { HkStatus, RoomView } from '@opera-demo/core';
import { useStore, useIsRecent } from '../store';
import { useT } from '../i18n';
import { STATUS_COLOR, useLabels } from '../components/status';
import './MobileAttendant.css';

const LS_KEY = 'opera-demo:attendant';
const readAtt = () => {
  try {
    return localStorage.getItem(LS_KEY);
  } catch {
    return null;
  }
};

type Filter = 'all' | 'Dirty' | 'Pickup' | 'done';

function RoomCard({ v, onAct, busy }: { v: RoomView; onAct: (cmd: Parameters<ReturnType<typeof useStore>['exec']>[0]) => Promise<void>; busy: boolean }) {
  const { snapshot } = useStore();
  const t = useT();
  const l = useLabels();
  const recent = useIsRecent(v.id);
  const [open, setOpen] = useState(false);
  const [persons, setPersons] = useState(v.hkPersons ?? v.persons ?? 1);
  const ooo = v.displayStatus === 'OutOfOrder' || v.displayStatus === 'OutOfService';
  const opts: HkStatus[] = ['Clean', ...(snapshot.hotel.parameters.pickupStatusEnabled ? (['Pickup'] as HkStatus[]) : []), 'Dirty'];
  const set = (s: HkStatus) => onAct({ type: 'setHkStatus', roomIds: [v.id], status: s });
  return (
    <div className={['mob-card', ooo && 'disabled', recent && 'flash'].filter(Boolean).join(' ')} style={{ borderLeftColor: STATUS_COLOR[v.displayStatus] }} data-room={v.id}>
      <div className="hd" onClick={() => setOpen(!open)}>
        <span className="no">{v.number}</span>
        <span style={{ fontSize: 12 }}>{v.roomType}</span>
        <span style={{ marginLeft: 'auto', fontWeight: 600, color: STATUS_COLOR[v.displayStatus] }}>{l.status(v.displayStatus)}</span>
        {v.queued && <span className="rush">RUSH</span>}
        <span className="sub">
          {l.fo(v.foStatus)} · {l.resv(v.resvStatus)}
          {v.serviceStatus ? ` · ${v.serviceStatus}` : ''} · {v.credits} cr {open ? '▴' : '▾'}
        </span>
      </div>
      {ooo ? (
        <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>{t('Out of order – contact supervisor', '维修/停用房 – 请联系主管')}</div>
      ) : (
        <div className="mob-btns">
          {opts.map((s) => (
            <button key={s} disabled={busy || v.hkStatus === s} className={`mob-btn${v.hkStatus === s ? ' on' : ''}`} style={{ borderColor: STATUS_COLOR[s], background: v.hkStatus === s ? STATUS_COLOR[s] : '#fff', color: v.hkStatus === s ? (s === 'Pickup' ? '#3a2600' : '#fff') : STATUS_COLOR[s] }} onClick={() => set(s)}>
              {l.status(s)}
            </button>
          ))}
        </div>
      )}
      {open && !ooo && (
        <div className="mob-det">
          <div className="r">
            <span className="lb">{t('Observed', '查房')}</span>
            {(['Vacant', 'Occupied'] as const).map((o) => (
              <button key={o} className={`mob-sm${v.hkOccupancy === o ? ' on' : ''}`} disabled={busy} onClick={() => onAct({ type: 'setHkOccupancy', roomId: v.id, occupancy: o, persons: o === 'Occupied' ? persons : undefined })}>
                {l.hkOcc(o)}
              </button>
            ))}
          </div>
          <div className="r">
            <span className="lb">{t('Persons', '人数')}</span>
            <span className="mob-step">
              <button aria-label="minus" onClick={() => setPersons(Math.max(0, persons - 1))}>−</button>
              <b style={{ minWidth: 18, textAlign: 'center' }}>{persons}</b>
              <button aria-label="plus" onClick={() => setPersons(Math.min(9, persons + 1))}>+</button>
            </span>
            <button className="mob-sm" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => onAct({ type: 'setHkOccupancy', roomId: v.id, occupancy: 'Occupied', persons })}>
              {t('Report', '提交')}
            </button>
          </div>
          <div className="r">
            <span className="lb">DND</span>
            <button className={`mob-sm${v.serviceStatus === 'DND' ? ' on' : ''}`} disabled={busy || (v.foStatus !== 'Occupied' && v.serviceStatus !== 'DND')} title={v.foStatus !== 'Occupied' ? t('Only for occupied rooms', '仅占用房可用') : undefined} onClick={() => onAct({ type: 'setServiceStatus', roomIds: [v.id], service: v.serviceStatus === 'DND' ? null : 'DND' })}>
              {v.serviceStatus === 'DND' ? t('DND on', 'DND 已开') : t('DND off', 'DND 未开')}
            </button>
            {v.foStatus !== 'Occupied' && <span className="muted" style={{ fontSize: 11 }}>{t('Occupied rooms only', '仅占用房')}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function MobileAttendant() {
  const { snapshot, views, exec, conn, remotePulse, toast } = useStore();
  const t = useT();
  const [attId, setAttId] = useState<string | null>(() => readAtt());
  const [filter, setFilter] = useState<Filter>('all');
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [synced, setSynced] = useState<number | null>(null);
  const [pulse, setPulse] = useState(false);
  const att = snapshot.attendants.find((a) => a.id === attId) ?? null;
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setPulse(true);
    const h = setTimeout(() => setPulse(false), 1300);
    return () => clearTimeout(h);
  }, [remotePulse]);
  useEffect(() => {
    if (synced === null) return;
    const h = setTimeout(() => setSynced(null), 3000);
    return () => clearTimeout(h);
  }, [synced]);

  const pick = (id: string) => {
    setAttId(id);
    try {
      localStorage.setItem(LS_KEY, id);
    } catch {
      /* ignore */
    }
  };

  const mine = useMemo(() => views.filter((v) => v.attendantId === attId), [views, attId]);
  const rank = (v: RoomView) => (v.queued ? 0 : v.hkStatus === 'Dirty' ? 1 : v.hkStatus === 'Pickup' ? 2 : 3);
  const list = useMemo(() => {
    let rs = showAll ? views.filter((v) => v.attendantId === attId || v.hkStatus === 'Dirty' || v.hkStatus === 'Pickup') : mine;
    if (filter === 'Dirty' || filter === 'Pickup') rs = rs.filter((v) => v.hkStatus === filter);
    if (filter === 'done') rs = rs.filter((v) => v.hkStatus === 'Clean' || v.hkStatus === 'Inspected');
    return [...rs].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  }, [views, mine, showAll, filter, attId]);
  const done = mine.filter((v) => v.hkStatus === 'Clean' || v.hkStatus === 'Inspected');
  const cr = mine.reduce((x, v) => x + v.credits, 0);
  const crDone = done.reduce((x, v) => x + v.credits, 0);
  const rush = mine.filter((v) => v.queued && v.hkStatus !== 'Clean' && v.hkStatus !== 'Inspected');

  const act = async (cmd: Parameters<typeof exec>[0]) => {
    if (!att) return;
    setBusy(true);
    const r = await exec(cmd, { actor: { name: att.name, source: 'MOBILE' }, silentSuccess: true, silentError: true });
    setBusy(false);
    if (r.ok) {
      setSynced(Date.now());
      toast('success', r.message ?? 'OK');
      try {
        navigator.vibrate?.(20);
      } catch {
        /* ignore */
      }
    } else toast('error', `${r.error ?? 'Error'}${r.errorCode ? ` (${r.errorCode})` : ''}`);
  };

  const counts = { Dirty: mine.filter((v) => v.hkStatus === 'Dirty').length, Pickup: mine.filter((v) => v.hkStatus === 'Pickup').length };
  const offline = conn !== 'online';
  const FILTERS: [Filter, string][] = [['all', t('All', '全部')], ['Dirty', `${t('Dirty', '脏房')} ${counts.Dirty}`], ...(snapshot.hotel.parameters.pickupStatusEnabled ? ([['Pickup', `${t('Pickup', '小清扫')} ${counts.Pickup}`]] as [Filter, string][]) : []), ['done', `${t('Done', '已完成')} ${done.length}`]];

  return (
    <div className="page">
      <div className="mob-wrap">
        <div className="mob-frame">
          <div className="mob-top">
            <h2>{t('Room Status', '房间状态')}</h2>
            <span className={`mob-conn${offline ? ' off' : ''}${pulse ? ' pulse' : ''}`}><i />{offline ? t('Reconnecting', '重连中') : 'Live'}</span>
            {att && (
              <select value={att.id} onChange={(e) => pick(e.target.value)} aria-label="attendant">
                {snapshot.attendants.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            )}
          </div>
          {!att ? (
            <div className="mob-pick">
              <b>{t('Who are you?', '请选择客房员')}</b>
              {snapshot.attendants.map((a) => {
                const n = views.filter((v) => v.attendantId === a.id).length;
                return (
                  <button key={a.id} onClick={() => pick(a.id)}>
                    <span>{a.name}</span>
                    <span className="muted">{a.section ? `${t('Section', '区域')} ${a.section} · ` : ''}{n} {t('rooms', '间')}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <>
              <div className="mob-sum">
                <b>{att.name}</b> · {att.section ? `${t('Section', '区域')} ${att.section} · ` : ''}{done.length}/{mine.length} {t('rooms done', '间完成')} · {crDone}/{cr} cr
                <div className="mob-bar"><i style={{ width: `${cr ? (crDone / cr) * 100 : 0}%` }} /></div>
              </div>
              {rush.length > 0 && <div className="mob-rush">⚡ {t('Rush', '加急')}: {rush.map((v) => v.number).join(', ')} – {t('guest waiting', '客人等待')}</div>}
              <div className="mob-chips">
                {FILTERS.map(([k, lab]) => (
                  <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{lab}</button>
                ))}
                <label><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />{t('All Dirty/Pickup', '所有脏房')}</label>
              </div>
              <div className="mob-list">
                {list.length === 0 ? (
                  <div className="mob-empty">{mine.length === 0 && !showAll ? t('No rooms assigned. Ask your supervisor to generate task sheets.', '尚未分配房间，请联系主管生成任务单。') : t('No rooms in this filter.', '此筛选下没有房间。')}</div>
                ) : (
                  list.map((v) => <RoomCard key={v.id} v={v} onAct={act} busy={busy} />)
                )}
              </div>
            </>
          )}
          <div className="mob-foot">
            <span>
              {synced && <span className="mob-synced">{t('synced', '已同步')} ✓ </span>}
              {t('Open the Housekeeping Board in another tab to watch live sync', '在另一标签页打开房务看板，观看实时同步')}
            </span>
            <a href="#/inventory/housekeeping-board" target="_blank" rel="noreferrer">{t('Open Board', '打开看板')} ↗</a>
          </div>
        </div>
      </div>
    </div>
  );
}
