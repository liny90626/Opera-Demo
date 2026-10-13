import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { HkOccupancy, HkStatus, RoomView, ServiceStatus, TurndownStatus } from '@opera-demo/core';
import { useStore } from '../store';
import { useT } from '../i18n';
import { Alert, ActionMenu, Button, Checkbox, DataTable, Drawer, EmptyState, Field, KV, Modal, PageHeader, SearchPanel, Select, TextInput, type Column, type MenuItem } from '../components/ui';
import { OutOfOrderDialog, RoomDetailDrawer } from '../components/RoomDialogs';
import { ALL_DISPLAY_STATUSES, DiscrepancyBadge, FoBadge, HK_STATUSES, ResvStatusBadge, ServiceBadge, StatusBadge, StatusIcon, fmtDateTime, fmtTime, roomNo, useLabels } from '../components/status';
import { FilterChip, MultiSelect, RowMenu, getList, inRoomRange, isTrue, norm, patchParams, shortDate, useFlash } from './housekeepingboard/shared';
import './HousekeepingBoard.css';

type ModalKind = 'status' | 'service' | 'turndown' | 'condition' | 'attendant';

const RESV_OPTIONS = ['Arrival', 'Arrived', 'Stay Over', 'Due Out', 'Departed', 'Day Use', 'Not Reserved'];

