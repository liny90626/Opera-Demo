import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { DiscrepancyType, RoomView } from '@opera-demo/core';
import { useStore } from '../store';
import { useT } from '../i18n';
import { Button, Checkbox, Chips, Confirm, DataTable, EmptyState, Field, PageHeader, SearchPanel, TextInput, type Column, type MenuItem } from '../components/ui';
import { RoomDetailDrawer } from '../components/RoomDialogs';
import { DiscrepancyBadge, FoBadge, StatusBadge, roomNo, useLabels } from '../components/status';
import { MultiSelect, RowMenu, getList, inRoomRange, isTrue, norm, patchParams, useFlash } from './housekeepingboard/shared';

const TYPES: DiscrepancyType[] = ['Skip', 'Sleep', 'Person'];
interface Row {
  key: string;
  v: RoomView;
  type: DiscrepancyType;
}

export default function Discrepancies() {
  const { snapshot, views, exec, toast } = useStore();
  const t = useT();
  const l = useLabels();
  const nav = useNavigate();
  const flashing = useFlash();
  const [sp, setSp] = useSearchParams();
  const [selected, setSelected] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<string[] | null>(null); // room ids
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string | null>(null);

  const from = sp.get('from') ?? '';
  const to = sp.get('to') ?? '';
  const floors = getList(sp, 'floor');
  const rtypes = getList(sp, 'rtype');
  const dueOut = isTrue(sp.get('dueout'));
  const typeParam = getList(sp, 'type').map(norm);
  const types: DiscrepancyType[] = typeParam.length ? TYPES.filter((x) => typeParam.includes(norm(x))) : TYPES;
  const setF = (patch: Record<string, string | string[] | null>) => setSp((p) => patchParams(p, patch), { replace: true });

  const allRows = useMemo(() => views.flatMap((v) => v.discrepancies.map((d): Row => ({ key: `${v.id}|${d}`, v, type: d }))), [views]);
  const rows = allRows.filter(
    (r) =>
      types.includes(r.type) &&
      inRoomRange(r.v.number, from, to) &&
      (!floors.length || floors.includes(String(r.v.floor))) &&
      (!rtypes.length || rtypes.includes(r.v.roomType)) &&
      (!dueOut || r.v.resvStatus === 'Due Out'),
  );
  const keys = new Set(rows.map((r) => r.key));
  const sel = selected.filter((k) => keys.has(k));
  const selRooms = [...new Set(sel.map((k) => k.split('|')[0]))];
  const floorList = [...new Set(views.map((v) => v.floor))].sort((a, b) => a - b);
  const filtered = !!(from || to || floors.length || rtypes.length || dueOut || typeParam.length);

  const resolve = async (ids: string[]) => {
    setBusy(true);
    let ok = 0;
    let already = 0;
    for (const id of ids) {
      const r = await exec({ type: 'resolveDiscrepancy', roomId: id }, { silentError: true, silentSuccess: true });
      if (r.ok) ok++;
      else if (r.errorCode === 'VALIDATION') already++;
      else toast('error', r.error ?? 'Error');
    }
    setBusy(false);
    setConfirm(null);
    setSelected([]);
    if (ok) toast('success', t(`Discrepancy resolved for ${ok} room(s)`, `已处理 ${ok} 间房的房态差异`));
    if (already) toast('info', t(`Already resolved (${already})`, `已被他人处理 (${already})`));
  };

  const rowMenu = (r: Row): MenuItem[] => [
    { label: t('Resolve', '处理差异'), onClick: () => setConfirm([r.v.id]) },
    ...(r.type === 'Skip' ? [{ label: t('Check Out…', '退房…'), onClick: () => nav(`/front-desk/in-house?room=${r.v.number}&action=checkout`) }] : []),
    ...(r.type === 'Sleep' ? [{ label: t('Check In…', '入住…'), onClick: () => nav(`/front-desk/arrivals?room=${r.v.number}`) }] : []),
    { label: t('Room History', '房间历史'), onClick: () => setHistory(r.v.id) },
    { label: t('Set Room Status', '设置房态'), onClick: () => setHistory(r.v.id) },
  ];

  const hint = (d: DiscrepancyType) => (d === 'Skip' ? t('FO Occupied / HK Vacant', '前台有客 / 房务无人') : d === 'Sleep' ? t('FO Vacant / HK Occupied', '前台空房 / 房务有人') : t('Person count differs', '人数不一致'));
  const columns: Column<Row>[] = [
    { key: 'room', header: t('Room', '房号'), sortValue: (r) => r.v.number.padStart(4, '0'), render: (r) => <b data-room={r.v.id}>{r.v.number}</b> },
    { key: 'type', header: t('Type', '房型'), sortValue: (r) => r.v.roomType, render: (r) => r.v.roomType },
    { key: 'disc', header: t('Discrepancy', '差异'), sortValue: (r) => r.type, render: (r) => <span title={hint(r.type)}><DiscrepancyBadge type={r.type} /></span> },
    { key: 'fo', header: t('FO Status', '前台状态'), render: (r) => <FoBadge status={r.v.foStatus} /> },
    { key: 'hk', header: t('HK Status', '房务状态'), render: (r) => <span className="row-wrap" style={{ gap: 6 }}><StatusBadge status={r.v.displayStatus} /><span className="muted">{l.hkOcc(r.v.hkOccupancy)}</span></span> },
    { key: 'fop', header: t('FO Pers', '前台人数'), align: 'center', render: (r) => r.v.persons },
    { key: 'hkp', header: t('HK Pers', '房务人数'), align: 'center', render: (r) => <span style={r.type === 'Person' ? { color: '#d9730d', fontWeight: 700 } : undefined}>{r.v.hkPersons ?? '-'}</span> },
    { key: 'guest', header: t('Guest / Resv', '客人 / 预订'), render: (r) => (r.v.inHouse ? `${r.v.inHouse.guestName} #${r.v.inHouse.confirmationNo}` : <span className="subtle">—</span>) },
    {
      key: 'act',
      header: t('Action', '操作'),
      width: 130,
      render: (r) => (
        <span className="row" style={{ gap: 2 }}>
          <Button size="sm" variant="primary" onClick={() => setConfirm([r.v.id])}>{t('Resolve', '处理')}</Button>
          <RowMenu items={rowMenu(r)} label={t('More actions', '更多操作')} />
        </span>
      ),
    },
  ];

  const confirmV = confirm?.length === 1 ? snapshot.rooms.find((r) => r.id === confirm[0]) : undefined;
  const confirmSkip = confirm?.some((id) => views.find((v) => v.id === id)?.discrepancies.includes('Skip'));

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[{ label: t('Inventory', '房务') }, { label: t('Room Management', '房间管理') }, { label: t('Room Discrepancies', '房态差异') }]}
        title={t('Room Discrepancies', '房态差异')}
        sub={t('Rooms where Housekeeping and Front Office disagree (Skip / Sleep / Person).', '房务与前台不一致的房间（Skip / Sleep / Person）。')}
      />
      <SearchPanel title={t('Search', '搜索')} onClear={() => setSp({}, { replace: true })} clearLabel={t('Clear', '清除')}>
        <Field label={t('Room From', '房号从')}><TextInput value={from} onChange={(v) => setF({ from: v })} /></Field>
        <Field label={t('To', '至')}><TextInput value={to} onChange={(v) => setF({ to: v })} /></Field>
        <Field label={t('Floor', '楼层')}>
          <MultiSelect width="100%" value={floors} onChange={(v) => setF({ floor: v })} options={floorList.map((f) => ({ value: String(f), label: String(f) }))} allLabel={t('All', '全部')} />
        </Field>
        <Field label={t('Room Type', '房型')}>
          <MultiSelect width="100%" value={rtypes} onChange={(v) => setF({ rtype: v })} options={snapshot.roomTypes.map((r) => ({ value: r.code, label: `${r.code} – ${r.name}` }))} allLabel={t('All', '全部')} />
        </Field>
        <Field label={t('Discrepancy', '差异类型')}>
          <Chips options={TYPES.map((x) => ({ value: x, label: x }))} value={types} onChange={(v) => setF({ type: v.length === TYPES.length || v.length === 0 ? null : v })} />
        </Field>
        <Field label=" ">
          <Checkbox checked={dueOut} onChange={(v) => setF({ dueout: v ? '1' : null })} label={t('Due Out Only', '仅预离')} />
        </Field>
      </SearchPanel>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.key}
        selectable
        selected={sel}
        onSelectedChange={setSelected}
        rowClassName={(r) => (flashing(r.v.id) ? 'flash' : undefined)}
        initialSort={{ key: 'room', dir: 'asc' }}
        toolbar={
          <>
            <span>
              {t('Results', '结果')} <b>{rows.length}</b>
              {sel.length > 0 && <> · <b>{sel.length}</b> {t('selected', '已选')}</>}
            </span>
            <span className="spacer" />
            <Button variant="primary" disabled={!sel.length} onClick={() => setConfirm(selRooms)}>{t('Resolve Selected', '批量处理')}</Button>
          </>
        }
        empty={
          filtered && allRows.length ? (
            <EmptyState title={t('No discrepancies match your search', '没有符合条件的差异')} action={<Button onClick={() => setSp({}, { replace: true })}>{t('Clear filters', '清除筛选')}</Button>} />
          ) : (
            <EmptyState title={t('No discrepancies — Front Office and Housekeeping agree ✔', '无房态差异 — 前台与房务一致 ✔')} />
          )
        }
      />

      <Confirm
        open={!!confirm}
        title={t('Resolve Discrepancy', '处理房态差异')}
        confirmLabel={busy ? '…' : t('Resolve', '处理')}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && resolve(confirm)}
        message={
          <div className="col">
            <div>
              {confirm?.length === 1
                ? t(`Align Housekeeping status with Front Office for room ${confirmV?.number}?`, `将 ${confirmV?.number} 房的房务状态与前台对齐？`)
                : t(`Align Housekeeping status with Front Office for ${confirm?.length} rooms (${confirm?.map(roomNo).join(', ')})?`, `将 ${confirm?.length} 间房（${confirm?.map(roomNo).join('、')}）的房务状态与前台对齐？`)}
            </div>
            {confirmSkip && <div className="muted">{t('Skip: verify the guest has actually left before resolving.', 'Skip：请先核实客人是否已离店再处理。')}</div>}
          </div>
        }
      />
      <RoomDetailDrawer roomId={history} onClose={() => setHistory(null)} />
    </div>
  );
}
