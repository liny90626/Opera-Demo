import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { drift, isRoomReady, queueReservations, roomStatusTile, roomSummary, type DiscrepancyType, type HkStatus } from '@opera-demo/core';
import { useStore } from '../store';
import { useT } from '../i18n';
import { Tile } from '../components/ui';
import { StatusIcon, HK_STATUSES, useLabels } from '../components/status';
import './Dashboard.css';

/** Number that links (teal) when > 0 and flashes when the value changes. */
function Num({ value, to, className }: { value: number | string; to?: string; className?: string }) {
  const prev = useRef(value);
  const [fl, setFl] = useState(false);
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setFl(true);
      const h = setTimeout(() => setFl(false), 2400);
      return () => clearTimeout(h);
    }
  }, [value]);
  const zero = value === 0 || value === '0';
  const cls = ['dnum', zero && 'zero', fl && 'flash', className].filter(Boolean).join(' ');
  if (to && !zero) return <Link className={cls} to={to}>{value}</Link>;
  return <span className={cls}>{value}</span>;
}

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

const BedIcon = () => (
  <svg width="44" height="34" viewBox="0 0 44 34" fill="none" stroke="#1b6fa8" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" aria-hidden>
    <path d="M3 28V6M3 22h38v6M41 22v-6a5 5 0 0 0-5-5H17v11" />
    <circle cx="10" cy="15" r="3.5" />
  </svg>
);
const ConeIcon = () => (
  <svg width="40" height="34" viewBox="0 0 40 34" aria-hidden>
    <path d="M17 4h6l8 24H9z" fill="#f08a1c" />
    <path d="M14 15h12M11.5 22h17" stroke="#fff" strokeWidth="3" />
    <rect x="4" y="28" width="32" height="4" rx="1" fill="#f08a1c" />
  </svg>
);
const SlashIcon = () => (
  <svg width="36" height="34" viewBox="0 0 36 34" fill="none" stroke="#f08a1c" strokeWidth="4" aria-hidden>
    <circle cx="18" cy="17" r="12" />
    <path d="M9.5 25.5l17-17" />
  </svg>
);
const ClockIcon = () => (
  <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden>
    <circle cx="28" cy="28" r="26" fill="none" stroke="#d6247a" strokeWidth="4" />
    <path d="M28 14v15l10 6" fill="none" stroke="#d6247a" strokeWidth="4" strokeLinecap="round" />
  </svg>
);