// ====================================================================== page
export default function HousekeepingBoard() {
  const { snapshot, views, viewById } = useStore();
  const t = useT();
  const l = useLabels();
  const [sp, setSp] = useSearchParams();
  const flashing = useFlash();
  const nav = useNavigate();
  const [selected, setSelected] = useState<string[]>([]);
  const [modal, setModal] = useState<ModalKind | null>(null);
  const [modalRooms, setModalRooms] = useState<string[]>([]);
  const [ooo, setOoo] = useState<string[] | null>(null);
  const [history, setHistory] = useState<string | null>(sp.get('history'));
  const [resvRoom, setResvRoom] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  // ---- filters (URL is the single source of truth, so deep links and the panel stay in sync)
  const F = {
    from: sp.get('from') ?? '',
    to: sp.get('to') ?? '',
    floor: getList(sp, 'floor'),
    type: getList(sp, 'type'),
    hk: getList(sp, 'hk'),
    fo: getList(sp, 'fo'),
    resv: getList(sp, 'resv'),
    svc: getList(sp, 'svc'),
    td: getList(sp, 'td'),
    att: getList(sp, 'att'),
    cond: getList(sp, 'cond'),
    sec: getList(sp, 'sec'),
    disc: isTrue(sp.get('disc')),
    dueout: isTrue(sp.get('dueout')),
    queue: isTrue(sp.get('queue')),
  };
  const setF = (patch: Record<string, string | string[] | null>) => setSp((p) => patchParams(p, patch), { replace: true });
  const hasMore = F.resv.length + F.svc.length + F.td.length + F.att.length + F.cond.length + F.sec.length > 0 || F.disc || F.dueout || F.queue;
  useEffect(() => {
    if (hasMore) setMoreOpen(true);
  }, [hasMore]);
  useEffect(() => {
    const h = sp.get('history');
    if (h) setHistory(h);
  }, [sp]);

  const matches = (v: RoomView) => {
    if (!inRoomRange(v.number, F.from, F.to)) return false;
    if (F.floor.length && !F.floor.includes(String(v.floor))) return false;
    if (F.type.length && !F.type.map((x) => x.toUpperCase()).includes(v.roomType.toUpperCase())) return false;
    if (F.hk.length) {
      const set = F.hk.map((x) => {
        const n = norm(x);
        return n === 'ooo' ? 'outoforder' : n === 'oos' ? 'outofservice' : n;
      });
      if (!set.includes(norm(v.displayStatus))) return false;
    }
    if (F.fo.length && !F.fo.map(norm).includes(norm(v.foStatus))) return false;
    if (F.resv.length) {
      const ok = F.resv.some((r) => {
        const n = norm(r);
        if (n === 'notarrival') return v.foStatus === 'Vacant' && !v.arrival;
        return norm(v.resvStatus) === n;
      });
      if (!ok) return false;
    }
    if (F.svc.length && !F.svc.some((s) => (norm(s) === 'none' ? !v.serviceStatus : norm(s) === norm(v.serviceStatus ?? '-')))) return false;
    if (F.td.length && !F.td.map(norm).includes(norm(v.turndown))) return false;
    if (F.att.length && !F.att.some((a) => (['none', 'unassigned'].includes(norm(a)) ? !v.attendantId : a === v.attendantId))) return false;
    if (F.cond.length && !F.cond.some((c) => (norm(c) === 'none' ? !v.conditionCode : c === v.conditionCode))) return false;
    if (F.sec.length && !F.sec.includes(v.section)) return false;
    if (F.disc && !v.discrepancies.length) return false;
    if (F.dueout && v.resvStatus !== 'Due Out') return false;
    if (F.queue && !v.queued) return false;
    return true;
  };
  const rows = views.filter(matches);
  const rowIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const selIds = selected.filter((id) => rowIds.has(id));
  const hasFilters = [...sp.keys()].some((k) => ['from', 'to', 'floor', 'type', 'hk', 'fo', 'resv', 'svc', 'td', 'att', 'cond', 'sec', 'disc', 'dueout', 'queue'].includes(k));
  const clearAll = () => setSp((p) => patchParams(p, Object.fromEntries(['from', 'to', 'floor', 'type', 'hk', 'fo', 'resv', 'svc', 'td', 'att', 'cond', 'sec', 'disc', 'dueout', 'queue'].map((k) => [k, null]))), { replace: true });

  // ---- status summary (counts BEFORE filtering)
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const v of views) c[v.displayStatus] = (c[v.displayStatus] ?? 0) + 1;
    return c;
  }, [views]);
  const p = snapshot.hotel.parameters;
  const hkNorm = F.hk.map((x) => {
    const n = norm(x);
    return n === 'ooo' ? 'outoforder' : n === 'oos' ? 'outofservice' : n;
  });
  const toggleStatus = (s: string) => setF({ hk: hkNorm.length === 1 && hkNorm[0] === norm(s) ? null : s });

  // ---- actions
  const open = (kind: ModalKind, ids: string[]) => {
    setModalRooms(ids);
    setModal(kind);
  };
  const withSel = (n: number, exactly = false) => (exactly ? selIds.length === n : selIds.length >= n);
  const needSel = t('Select at least one room', '请至少选择一间房');
  const single = selIds.length === 1 ? viewById.get(selIds[0]) : undefined;
  const resvOf = (v?: RoomView) => v?.inHouse ?? v?.arrival ?? v?.departed ?? null;
  const menuItems: MenuItem[] = [
    { group: t('Room Status', '房态') },
    { label: t('Set Room Status', '设置房态'), disabled: !withSel(1), onClick: () => open('status', selIds) },
    { label: t('Set Service Status', '设置服务状态'), disabled: !withSel(1), onClick: () => open('service', selIds) },
    { label: t('Set Turndown', '设置开夜床'), disabled: !withSel(1), onClick: () => open('turndown', selIds) },
    { label: t('Room Condition', '房间条件'), disabled: !withSel(1), onClick: () => open('condition', selIds) },
    { label: t('Assign Attendant', '分配客房员'), disabled: !withSel(1), onClick: () => open('attendant', selIds) },
    { divider: true },
    { label: t('Place Out of Order / Out of Service', '设置维修房 / 停用房'), disabled: !withSel(1), onClick: () => setOoo(selIds) },
    { divider: true },
    { label: t('Room History', '房间历史'), disabled: !withSel(1, true), onClick: () => setHistory(selIds[0]) },
    { label: t('View Reservation', '查看预订'), disabled: !(single && resvOf(single)), onClick: () => setResvRoom(selIds[0]) },
  ];
  if (!withSel(1)) menuItems.splice(1, 0, { group: `(${needSel})` });

  const rowMenu = (v: RoomView): MenuItem[] => [
    { label: t('Set Room Status', '设置房态'), onClick: () => open('status', [v.id]) },
    { label: t('Assign Attendant', '分配客房员'), onClick: () => open('attendant', [v.id]) },
    { label: v.outOfOrder ? t('Out of Order / Service record exists', '已有维修/停用记录') : t('Place Out of Order / Service', '设置维修房 / 停用房'), disabled: !!v.outOfOrder, onClick: () => setOoo([v.id]) },
    { label: t('Room History', '房间历史'), onClick: () => setHistory(v.id) },
    ...(resvOf(v) ? [{ label: t('View Reservation', '查看预订'), onClick: () => setResvRoom(v.id) }] : []),
    ...(v.discrepancies.length ? [{ label: t('Resolve Discrepancy', '处理房态差异'), onClick: () => nav(`/inventory/discrepancies?type=${v.discrepancies[0]}`) }] : []),
  ];

  // ---- columns
  const attName = (id: string | null) => snapshot.attendants.find((a) => a.id === id)?.name ?? null;
  const columns: Column<RoomView>[] = [
    {
      key: 'room',
      header: t('Room', '房号'),
      sortValue: (v) => v.number.padStart(4, '0'),
      render: (v) => (
        <span data-room={v.id} className="nowrap">
          <b>{v.number}</b>
          {v.conditionCode && <span className="badge neutral hk-mini" title={snapshot.conditions.find((c) => c.code === v.conditionCode)?.description}>{v.conditionCode}</span>}
        </span>
      ),
    },
    {
      key: 'type',
      header: t('Room Type', '房型'),
      sortValue: (v) => v.roomType,
      render: (v) => (
        <span className="nowrap" title={v.roomTypeName}>
          {v.roomType}
          {v.queued && <span className="badge warn hk-mini" title={t('Queue room: guest waiting', '排队房：客人等候中')}>⏳Q</span>}
        </span>
      ),
    },
    {
      key: 'hk',
      header: t('HK Status', '房务状态'),
      sortValue: (v) => ALL_DISPLAY_STATUSES.indexOf(v.displayStatus),
      render: (v) => (
        <span title={v.outOfOrder ? `${v.outOfOrder.type} ${shortDate(v.outOfOrder.from)} → ${shortDate(v.outOfOrder.to)} · ${v.outOfOrder.reasonCode}` : undefined}>
          <StatusBadge status={v.displayStatus} />
        </span>
      ),
    },
    { key: 'fo', header: t('FO Status', '前台状态'), sortValue: (v) => v.foStatus, render: (v) => <FoBadge status={v.foStatus} /> },
    { key: 'resv', header: t('Reservation Status', '预订状态'), sortValue: (v) => v.resvStatus, render: (v) => <ResvStatusBadge status={v.resvStatus} /> },
    {
      key: 'guest',
      header: t('Guest', '客人'),
      sortValue: (v) => resvOf(v)?.guestName ?? '',
      render: (v) => {
        const r = resvOf(v);
        return r ? (
          <span className="nowrap">
            {r.guestName}
            {r.vip && <span className="hk-vip" title={`VIP ${r.vip}`} />}
          </span>
        ) : (
          ''
        );
      },
    },
    {
      key: 'dates',
      header: t('Arr / Dep', '抵 / 离'),
      sortValue: (v) => resvOf(v)?.departure ?? '',
      render: (v) => {
        const r = resvOf(v);
        return r ? <span className="nowrap">{shortDate(r.arrival)} / {shortDate(r.departure)}</span> : '';
      },
    },
    {
      key: 'pers',
      header: t('Persons', '人数'),
      align: 'center',
      render: (v) => (
        <span className={v.discrepancies.includes('Person') ? 'hk-warn' : undefined} title={t('FO / HK persons', '前台 / 房务人数')}>
          {v.persons}/{v.hkPersons ?? '-'}
        </span>
      ),
    },
    { key: 'svc', header: t('Service', '服务'), render: (v) => <ServiceBadge service={v.serviceStatus} /> },
    { key: 'td', header: t('Turndown', '开夜床'), sortValue: (v) => v.turndown, render: (v) => (v.turndown === 'Not Required' ? <span className="subtle">-</span> : v.turndown) },
    { key: 'att', header: t('Attendant', '客房员'), sortValue: (v) => attName(v.attendantId) ?? '~', render: (v) => attName(v.attendantId) ?? <span className="subtle">—</span> },
    {
      key: 'disc',
      header: t('Discrepancy', '差异'),
      render: (v) => (
        <span className="row" style={{ gap: 4 }}>
          {v.discrepancies.map((d) => (
            <DiscrepancyBadge key={d} type={d} />
          ))}
        </span>
      ),
    },
    {
      key: 'last',
      header: t('Last Change', '最后变更'),
      sortValue: (v) => v.lastStatusChange,
      render: (v) => (
        <span className="nowrap subtle" title={`${fmtDateTime(v.lastStatusChange)} · ${v.lastChangedBy}`}>
          {fmtTime(v.lastStatusChange)} {v.lastChangedBy}
        </span>
      ),
    },
    { key: 'act', header: '', width: 40, render: (v) => <RowMenu items={rowMenu(v)} label={t('Actions', '操作')} /> },
  ];

  // ---- applied-filter chips
  const chips: { k: string; label: string; remove: () => void }[] = [];
  const listChip = (key: string, vals: string[], name: string, fmt: (s: string) => string = (s) => s) =>
    vals.forEach((v) => chips.push({ k: `${key}:${v}`, label: `${name}: ${fmt(v)}`, remove: () => setF({ [key]: vals.filter((x) => x !== v) }) }));
  if (F.from || F.to) chips.push({ k: 'range', label: `${t('Room', '房号')}: ${F.from || '…'} – ${F.to || '…'}`, remove: () => setF({ from: null, to: null }) });
  listChip('floor', F.floor, t('Floor', '楼层'));
  listChip('type', F.type, t('Room Type', '房型'));
  listChip('hk', F.hk, t('HK', '房务'), (s) => (hkLabel(norm(s)) ? l.status(hkLabel(norm(s))!) : s));
  listChip('fo', F.fo, t('FO', '前台'));
  listChip('resv', F.resv, t('Resv', '预订'), (s) => (norm(s) === 'notarrival' ? t('Vacant, no arrival', '空房无预抵') : s));
  listChip('svc', F.svc, t('Service', '服务'));
  listChip('td', F.td, t('Turndown', '开夜床'));
  listChip('att', F.att, t('Attendant', '客房员'), (s) => (['none', 'unassigned'].includes(norm(s)) ? t('Unassigned', '未分配') : attName(s) ?? s));
  listChip('cond', F.cond, t('Condition', '条件'));
  listChip('sec', F.sec, t('Section', '区域'));
  if (F.disc) chips.push({ k: 'disc', label: t('Discrepancies only', '仅差异'), remove: () => setF({ disc: null }) });
  if (F.dueout) chips.push({ k: 'dueout', label: t('Due Out only', '仅预离'), remove: () => setF({ dueout: null }) });
  if (F.queue) chips.push({ k: 'queue', label: t('Queue rooms only', '仅排队房'), remove: () => setF({ queue: null }) });

  const floors = [...new Set(views.map((v) => v.floor))].sort((a, b) => a - b);
  const sections = [...new Set(views.map((v) => v.section))].sort();
  const histRoom = history ? viewById.get(history) : undefined;
  const resvView = resvRoom ? viewById.get(resvRoom) : undefined;

  return (
    <div className="page hk-board">
      <PageHeader
        breadcrumb={[{ label: t('Inventory', '房务') }, { label: t('Room Management', '房间管理') }, { label: t('Housekeeping Board', '房务看板') }]}
        title={t('Housekeeping Board', '房务看板')}
        actions={<ActionMenu items={menuItems} />}
      />

      <SearchPanel
        title={t('Search', '搜索')}
        onClear={clearAll}
        clearLabel={t('Clear', '清除')}
        extra={
          <Button variant="link" onClick={() => setMoreOpen((o) => !o)}>
            {moreOpen ? t('Fewer Filters', '收起筛选') : t('More Filters', '更多筛选')} {moreOpen ? '▲' : '▼'}
          </Button>
        }
      >
        <Field label={t('Room From', '房号从')}>
          <TextInput value={F.from} onChange={(v) => setF({ from: v })} placeholder="101" />
        </Field>
        <Field label={t('To', '至')}>
          <TextInput value={F.to} onChange={(v) => setF({ to: v })} placeholder="999" />
        </Field>
        <Field label={t('Floor', '楼层')}>
          <MultiSelect width="100%" value={F.floor} onChange={(v) => setF({ floor: v })} options={floors.map((f) => ({ value: String(f), label: String(f) }))} allLabel={t('All', '全部')} />
        </Field>
        <Field label={t('Room Type', '房型')}>
          <MultiSelect width="100%" value={F.type} onChange={(v) => setF({ type: v })} options={snapshot.roomTypes.map((r) => ({ value: r.code, label: `${r.code} – ${r.name}` }))} allLabel={t('All', '全部')} />
        </Field>
        <Field label={t('HK Status', '房务状态')}>
          <MultiSelect
            width="100%"
            value={hkNorm.map((n) => hkLabel(n) ?? n)}
            onChange={(v) => setF({ hk: v })}
            options={ALL_DISPLAY_STATUSES.filter((s) => (s !== 'Inspected' || p.inspectedStatusEnabled) && (s !== 'Pickup' || p.pickupStatusEnabled)).map((s) => ({ value: s, label: l.status(s) }))}
            allLabel={t('All', '全部')}
          />
        </Field>
        <Field label={t('FO Status', '前台状态')}>
          <MultiSelect width="100%" value={F.fo.map((x) => (norm(x) === 'occupied' ? 'Occupied' : 'Vacant'))} onChange={(v) => setF({ fo: v })} options={[{ value: 'Vacant', label: l.fo('Vacant') }, { value: 'Occupied', label: l.fo('Occupied') }]} allLabel={t('All', '全部')} />
        </Field>
        {moreOpen && (
          <>
            <Field label={t('Reservation Status', '预订状态')}>
              <MultiSelect
                width="100%"
                value={F.resv.map((x) => (norm(x) === 'notarrival' ? 'NotArrival' : RESV_OPTIONS.find((o) => norm(o) === norm(x)) ?? x))}
                onChange={(v) => setF({ resv: v })}
                options={[...RESV_OPTIONS.map((r) => ({ value: r, label: l.resv(r as never) })), { value: 'NotArrival', label: t('Vacant, no arrival', '空房无预抵') }]}
                allLabel={t('All', '全部')}
              />
            </Field>
            <Field label={t('Service Status', '服务状态')}>
              <MultiSelect width="100%" value={F.svc} onChange={(v) => setF({ svc: v })} options={[{ value: 'DND', label: 'DND' }, { value: 'MUR', label: 'MUR' }, { value: 'none', label: t('None', '无') }]} allLabel={t('All', '全部')} />
            </Field>
            <Field label={t('Turndown', '开夜床')}>
              <MultiSelect width="100%" value={F.td.map((x) => (['Not Required', 'Required', 'Completed'].find((o) => norm(o) === norm(x)) ?? x))} onChange={(v) => setF({ td: v })} options={['Not Required', 'Required', 'Completed'].map((x) => ({ value: x, label: x }))} allLabel={t('All', '全部')} />
            </Field>
            <Field label={t('Attendant', '客房员')}>
              <MultiSelect width="100%" value={F.att} onChange={(v) => setF({ att: v })} options={[{ value: 'none', label: t('Unassigned', '未分配') }, ...snapshot.attendants.map((a) => ({ value: a.id, label: a.name }))]} allLabel={t('All', '全部')} />
            </Field>
            <Field label={t('Condition', '房间条件')}>
              <MultiSelect width="100%" value={F.cond} onChange={(v) => setF({ cond: v })} options={[{ value: 'none', label: t('None', '无') }, ...snapshot.conditions.map((c) => ({ value: c.code, label: `${c.code} – ${c.description}` }))]} allLabel={t('All', '全部')} />
            </Field>
            <Field label={t('Section', '区域')}>
              <MultiSelect width="100%" value={F.sec} onChange={(v) => setF({ sec: v })} options={sections.map((s) => ({ value: s, label: s }))} allLabel={t('All', '全部')} />
            </Field>
            <div className="hk-checks">
              <Checkbox checked={F.disc} onChange={(v) => setF({ disc: v ? '1' : null })} label={t('Discrepancies only', '仅差异')} />
              <Checkbox checked={F.dueout} onChange={(v) => setF({ dueout: v ? '1' : null })} label={t('Due Out only', '仅预离')} />
              <Checkbox checked={F.queue} onChange={(v) => setF({ queue: v ? '1' : null })} label={t('Queue rooms only', '仅排队房')} />
            </div>
          </>
        )}
      </SearchPanel>

      {/* status summary bar */}
      <div className="hk-summary" role="group" aria-label={t('Room status summary', '房态汇总')}>
        {ALL_DISPLAY_STATUSES.map((s) => (
          <button key={s} type="button" className={'hk-sum' + (hkNorm.length === 1 && hkNorm[0] === norm(s) ? ' on' : '')} onClick={() => toggleStatus(s)} title={l.status(s)}>
            <StatusIcon status={s} size={26} />
            <span className="n">{counts[s] ?? 0}</span>
            <span className="lbl">{l.status(s)}</span>
          </button>
        ))}
      </div>

      {chips.length > 0 && (
        <div className="row-wrap" style={{ marginBottom: 8 }}>
          {chips.map((c) => (
            <FilterChip key={c.k} onRemove={c.remove}>{c.label}</FilterChip>
          ))}
          <Button variant="link" size="sm" onClick={clearAll}>{t('Clear filters', '清除筛选')}</Button>
        </div>
      )}

      <div
        onDoubleClick={(e) => {
          const el = (e.target as HTMLElement).closest('tr')?.querySelector<HTMLElement>('[data-room]');
          if (el?.dataset.room && !(e.target as HTMLElement).closest('button,input,a')) setHistory(el.dataset.room);
        }}
      >
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(v) => v.id}
          selectable
          selected={selIds}
          onSelectedChange={setSelected}
          rowClassName={(v) => (flashing(v.id) ? 'flash' : undefined)}
          pageSize={100}
          initialSort={{ key: 'room', dir: 'asc' }}
          toolbar={
            <>
              <span>
                {t('Results', '结果')} <b>{rows.length}</b>
                {selIds.length > 0 && (
                  <>
                    {' · '}
                    <b>{selIds.length}</b> {t('selected', '已选')}{' '}
                    <Button variant="link" size="sm" onClick={() => setSelected([])}>{t('Clear selection', '清除选择')}</Button>
                  </>
                )}
              </span>
              <span className="spacer" />
              <Button disabled={!selIds.length} title={selIds.length ? undefined : needSel} onClick={() => open('status', selIds)}>{t('Set Room Status', '设置房态')}</Button>
              <Button disabled={!selIds.length} title={selIds.length ? undefined : needSel} onClick={() => open('attendant', selIds)}>{t('Assign Attendant', '分配客房员')}</Button>
            </>
          }
          empty={
            <EmptyState
              title={t('No rooms match your search', '没有符合条件的房间')}
              hint={t('Try removing some filters.', '请尝试放宽筛选条件。')}
              action={hasFilters ? <Button onClick={clearAll}>{t('Clear filters', '清除筛选')}</Button> : undefined}
            />
          }
        />
      </div>

      <SetStatusModal open={modal === 'status'} roomIds={modalRooms} onClose={() => setModal(null)} />
      <BulkModal kind={modal && modal !== 'status' ? modal : null} roomIds={modalRooms} onClose={() => setModal(null)} />
      <OutOfOrderDialog open={!!ooo} roomIds={ooo ?? []} onClose={() => setOoo(null)} onDone={() => setSelected([])} />
      <RoomDetailDrawer
        roomId={histRoom ? histRoom.id : null}
        onClose={() => {
          setHistory(null);
          if (sp.get('history')) setSp((p) => patchParams(p, { history: null }), { replace: true });
        }}
      />
      <Drawer open={!!resvView} onClose={() => setResvRoom(null)} title={`${t('Reservation', '预订')} · ${t('Room', '房间')} ${resvView?.number ?? ''}`} width={460}>
        {resvView && resvOf(resvView) ? <ReservationSummary v={resvView} /> : null}
      </Drawer>
    </div>
  );
}

