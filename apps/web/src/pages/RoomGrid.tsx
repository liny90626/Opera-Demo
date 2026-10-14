import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { DisplayRoomStatus, HkStatus, RoomView } from '@opera-demo/core';
import { useStore, useIsRecent } from '../store';
import { useT } from '../i18n';
import { Button, EmptyState, PageHeader, Select, Checkbox } from '../components/ui';
import { ALL_DISPLAY_STATUSES, HK_STATUSES, STATUS_COLOR, StatusBadge, roomNo, useLabels } from '../components/status';
import { RoomDetailDrawer } from '../components/RoomDialogs';
import './RoomGrid.css';

type ViewBy = 'hk' | 'fo' | 'section';
const SECTION_COLOR: Record<string, string> = { A: '#2b7fd6', B: '#2e9e5b', C: '#b7791f', D: '#7a5bd6' };
const ABBR: Record<DisplayRoomStatus, string> = { Inspected: 'IP', Clean: 'CL', Pickup: 'PU', Dirty: 'DI', OutOfOrder: 'OO', OutOfService: 'OS' };
const initials = (n?: string) => (n ? n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() : '');

function tileBg(v: RoomView, by: ViewBy) {
  if (by === 'hk') return STATUS_COLOR[v.displayStatus];
  if (by === 'fo') return v.foStatus === 'Occupied' ? '#4b4b9b' : '#9db8a0';
  return SECTION_COLOR[v.section] ?? '#777';
}