export default function Dashboard() {
  const { snapshot, views, actor } = useStore();
  const t = useT();
  const l = useLabels();
  const nav = useNavigate();
  const p = snapshot.hotel.parameters;
  const [now, setNow] = useState(Date.now());
  const [tab, setTab] = useState<'rooms' | 'fd' | 'sync'>('rooms');
  const [updated, setUpdated] = useState(() => new Date());

  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(h);
  }, []);
  useEffect(() => setUpdated(new Date()), [snapshot.version]);

  const tile = useMemo(() => roomStatusTile(views), [views]);
  const sum = useMemo(() => roomSummary(snapshot, views), [snapshot, views]);
  const queue = useMemo(() => queueReservations(snapshot), [snapshot]);
  const waits = queue.map((r) => Math.max(0, Math.round((now - new Date(r.queue!.queuedAt).getTime()) / 60000)));
  const curWait = waits.length ? Math.max(...waits) : 0;
  const avgWait = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0;
  const readyQ = queue.filter((r) => r.roomId && isRoomReady(snapshot, snapshot.rooms.find((x) => x.id === r.roomId)!)).length;
  const vacantByHk = HK_STATUSES.map((s) => ({ s, n: views.filter((v) => !v.oooActive && v.foStatus === 'Vacant' && v.hkStatus === s).length }));

  const disc: Record<DiscrepancyType, number> = { Skip: 0, Sleep: 0, Person: 0 };
  views.forEach((v) => v.discrepancies.forEach((d) => disc[d]++));

  const D = snapshot.hotel.businessDate;
  const checkedIn = snapshot.reservations.filter((r) => r.status === 'InHouse' && r.arrival === D && r.arrival !== r.departure).length;

  const prog = snapshot.attendants.map((a) => {
    const rs = views.filter((v) => v.attendantId === a.id);
    const done = rs.filter((v) => v.hkStatus === 'Clean' || v.hkStatus === 'Inspected');
    const cr = rs.reduce((x, v) => x + v.credits, 0);
    const crDone = done.reduce((x, v) => x + v.credits, 0);
    return { a, total: rs.length, done: done.length, cr, crDone };
  });
  const unassigned = views.filter((v) => !v.attendantId && !v.oooActive && (v.hkStatus === 'Dirty' || v.hkStatus === 'Pickup')).length;

  const subHealth = snapshot.subscribers.map((s) => {
    const failed = snapshot.deliveries.filter((d) => d.subscriberId === s.id && d.status === 'FAILED').length;
    const dr = drift(snapshot, s).length;
    const color = !s.enabled ? '#9a9a9a' : failed > 0 ? 'var(--st-dirty)' : dr > 0 ? 'var(--st-pickup)' : 'var(--st-inspected)';
    return { s, failed, dr, color };
  });
  const totFailed = subHealth.reduce((x, h) => x + h.failed, 0);
  const totDrift = subHealth.reduce((x, h) => x + h.dr, 0);
  const shortName = (id: string, name: string) => id.replace('SUB-', '') || name;

  const board = (q: string) => `/inventory/housekeeping-board?${q}`;
  const go = (path: string) => () => nav(path);
  const jump = (k: typeof tab, id: string) => {
    setTab(k);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const user = actor.name;
  const hk = (s: HkStatus) => (s === 'Inspected' && !p.inspectedStatusEnabled) || (s === 'Pickup' && !p.pickupStatusEnabled);
  const arrow = (to: string): ReactNode => (
    <Link to={to} aria-label="open" style={{ color: 'var(--oc-link)', textDecoration: 'none', fontSize: 16, padding: '0 4px' }}>↗</Link>
  );

  return (
    <div className="page">
      <div className="dash-hello">
        <h1>{t('Hello', '你好')}, {user}!</h1>
        <span className="upd">{t('Dashboard last updated at', '仪表板更新于')} {updated.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div className="dash-tabs" role="tablist">
        <button className={tab === 'rooms' ? 'on' : ''} onClick={() => jump('rooms', 'dash-rooms')}>{t('Rooms', '房间')}</button>
        <button className={tab === 'fd' ? 'on' : ''} onClick={() => jump('fd', 'dash-fd')}>{t('Front Desk', '前台')}</button>
        <button className={tab === 'sync' ? 'on' : ''} onClick={() => jump('sync', 'dash-sync')}>{t('Sync', '同步')}</button>
      </div>

      <div className="dash-grid">
        <div className="s8" id="dash-rooms">
          <Tile title={t('Room Status', '房间状态')} onTitleClick={go('/inventory/room-grid')} actions={arrow('/inventory/room-grid')}>
            <div className="rs-cols">
              {tile.map((c) => {
                const na = hk(c.status);
                return (
                  <div key={c.status} className={`rs-col${na ? ' na' : ''}`}>
                    <Link to={board(`hk=${c.status}`)} className="ico" title={l.status(c.status)}>
                      <StatusIcon status={c.status} size={56} />
                    </Link>
                    <div className="rs-box">
                      {na ? (
                        <div className="r"><span>{l.status(c.status)}</span><span>N/A</span></div>
                      ) : (
                        <>
                          <div className="r"><span>{t('Occupied', '住客')}</span><Num value={c.occupied} to={board(`hk=${c.status}&fo=Occupied`)} /></div>
                          <div className="r"><span>{t('Assigned', '已排房')}</span><Num value={c.assigned} to={board(`hk=${c.status}&fo=Vacant&resv=Arrival`)} /></div>
                          <div className="r"><span>{t('Vacant', '空房')}</span><Num value={c.vacant} to={board(`hk=${c.status}&fo=Vacant&resv=NotArrival`)} /></div>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Tile>
        </div>

        <div className="s4">
          <Tile title={t('Queue Reservations', '排队预订')} onTitleClick={go('/front-desk/queue')} actions={arrow('/front-desk/queue')}>
            <div className="q-top">
              <ClockIcon />
              <div className="q-box">
                <div className="big"><Num value={queue.length} to="/front-desk/queue" className="big" /></div>
                <div className="lbl">{t('In Queue', '排队中')}{queue.length ? ` · ${t('ready rooms', '房已就绪')} ${readyQ}/${queue.length}` : ''}</div>
              </div>
            </div>
            <div className="q-times">
              <div><div className="v">{hhmm(curWait)}</div><div className="l">{t('Current Wait Time', '当前等待时间')}</div></div>
              <div><div className="v">{hhmm(avgWait)}</div><div className="l">{t('Average Wait Time to Check In', '平均入住等待时间')}</div></div>
            </div>
            <div className="q-vac">
              <h4>{t('Vacant Room Status', '空房房态')}</h4>
              <div className="items">
                {vacantByHk.map(({ s, n }) => (
                  <div key={s} className="it" title={l.status(s)}>
                    <StatusIcon status={s} size={28} />
                    <Num value={n} to={board(`hk=${s}&fo=Vacant`)} />
                  </div>
                ))}
              </div>
            </div>
          </Tile>
        </div>

        <div className="s4">
          <Tile title={t('Room Summary', '房间汇总')}>
            <div className="sum-grid">
              <div className="sum-it"><BedIcon /><div><Num className="n" value={sum.physical} to={board('')} /><div className="l">{t('Physical Rooms', '物理房数')}</div></div></div>
              <div className="sum-it"><BedIcon /><div><Num className="n" value={sum.inventory} /><div className="l">{t('Inventory Rooms', '库存房数')}</div></div></div>
              <div className="sum-it"><ConeIcon /><div><Num className="n" value={sum.outOfOrder} to="/inventory/out-of-order?type=OOO" /><div className="l">{t('Out of Order', '维修房')}</div></div></div>
              <div className="sum-it"><SlashIcon /><div><Num className="n" value={sum.outOfService} to="/inventory/out-of-order?type=OOS" /><div className="l">{t('Out of Service', '停用房')}</div></div></div>
            </div>
            <div className="tile-foot muted">{t('Occupancy', '入住率')} <b>{sum.occupancyPct}%</b> · {sum.occupied} {t('occupied', '占用')}</div>
          </Tile>
        </div>

        <div className="s4" id="dash-fd">
          <Tile title={t('Arrivals', '预抵')} onTitleClick={go('/front-desk/arrivals?filter=unassigned')} actions={arrow('/front-desk/arrivals?filter=unassigned')}>
            <div className="two-stats">
              <div className="st"><Num className="n" value={sum.arrivalsExpected} to="/front-desk/arrivals" /><div className="l">{t('Expected', '预计')}</div></div>
              <div className="st"><Num className="n" value={sum.arrivalsUnassigned} to="/front-desk/arrivals?filter=unassigned" /><div className="l">{t('Unassigned', '未排房')}</div></div>
              <div className="st"><Num className="n" value={checkedIn} to="/front-desk/in-house" /><div className="l">{t('Checked-in', '已入住')}</div></div>
              <div className="st"><Num className="n" value={sum.arrivalsExpected - sum.arrivalsUnassigned} /><div className="l">{t('Assigned', '已排房')}</div></div>
            </div>
          </Tile>
        </div>
        <div className="s4">
          <Tile title={t('Departures', '预离')} onTitleClick={go('/front-desk/in-house?tab=dueout')} actions={arrow('/front-desk/in-house?tab=dueout')}>
            <div className="two-stats">
              <div className="st"><Num className="n" value={sum.departuresExpected} to="/front-desk/in-house?tab=dueout" /><div className="l">{t('Expected', '预计')}</div></div>
              <div className="st"><Num className="n" value={sum.departed} /><div className="l">{t('Departed', '已离店')}</div></div>
            </div>
          </Tile>
        </div>

        <div className="s8">
          <Tile title={t('Housekeeping Progress by Attendant', '客房员清洁进度')} onTitleClick={go('/inventory/task-sheets')} actions={arrow('/inventory/task-sheets')}>
            {prog.map(({ a, total, done, cr, crDone }) => (
              <div key={a.id} className="prog-row">
                <Link className="nm" to={`/inventory/task-sheets?att=${a.id}`}>{a.name}</Link>
                <div className="prog-bar" title={`${crDone}/${cr} credits`}><i style={{ width: `${cr ? (crDone / cr) * 100 : 0}%` }} /></div>
                <span className="meta">{done}/{total} {t('rooms', '间')} · {crDone}/{cr} cr</span>
              </div>
            ))}
            <div className="prog-row">
              <span>{t('Unassigned', '未分配')}</span>
              <div className="prog-bar" />
              <span className="meta"><Num value={unassigned} to={board('att=none&hk=Dirty,Pickup')} /> {t('rooms to clean', '间待清洁')}</span>
            </div>
          </Tile>
        </div>

        <div className="s4 dash-col" id="dash-sync">
          <Tile title={t('Discrepancies', '房态差异')} onTitleClick={go('/inventory/discrepancies')} actions={arrow('/inventory/discrepancies')}>
            <div className="disc-row">
              {(['Skip', 'Sleep', 'Person'] as DiscrepancyType[]).map((d) => (
                <div key={d}>
                  <Num className="n" value={disc[d]} to={`/inventory/discrepancies?type=${d}`} />
                  <span className="l">{d}</span>
                </div>
              ))}
            </div>
          </Tile>
          <Tile title={t('Sync Health', '同步健康')} onTitleClick={go('/integration/sync-monitor')} actions={arrow('/integration/sync-monitor')}>
            <div className="sync-dots">
              {subHealth.map(({ s, color, failed, dr }) => (
                <Link key={s.id} className="sync-dot" to={`/integration/sync-monitor?tab=subscribers&sub=${s.id}`} title={`${s.name} · failed ${failed} · drift ${dr}${s.enabled ? '' : ' · disabled'}`}>
                  <i style={{ background: color }} />
                  {shortName(s.id, s.name)}
                </Link>
              ))}
            </div>
            <div className="disc-row">
              <div><Num className="n" value={totFailed} to="/integration/sync-monitor?tab=deliveries" /><span className="l">{t('Failed', '失败')}</span></div>
              <div><Num className="n" value={totDrift} to="/integration/sync-monitor?tab=subscribers" /><span className="l">{t('Drift', '漂移')}</span></div>
            </div>
          </Tile>
        </div>
      </div>
    </div>
  );
}