function hkLabel(n: string): 'Inspected' | 'Clean' | 'Pickup' | 'Dirty' | 'OutOfOrder' | 'OutOfService' | undefined {
  return ({ inspected: 'Inspected', clean: 'Clean', pickup: 'Pickup', dirty: 'Dirty', outoforder: 'OutOfOrder', outofservice: 'OutOfService' } as const)[n as 'clean'];
}

// ====================================================================== reservation summary
function ReservationSummary({ v }: { v: RoomView }) {
  const t = useT();
  const r = v.inHouse ?? v.arrival ?? v.departed;
  if (!r) return null;
  return (
    <KV
      items={[
        [t('Guest', '客人'), `${r.guestName}${r.vip ? ` (VIP ${r.vip})` : ''}`],
        [t('Confirmation No.', '确认号'), `#${r.confirmationNo}`],
        [t('Status', '状态'), r.status],
        [t('Room', '房间'), `${v.number} (${v.roomType})`],
        [t('Arrival', '抵达'), r.arrival],
        [t('Departure', '离店'), r.departure],
        [t('Guests', '人数'), `${r.adults} + ${r.children}`],
        [t('ETA', '预计到达'), r.eta],
        [t('Specials', '特殊要求'), r.specials.join(', ')],
        [t('Queue', '排队'), r.queue ? `P${r.queue.priority} · ${fmtTime(r.queue.queuedAt)}` : null],
      ]}
    />
  );
}