function Tile({ v, by, sel, attName, onClick }: { v: RoomView; by: ViewBy; sel: boolean; attName?: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  const recent = useIsRecent(v.id);
  const { akubela } = useStore();
  const grms = !!akubela && akubela.mode !== 'off' && akubela.mappings.some((m) => m.roomId === v.id && m.residenceId);
  const ooo = v.displayStatus === 'OutOfOrder' || v.displayStatus === 'OutOfService';
  const dark = by === 'hk' && v.displayStatus === 'Pickup';
  const tip = `${v.number} · ${v.roomType} · ${v.displayStatus}/${v.foStatus}/${v.resvStatus}${v.inHouse ? ` · ${v.inHouse.guestName} → ${v.inHouse.departure}` : ''} · ${v.lastChangedBy}`;
  return (
    <button
      data-room={v.id}
      title={tip}
      onClick={onClick}
      className={['rg-tile', sel && 'sel', v.foStatus === 'Occupied' && 'occ', dark && 'dark', ooo && by === 'hk' && 'ooo', recent && 'flash'].filter(Boolean).join(' ')}
      style={{ background: tileBg(v, by) }}
    >
      <span className="n">{v.number}</span>
      <span className="ty">{v.roomType}{by === 'hk' ? ` ${ABBR[v.displayStatus]}` : ''}</span>
      <span className="ic">
        {v.foStatus === 'Occupied' ? '●' : '○'}
        {v.discrepancies.length > 0 && '▲'}
        {v.serviceStatus && v.serviceStatus}
        {v.queued && '⏳'}
        {v.inHouse?.vip && '⚑'}
      </span>
      {grms && (
        <span title="Akubela GRMS" style={{ position: 'absolute', right: 4, bottom: 3, fontSize: 9, fontWeight: 700, lineHeight: 1, padding: '1px 3px', borderRadius: 3, background: 'rgba(255,255,255,.85)', color: '#8a5a00' }}>G</span>
      )}
      {attName && <span className="at">{initials(attName)}</span>}
    </button>
  );
}

function Popover({ v, anchor, onClose, onHistory }: { v: RoomView; anchor: DOMRect; onClose: () => void; onHistory: () => void }) {
  const { exec, snapshot, recentRooms } = useStore();
  const t = useT();
  const l = useLabels();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const p = snapshot.hotel.parameters;
  const [persons, setPersons] = useState(v.hkPersons ?? v.persons ?? 1);
  const att = snapshot.attendants.find((a) => a.id === v.attendantId);
  const lastChange = useRef(v.lastStatusChange);
  const [updatedBy, setUpdatedBy] = useState<string | null>(null);
  useEffect(() => {
    if (lastChange.current !== v.lastStatusChange) {
      lastChange.current = v.lastStatusChange;
      setUpdatedBy(v.lastChangedBy);
    }
  }, [v.lastStatusChange, v.lastChangedBy]);
  void recentRooms;

  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 260;
    const w = Math.min(330, window.innerWidth - 16);
    let left = anchor.left;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
    let top = anchor.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, anchor.top - h - 6);
    setPos({ left: Math.max(8, left), top });
  }, [anchor, updatedBy]);
  useEffect(() => {
    const md = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (ref.current?.contains(el) || el.closest('.rg-tile')) return;
      onClose();
    };
    const kd = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', md);
    document.addEventListener('keydown', kd);
    return () => {
      document.removeEventListener('mousedown', md);
      document.removeEventListener('keydown', kd);
    };
  }, [onClose]);

  const ooo = v.displayStatus === 'OutOfOrder' || v.displayStatus === 'OutOfService';
  const statuses = HK_STATUSES.filter((s) => (s !== 'Inspected' || p.inspectedStatusEnabled) && (s !== 'Pickup' || p.pickupStatusEnabled));
  const setHk = (s: HkStatus) => exec({ type: 'setHkStatus', roomIds: [v.id], status: s });
  return (
    <div ref={ref} className="rg-pop" style={pos} role="dialog">
      <h4>{v.number} · {v.roomType} · {l.fo(v.foStatus)}</h4>
      {updatedBy && <div className="upd">{t('Updated by', '已被更新：')} {updatedBy}</div>}
      <div className="rw"><span className="lb">{t('Display', '显示')}</span><StatusBadge status={v.displayStatus} /> <span className="muted">{t('Attendant', '客房员')}: {att?.name ?? '—'}</span></div>
      <div className="rw">
        <span className="lb">{t('Set to', '设置为')}</span>
        {statuses.map((s) => (
          <Button key={s} size="sm" disabled={ooo || v.hkStatus === s} onClick={() => setHk(s)}>{l.status(s)}</Button>
        ))}
      </div>
      {ooo && (
        <div className="rw"><span className="lb" />
          <Link to="/inventory/out-of-order" style={{ color: 'var(--oc-link)' }}>{t('Return to Service', '恢复使用')}</Link></div>
      )}
      <div className="rw">
        <span className="lb">{t('HK observed', '房务查房')}</span>
        {(['Vacant', 'Occupied'] as const).map((o) => (
          <Button key={o} size="sm" variant={v.hkOccupancy === o ? 'primary' : 'secondary'} disabled={ooo} onClick={() => exec({ type: 'setHkOccupancy', roomId: v.id, occupancy: o, persons: o === 'Occupied' ? persons : undefined })}>{l.hkOcc(o)}</Button>
        ))}
        <input className="input" type="number" min={0} max={9} value={persons} style={{ width: 52, height: 24 }} onChange={(e) => setPersons(+e.target.value)} aria-label="persons" />
      </div>
      {v.foStatus === 'Occupied' && (
        <div className="rw">
          <span className="lb">{t('Service', '服务')}</span>
          <Button size="sm" variant={v.serviceStatus === 'DND' ? 'primary' : 'secondary'} onClick={() => exec({ type: 'setServiceStatus', roomIds: [v.id], service: 'DND' })}>DND</Button>
          <Button size="sm" variant={v.serviceStatus === 'MUR' ? 'primary' : 'secondary'} onClick={() => exec({ type: 'setServiceStatus', roomIds: [v.id], service: 'MUR' })}>MUR</Button>
          <Button size="sm" disabled={!v.serviceStatus} onClick={() => exec({ type: 'setServiceStatus', roomIds: [v.id], service: null })}>{t('Clear', '清除')}</Button>
        </div>
      )}
      <div className="rw" style={{ justifyContent: 'space-between' }}>
        <Button size="sm" onClick={onHistory}>{t('Room History', '房间历史')}</Button>
        <Link style={{ color: 'var(--oc-link)' }} to={`/inventory/housekeeping-board?from=${roomNo(v.id)}&to=${roomNo(v.id)}`}>{t('More… → Board', '更多… → 看板')}</Link>
      </div>
    </div>
  );
}