// ====================================================================== Set Room Status modal
function SetStatusModal({ open, roomIds, onClose }: { open: boolean; roomIds: string[]; onClose: () => void }) {
  const { snapshot, viewById, exec, toast } = useStore();
  const t = useT();
  const l = useLabels();
  const p = snapshot.hotel.parameters;
  const [status, setStatus] = useState<HkStatus | ''>('');
  const [obsOpen, setObsOpen] = useState(false);
  const [occ, setOcc] = useState<HkOccupancy | ''>('');
  const [persons, setPersons] = useState('1');
  const [turndown, setTurndown] = useState<TurndownStatus | ''>('');
  const [err, setErr] = useState<{ text: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setStatus('');
    setObsOpen(false);
    setOcc('');
    setTurndown('');
    setErr(null);
    const v = roomIds.length === 1 ? viewById.get(roomIds[0]) : undefined;
    setPersons(String(Math.max(1, v?.persons ?? 1)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const enabled = (s: HkStatus) => (s === 'Inspected' ? p.inspectedStatusEnabled : s === 'Pickup' ? p.pickupStatusEnabled : true);

  const save = async () => {
    setErr(null);
    if (!status && !(obsOpen && occ) && !turndown) return setErr({ text: t('Choose a room status, an occupancy observation or a turndown value.', '请选择房态、查房结果或开夜床状态。') });
    setBusy(true);
    const msgs: string[] = [];
    let applied = 0;
    try {
      if (status) {
        const r = await exec({ type: 'setHkStatus', roomIds, status }, { silentError: true, silentSuccess: true });
        if (!r.ok) return setErr({ text: r.error ?? 'Error', code: r.errorCode });
        if (r.message) msgs.push(r.message);
        applied++;
      }
      if (obsOpen && occ) {
        const n = Math.max(1, parseInt(persons, 10) || 1);
        for (const id of roomIds) {
          const r = await exec({ type: 'setHkOccupancy', roomId: id, occupancy: occ, persons: occ === 'Occupied' ? n : undefined }, { silentError: true, silentSuccess: true });
          if (!r.ok) return setErr({ text: r.error ?? 'Error', code: r.errorCode });
          applied++;
        }
        msgs.push(t(`${roomIds.length} room(s) observation recorded`, `已记录 ${roomIds.length} 间房的查房结果`));
      }
      if (turndown) {
        const r = await exec({ type: 'setTurndown', roomIds, turndown }, { silentError: true, silentSuccess: true });
        if (!r.ok) return setErr({ text: r.error ?? 'Error', code: r.errorCode });
        if (r.message) msgs.push(r.message);
        applied++;
      }
    } finally {
      setBusy(false);
    }
    if (applied) toast('success', msgs.join(' · '));
    onClose();
  };

  const radio = (label: string, checked: boolean, onChange: () => void, disabled?: boolean, title?: string) => (
    <label className="check" title={title} style={disabled ? { opacity: 0.5 } : undefined}>
      <input type="radio" checked={checked} disabled={disabled} onChange={onChange} />
      {label}
    </label>
  );
  return (
    <Modal
      open={open}
      onClose={onClose}
      width={560}
      title={`${t('Set Room Status', '设置房态')} (${roomIds.length} ${t(roomIds.length === 1 ? 'room' : 'rooms', '间房')})`}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel', '取消')}</Button>
          <Button variant="primary" disabled={busy} onClick={save}>{t('Save', '保存')}</Button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <Field label={t('Room Status', '房态')} required>
          <div className="row-wrap" style={{ gap: 16 }}>
            {HK_STATUSES.map((s) => (
              <span key={s}>{radio(l.status(s), status === s, () => setStatus(s), !enabled(s), enabled(s) ? undefined : t('Not enabled in property parameters (PARAM)', '酒店参数未启用 (PARAM)'))}</span>
            ))}
          </div>
          {(!p.inspectedStatusEnabled || !p.pickupStatusEnabled) && (
            <div className="subtle" style={{ fontSize: 12 }}>
              {t('Inspected / Pickup are disabled by property parameters.', 'Inspected / Pickup 已被酒店参数禁用。')}{' '}
              <Link to="/misc/end-of-day" onClick={onClose}>{t('Open property parameters', '打开酒店参数')}</Link>
            </div>
          )}
        </Field>
        <div>
          <Button variant="link" onClick={() => setObsOpen((o) => !o)}>{obsOpen ? '▾' : '▸'} {t('Housekeeping Status (observation)', '房务查房结果')}</Button>
          {obsOpen && (
            <div className="row-wrap" style={{ gap: 16, padding: '6px 0 0 14px' }}>
              <span className="muted">{t('Occupancy', '占用')}</span>
              {radio(l.hkOcc('Vacant'), occ === 'Vacant', () => setOcc('Vacant'))}
              {radio(l.hkOcc('Occupied'), occ === 'Occupied', () => setOcc('Occupied'))}
              <span className="muted">{t('Persons', '人数')}</span>
              <TextInput type="number" min={1} value={persons} onChange={setPersons} className="hk-persons" />
            </div>
          )}
        </div>
        <Field label={t('Turndown', '开夜床')}>
          <Select value={turndown} onChange={(v) => setTurndown(v)} placeholder={t('— no change —', '— 不变 —')} options={(['Not Required', 'Required', 'Completed'] as TurndownStatus[]).map((x) => ({ value: x, label: x }))} />
        </Field>
        <div className="muted" style={{ fontSize: 12 }}>
          {t('Rooms', '房间')}: {roomIds.map(roomNo).join(', ')}
        </div>
        {err && (
          <Alert kind="error">
            {err.text}
            {err.code === 'PARAM' && (
              <>
                {' '}
                <Link to="/misc/end-of-day" onClick={onClose}>{t('Open property parameters', '打开酒店参数')}</Link>
              </>
            )}
            {err.code && <div className="subtle" style={{ fontSize: 11 }}>{err.code}</div>}
          </Alert>
        )}
      </div>
    </Modal>
  );
}

// ====================================================================== other bulk modals
function BulkModal({ kind, roomIds, onClose }: { kind: Exclude<ModalKind, 'status'> | null; roomIds: string[]; onClose: () => void }) {
  const { snapshot, views, exec } = useStore();
  const t = useT();
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setValue(kind === 'service' ? 'DND' : kind === 'turndown' ? 'Required' : '');
    setErr(null);
  }, [kind]);
  if (!kind) return null;

  const credits = (attId: string) => views.filter((v) => v.attendantId === attId).reduce((s, v) => s + v.credits, 0);
  const cond = snapshot.conditions.find((c) => c.code === value);
  const assignedRooms = cond?.blocksAssignment ? views.filter((v) => roomIds.includes(v.id) && v.arrival) : [];

  const title = { service: t('Set Service Status', '设置服务状态'), turndown: t('Set Turndown', '设置开夜床'), condition: t('Room Condition', '房间条件'), attendant: t('Assign Attendant', '分配客房员') }[kind];

  const save = async () => {
    setErr(null);
    setBusy(true);
    const r =
      kind === 'service'
        ? await exec({ type: 'setServiceStatus', roomIds, service: (value === 'CLEAR' ? null : value) as ServiceStatus }, { silentError: true })
        : kind === 'turndown'
          ? await exec({ type: 'setTurndown', roomIds, turndown: value as TurndownStatus }, { silentError: true })
          : kind === 'condition'
            ? await exec({ type: 'setCondition', roomIds, conditionCode: value || null }, { silentError: true })
            : await exec({ type: 'assignAttendant', roomIds, attendantId: value || null }, { silentError: true });
    setBusy(false);
    if (!r.ok) return setErr(r.error ?? 'Error');
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      width={480}
      title={`${title} (${roomIds.length})`}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel', '取消')}</Button>
          <Button variant="primary" disabled={busy} onClick={save}>{t('Save', '保存')}</Button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        {kind === 'service' && (
          <Field label={t('Service Status', '服务状态')} required>
            <Select value={value} onChange={setValue} options={[{ value: 'DND', label: 'DND – Do Not Disturb' }, { value: 'MUR', label: 'MUR – Make Up Room' }, { value: 'CLEAR', label: t('Clear', '清除') }]} />
            <div className="subtle" style={{ fontSize: 12 }}>{t('Only occupied rooms accept DND / MUR; vacant rooms are skipped.', '仅在住房可设置 DND / MUR，空房将被跳过。')}</div>
          </Field>
        )}
        {kind === 'turndown' && (
          <Field label={t('Turndown', '开夜床')} required>
            <Select value={value} onChange={setValue} options={['Required', 'Not Required', 'Completed'].map((x) => ({ value: x, label: x }))} />
          </Field>
        )}
        {kind === 'condition' && (
          <>
            <Field label={t('Room Condition', '房间条件')}>
              <Select value={value} onChange={setValue} placeholder={t('None', '无')} options={snapshot.conditions.map((c) => ({ value: c.code, label: `${c.code} – ${c.description}${c.blocksAssignment ? ' ⛔' : ''}` }))} />
            </Field>
            {cond?.blocksAssignment && <Alert kind="info">{t(`${cond.code} blocks new room assignments.`, `${cond.code} 将阻止新的排房。`)}</Alert>}
            {assignedRooms.length > 0 && <Alert kind="warning">{t('Already assigned to arrivals: ', '已排给预抵客人：')}{assignedRooms.map((v) => `${v.number} (${v.arrival!.guestName})`).join(', ')}</Alert>}
          </>
        )}
        {kind === 'attendant' && (
          <Field label={t('Attendant', '客房员')}>
            <Select
              value={value}
              onChange={setValue}
              placeholder={t('Unassigned', '未分配')}
              options={snapshot.attendants.map((a) => ({ value: a.id, label: `${a.name} – ${credits(a.id)}/${a.maxCredits} ${t('credits', '点数')}` }))}
            />
          </Field>
        )}
        <div className="muted" style={{ fontSize: 12 }}>{t('Rooms', '房间')}: {roomIds.map(roomNo).join(', ')}</div>
        {err && <Alert kind="error">{err}</Alert>}
      </div>
    </Modal>
  );
}