export default function RoomGrid() {
  const { views, snapshot } = useStore();
  const t = useT();
  const l = useLabels();
  const [sp, setSp] = useSearchParams();
  const [by, setBy] = useState<ViewBy>('hk');
  const [floor, setFloor] = useState('');
  const [type, setType] = useState('');
  const [onlyDirty, setOnlyDirty] = useState(false);
  const [onlyDisc, setOnlyDisc] = useState(false);
  const [sel, setSel] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [hist, setHist] = useState<string | null>(sp.get('history'));
  const closePop = useMemo(() => () => setSel(null), []);

  const floors = useMemo(() => [...new Set(views.map((v) => v.floor))].sort((a, b) => b - a), [views]);
  const filtered = views.filter(
    (v) => (!floor || String(v.floor) === floor) && (!type || v.roomType === type) && (!onlyDirty || v.displayStatus === 'Dirty' || v.displayStatus === 'Pickup') && (!onlyDisc || v.discrepancies.length > 0),
  );
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    ALL_DISPLAY_STATUSES.forEach((s) => (m[s] = 0));
    filtered.forEach((v) => m[v.displayStatus]++);
    return m;
  }, [filtered]);
  const selView = sel ? views.find((v) => v.id === sel.id) : undefined;
  const attName = (id: string | null) => snapshot.attendants.find((a) => a.id === id)?.name;

  return (
    <div className="page">
      <PageHeader
        title={t('Room Status Grid', '房态网格')}
        breadcrumb={[{ label: t('Inventory', '房务') }, { label: t('Room Management', '房间管理') }]}
        actions={
          <div className="rg-seg" role="group" aria-label="view by">
            {([['hk', 'HK Status'], ['fo', 'FO Status'], ['section', 'Section']] as [ViewBy, string][]).map(([k, lab]) => (
              <button key={k} className={by === k ? 'on' : ''} onClick={() => setBy(k)}>{lab}</button>
            ))}
          </div>
        }
      />
      <div className="rg-bar">
        <Select value={floor} onChange={(v) => setFloor(v)} placeholder={t('All floors', '全部楼层')} options={[{ value: '', label: t('All floors', '全部楼层') }, ...floors.map((f) => ({ value: String(f), label: `${t('Floor', '楼层')} ${f}` }))]} />
        <Select value={type} onChange={(v) => setType(v)} placeholder={t('All types', '全部房型')} options={[{ value: '', label: t('All types', '全部房型') }, ...snapshot.roomTypes.map((r) => ({ value: r.code, label: `${r.code} – ${r.name}` }))]} />
        <Checkbox checked={onlyDirty} onChange={setOnlyDirty} label={t('Dirty / Pickup only', '仅脏房/小清扫')} />
        <Checkbox checked={onlyDisc} onChange={setOnlyDisc} label={t('Discrepancies only', '仅差异')} />
        <span className="rg-chip">{filtered.length} {t('rooms', '间')}</span>
      </div>
      <div className="rg-legend">
        {by === 'hk' && ALL_DISPLAY_STATUSES.map((s) => (
          <span key={s} className="lg"><i style={{ background: STATUS_COLOR[s] }} />{l.status(s)} ({ABBR[s]}) <b>{counts[s]}</b></span>
        ))}
        {by === 'fo' && <><span className="lg"><i style={{ background: '#4b4b9b' }} />{t('Occupied', '住客')}</span><span className="lg"><i style={{ background: '#9db8a0' }} />{t('Vacant', '空房')}</span></>}
        {by === 'section' && Object.entries(SECTION_COLOR).map(([k, c]) => <span key={k} className="lg"><i style={{ background: c }} />{t('Section', '区域')} {k}</span>)}
        <span className="lg">● {t('Occupied', '住客')} ○ {t('Vacant', '空房')}</span>
        <span className="lg">▲ {t('Discrepancy', '差异')}</span>
        <span className="lg">⏳ {t('Queue', '排队')}</span>
        <span className="lg">DND/MUR</span>
        <span className="lg">⚑ VIP</span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState title={t('No rooms match the filters', '没有符合条件的房间')} />
      ) : (
        floors.map((f) => {
          const rs = filtered.filter((v) => v.floor === f);
          if (!rs.length) return null;
          return (
            <div key={f} className="rg-floor">
              <div className="fl">{t('Floor', '楼层')} {f}</div>
              <div className="rg-tiles">
                {rs.map((v) => (
                  <Tile key={v.id} v={v} by={by} sel={sel?.id === v.id} attName={attName(v.attendantId)} onClick={(e) => setSel({ id: v.id, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() })} />
                ))}
              </div>
            </div>
          );
        })
      )}

      {sel && selView && (
        <Popover
          key={sel.id}
          v={selView}
          anchor={sel.rect}
          onClose={closePop}
          onHistory={() => {
            setHist(sel.id);
            setSel(null);
          }}
        />
      )}
      <RoomDetailDrawer
        roomId={hist}
        onClose={() => {
          setHist(null);
          if (sp.get('history')) {
            sp.delete('history');
            setSp(sp, { replace: true });
          }
        }}
      />
    </div>
  );
}
