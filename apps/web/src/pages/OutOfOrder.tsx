import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { addDays, roomSummary, stayOverlaps, type HkStatus, type OutOfOrderType, type RoomView } from '@opera-demo/core';
import { useStore } from '../store';
import { useT } from '../i18n';
import { Alert, Button, Confirm, DataTable, EmptyState, Field, Modal, PageHeader, SearchPanel, Select, Tabs, TextInput, type Column, type MenuItem } from '../components/ui';
import { RoomDetailDrawer } from '../components/RoomDialogs';
import { HK_STATUSES, fmtDate, roomNo, useLabels } from '../components/status';
import { RowMenu, inRoomRange, patchParams, shortDate, useFlash } from './housekeepingboard/shared';
import './OutOfOrder.css';

type Tab = 'all' | 'OOO' | 'OOS' | 'future';
type Rec = RoomView & { outOfOrder: NonNullable<RoomView['outOfOrder']> };

export default function OutOfOrder() {
  const { snapshot, views, exec } = useStore();
  const t = useT();
  const l = useLabels();
  const flashing = useFlash();
  const D = snapshot.hotel.businessDate;
  const [sp, setSp] = useSearchParams();
  const [selected, setSelected] = useState<string[]>([]);
  const [newOpen, setNewOpen] = useState(false);
  const [release, setRelease] = useState<string[] | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const [impact, setImpact] = useState<string | null>(null);

  const tabParam = sp.get('type');
  const tab: Tab = tabParam === 'OOO' || tabParam === 'OOS' ? tabParam : sp.get('tab') === 'future' ? 'future' : 'all';
  const from = sp.get('from') ?? '';
  const to = sp.get('to') ?? '';
  const rtype = sp.get('rtype') ?? '';
  const dFrom = sp.get('dfrom') ?? '';
  const dTo = sp.get('dto') ?? '';
  const reason = sp.get('reason') ?? '';
  const setF = (patch: Record<string, string | null>) => setSp((p) => patchParams(p, patch), { replace: true });
  const setTab = (k: Tab) => setF({ type: k === 'OOO' || k === 'OOS' ? k : null, tab: k === 'future' ? 'future' : null });

  const all = views.filter((v): v is Rec => !!v.outOfOrder);
  const isFuture = (v: Rec) => v.outOfOrder.from > D;
  const base = all.filter(
    (v) =>
      inRoomRange(v.number, from, to) &&
      (!rtype || v.roomType === rtype) &&
      (!reason || v.outOfOrder.reasonCode === reason) &&
      (!dFrom || v.outOfOrder.to >= dFrom) &&
      (!dTo || v.outOfOrder.from <= dTo),
  );
  const tabCount = {
    all: base.length,
    OOO: base.filter((v) => v.outOfOrder.type === 'OOO').length,
    OOS: base.filter((v) => v.outOfOrder.type === 'OOS').length,
    future: base.filter(isFuture).length,
  };
  const rows = base.filter((v) => (tab === 'all' ? true : tab === 'future' ? isFuture(v) : v.outOfOrder.type === tab));
  const keys = new Set(rows.map((r) => r.id));
  const sel = selected.filter((k) => keys.has(k));
  const sum = roomSummary(snapshot, views);

  const columns: Column<Rec>[] = [
    { key: 'room', header: t('Room', '房号'), sortValue: (v) => v.number.padStart(4, '0'), render: (v) => <b>{v.number}</b> },
    { key: 'type', header: t('Type', '房型'), sortValue: (v) => v.roomType, render: (v) => v.roomType },
    { key: 'kind', header: t('Kind', '类别'), sortValue: (v) => v.outOfOrder.type, render: (v) => <span className={`badge st-${v.outOfOrder.type === 'OOO' ? 'OutOfOrder' : 'OutOfService'}`}>{v.outOfOrder.type}</span> },
    { key: 'from', header: t('From', '开始'), sortValue: (v) => v.outOfOrder.from, render: (v) => <span className="nowrap">{shortDate(v.outOfOrder.from)}</span> },
    { key: 'to', header: t('To', '结束'), sortValue: (v) => v.outOfOrder.to, render: (v) => <span className="nowrap">{shortDate(v.outOfOrder.to)}</span> },
    { key: 'reason', header: t('Reason', '原因'), sortValue: (v) => v.outOfOrder.reasonCode, render: (v) => <span title={snapshot.oooReasons.find((r) => r.code === v.outOfOrder.reasonCode)?.description}>{v.outOfOrder.reasonCode}</span> },
    { key: 'ret', header: t('Return Status', '恢复后房态'), render: (v) => l.status(v.outOfOrder.returnStatus) },
    { key: 'rem', header: t('Remarks', '备注'), render: (v) => v.outOfOrder.remarks ?? <span className="subtle">—</span> },
    { key: 'state', header: t('State', '状态'), sortValue: (v) => (isFuture(v) ? 1 : 0), render: (v) => <span className={`badge ${isFuture(v) ? 'info' : 'warn'}`}>{isFuture(v) ? t('Future', '未来') : t('Active', '生效中')}</span> },
    { key: 'act', header: '', width: 40, render: (v) => <RowMenu items={rowMenu(v)} label={t('Actions', '操作')} /> },
  ];
  function rowMenu(v: Rec): MenuItem[] {
    return [
      { label: isFuture(v) ? t('Delete future record', '删除未来记录') : t('Return to Service', '恢复使用'), onClick: () => setRelease([v.id]) },
      { label: t('Room History', '房间历史'), onClick: () => setHistory(v.id) },
      { label: t('Edit (delete and re-create to change dates)', '编辑（请删除后重建以修改日期）'), disabled: true, onClick: () => undefined },
    ];
  }

  const relRooms = (release ?? []).map((id) => views.find((v) => v.id === id)).filter((v): v is RoomView => !!v);
  const doRelease = async () => {
    if (!release) return;
    const r = await exec({ type: 'releaseOutOfOrder', roomIds: release });
    if (r.ok) {
      setRelease(null);
      setSelected([]);
    }
  };
  useEffect(() => {
    if (!impact) return;
    const id = setTimeout(() => setImpact(null), 8000);
    return () => clearTimeout(id);
  }, [impact]);
  const filtered = !!(from || to || rtype || dFrom || dTo || reason);

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[{ label: t('Inventory', '房务') }, { label: t('Room Management', '房间管理') }, { label: t('Out of Order / Out of Service', '维修 / 停用房') }]}
        title={t('Out of Order / Out of Service', '维修 / 停用房')}
        actions={<Button variant="primary" onClick={() => setNewOpen(true)}>+ {t('New', '新建')}</Button>}
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'all', label: t('All', '全部'), count: tabCount.all },
          { key: 'OOO', label: t('Out of Order', '维修房'), count: tabCount.OOO },
          { key: 'OOS', label: t('Out of Service', '停用房'), count: tabCount.OOS },
          { key: 'future', label: t('Future', '未来'), count: tabCount.future },
        ]}
      />
      <SearchPanel title={t('Search', '搜索')} onClear={() => setF({ from: null, to: null, rtype: null, dfrom: null, dto: null, reason: null })} clearLabel={t('Clear', '清除')}>
        <Field label={t('Room From', '房号从')}><TextInput value={from} onChange={(v) => setF({ from: v })} /></Field>
        <Field label={t('To', '至')}><TextInput value={to} onChange={(v) => setF({ to: v })} /></Field>
        <Field label={t('Room Type', '房型')}>
          <Select value={rtype} onChange={(v) => setF({ rtype: v })} placeholder={t('All', '全部')} options={snapshot.roomTypes.map((r) => ({ value: r.code, label: `${r.code} – ${r.name}` }))} />
        </Field>
        <Field label={t('Date From', '日期从')}><TextInput type="date" value={dFrom} onChange={(v) => setF({ dfrom: v })} /></Field>
        <Field label={t('Date To', '日期至')}><TextInput type="date" value={dTo} onChange={(v) => setF({ dto: v })} /></Field>
        <Field label={t('Reason', '原因')}>
          <Select value={reason} onChange={(v) => setF({ reason: v })} placeholder={t('All', '全部')} options={snapshot.oooReasons.map((r) => ({ value: r.code, label: `${r.code} – ${r.description}` }))} />
        </Field>
      </SearchPanel>

      {impact && <Alert kind="success">{impact}</Alert>}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(v) => v.id}
        selectable
        selected={sel}
        onSelectedChange={setSelected}
        rowClassName={(v) => (flashing(v.id) ? 'flash' : undefined)}
        initialSort={{ key: 'room', dir: 'asc' }}
        toolbar={
          <>
            <span>
              {t('Results', '结果')} <b>{rows.length}</b>
              {sel.length > 0 && <> · <b>{sel.length}</b> {t('selected', '已选')}</>}
            </span>
            <span className="spacer" />
            <Button disabled={!sel.length} onClick={() => setRelease(sel)}>{t('Return to Service', '恢复使用')}</Button>
          </>
        }
        empty={
          <EmptyState
            title={filtered ? t('No records match your search', '没有符合条件的记录') : t('No Out of Order / Out of Service records', '暂无维修 / 停用房记录')}
            action={filtered ? <Button onClick={() => setF({ from: null, to: null, rtype: null, dfrom: null, dto: null, reason: null })}>{t('Clear filters', '清除筛选')}</Button> : <Button variant="primary" onClick={() => setNewOpen(true)}>+ {t('New', '新建')}</Button>}
          />
        }
      />

      <div className="card card-pad row-wrap" style={{ marginTop: 12, gap: 10 }} aria-live="polite">
        <b>{t('Inventory impact today', '今日库存影响')}:</b>
        <span>
          {t('Physical', '物理房')} <b>{sum.physical}</b> − OOO <b>{sum.outOfOrder}</b> = {t('Inventory', '可售库存')} <b>{sum.inventory}</b>
        </span>
        <span className="subtle">({t(`OOS ${sum.outOfService} stays in inventory`, `${sum.outOfService} 间 OOS 仍计入库存`)})</span>
      </div>

      <NewDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onShow={(roomNo_) => {
          setNewOpen(false);
          setSp({ from: roomNo_, to: roomNo_ }, { replace: true });
        }}
        onDone={(msg) => setImpact(msg)}
      />

      <Confirm
        open={!!release}
        danger
        title={relRooms.length && relRooms.every((v) => v.outOfOrder && v.outOfOrder.from > D) ? t('Delete future record', '删除未来记录') : t('Return to Service', '恢复使用')}
        confirmLabel={t('Confirm', '确认')}
        onCancel={() => setRelease(null)}
        onConfirm={doRelease}
        message={
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {relRooms.map((v) =>
              v.outOfOrder && v.outOfOrder.from > D ? (
                <li key={v.id}>{t(`Room ${v.number}: the future ${v.outOfOrder.type} record (${fmtDate(v.outOfOrder.from)} – ${fmtDate(v.outOfOrder.to)}) will be deleted.`, `${v.number} 房：未来的 ${v.outOfOrder.type} 记录将被删除。`)}</li>
              ) : (
                <li key={v.id}>
                  {t(`Room ${v.number} will be returned as `, `${v.number} 房将恢复为 `)}
                  <b>{v.outOfOrder ? l.status(v.outOfOrder.returnStatus) : ''}</b>
                </li>
              ),
            )}
          </ul>
        }
      />
      <RoomDetailDrawer roomId={history} onClose={() => setHistory(null)} />
    </div>
  );
}

// ====================================================================== New OOO / OOS dialog (multi-room picker)
function NewDialog({ open, onClose, onDone, onShow }: { open: boolean; onClose: () => void; onDone: (msg: string) => void; onShow: (roomNumber: string) => void }) {
  const { snapshot, views, exec } = useStore();
  const t = useT();
  const l = useLabels();
  const nav = useNavigate();
  const D = snapshot.hotel.businessDate;
  const p = snapshot.hotel.parameters;
  const [type, setType] = useState<OutOfOrderType>('OOO');
  const [rooms, setRooms] = useState<string[]>([]);
  const [from, setFrom] = useState(D);
  const [to, setTo] = useState(addDays(D, 1));
  const [reason, setReason] = useState('');
  const [ret, setRet] = useState<HkStatus>('Dirty');
  const [remarks, setRemarks] = useState('');
  const [q, setQ] = useState('');
  const [pickOpen, setPickOpen] = useState(false);
  const [rFrom, setRFrom] = useState('');
  const [rTo, setRTo] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [apiErr, setApiErr] = useState<{ code?: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setType('OOO');
    setRooms([]);
    setFrom(D);
    setTo(addDays(D, 1));
    setReason('');
    setRet('Dirty');
    setRemarks('');
    setQ('');
    setErrors({});
    setApiErr(null);
    setPickOpen(false);
  }, [open, D]);

  const eligible = views.filter((v) => !v.outOfOrder);
  /** Hint about why OOO would be rejected (final decision is the engine's). */
  const conflict = useMemo(() => {
    const m = new Map<string, string>();
    if (type !== 'OOO') return m;
    for (const v of eligible) {
      const occ = v.inHouse;
      if (occ && stayOverlaps(occ.arrival, occ.departure < D ? D : occ.departure, from, to)) {
        m.set(v.id, t(`Occupied until ${fmtDate(occ.departure)}`, `在住至 ${fmtDate(occ.departure)}`));
        continue;
      }
      const res = snapshot.reservations.find((r) => r.roomId === v.id && r.status === 'Reserved' && stayOverlaps(r.arrival, r.departure, from, to));
      if (res) m.set(v.id, t(`Assigned #${res.confirmationNo}`, `已排房 #${res.confirmationNo}`));
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, from, to, views, snapshot.reservations, D]);

  const matches = eligible.filter((v) => !rooms.includes(v.id) && (!q || v.number.startsWith(q) || v.roomType.toLowerCase() === q.toLowerCase())).slice(0, 60);
  const add = (ids: string[]) => setRooms((r) => [...new Set([...r, ...ids])]);
  const addRange = () => {
    const ids = eligible.filter((v) => (!rFrom || v.number >= rFrom) && (!rTo || v.number <= rTo) && (rFrom || rTo)).map((v) => v.id);
    add(ids);
    setRFrom('');
    setRTo('');
  };
  const enabledRet = HK_STATUSES.filter((s) => (s !== 'Inspected' || p.inspectedStatusEnabled) && (s !== 'Pickup' || p.pickupStatusEnabled));

  const save = async () => {
    const e: Record<string, string> = {};
    if (!rooms.length) e.rooms = t('Select at least one room', '请至少选择一间房');
    if (!from) e.from = t('Required', '必填');
    else if (from < D) e.from = t('Cannot be before the business date', '不能早于营业日期');
    if (!to) e.to = t('Required', '必填');
    else if (from && to < from) e.to = t('Must be on or after From', '不能早于开始日期');
    if (!reason) e.reason = t('Reason is required', '请选择原因');
    setErrors(e);
    setApiErr(null);
    if (Object.keys(e).length) return;
    setBusy(true);
    const before = roomSummary(snapshot, views).inventory;
    const r = await exec({ type: 'placeOutOfOrder', roomIds: rooms, oooType: type, from, to, reasonCode: reason, returnStatus: ret, remarks: remarks || undefined }, { silentError: true });
    setBusy(false);
    if (!r.ok) {
      if (r.errorCode === 'VALIDATION') setErrors({ _: r.error ?? '' });
      return setApiErr({ code: r.errorCode, text: r.error ?? 'Error' });
    }
    const active = from <= D && D <= to;
    onDone(type === 'OOO' ? (active ? t(`Inventory ${before} → ${before - rooms.length}`, `可售库存 ${before} → ${before - rooms.length}`) : t('Future Out of Order record created — inventory unchanged today.', '已创建未来维修房记录 — 今日库存不变。')) : t('Out of Service — inventory unchanged', '停用房 — 库存不变'));
    onClose();
  };
  const errRoom = apiErr?.text.match(/Room (\w+)/)?.[1];

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={640}
      title={t('New Out of Order / Out of Service', '新建维修 / 停用房')}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel', '取消')}</Button>
          <Button variant="primary" disabled={busy} onClick={save}>{t('Save', '保存')}</Button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <Field label={t('Type', '类别')} required>
          <div className="row" style={{ gap: 18 }}>
            {(['OOO', 'OOS'] as OutOfOrderType[]).map((k) => (
              <label key={k} className="check">
                <input type="radio" checked={type === k} onChange={() => setType(k)} />
                {k === 'OOO' ? l.status('OutOfOrder') : l.status('OutOfService')}
              </label>
            ))}
          </div>
        </Field>

        <Field label={t('Rooms', '房间')} required error={errors.rooms}>
          <div className="row-wrap" style={{ gap: 6 }}>
            {rooms.map((id) => (
              <span key={id} className="chip on" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title={conflict.get(id)}>
                {roomNo(id)}
                {conflict.has(id) && <span title={conflict.get(id)}>⚠</span>}
                <button type="button" aria-label={`Remove ${roomNo(id)}`} onClick={() => setRooms((r) => r.filter((x) => x !== id))} style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 0, fontSize: 14, color: 'inherit' }}>×</button>
              </span>
            ))}
            <Button size="sm" onClick={() => setPickOpen((o) => !o)}>+ {t('Add room…', '添加房间…')}</Button>
          </div>
          {pickOpen && (
            <div className="card card-pad col" style={{ marginTop: 6, gap: 8 }}>
              <div className="row-wrap">
                <TextInput value={q} onChange={setQ} placeholder={t('Search number / type…', '搜索房号 / 房型…')} autoFocus />
                <span className="muted">{t('or range', '或区间')}</span>
                <TextInput value={rFrom} onChange={setRFrom} placeholder="From" className="oo-range" />
                <TextInput value={rTo} onChange={setRTo} placeholder="To" className="oo-range" />
                <Button size="sm" disabled={!rFrom && !rTo} onClick={addRange}>{t('Add range', '添加区间')}</Button>
              </div>
              <div style={{ maxHeight: 170, overflow: 'auto', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {matches.map((v) => {
                  const c = conflict.get(v.id);
                  return (
                    <button key={v.id} type="button" className="chip" style={c ? { opacity: 0.6 } : undefined} title={c ? `${c} — ${t('the engine will reject OOO for this room', '引擎将拒绝对该房设置 OOO')}` : undefined} onClick={() => add([v.id])}>
                      {v.number} <span className="subtle">{v.roomType}</span>
                      {c && <span style={{ color: '#d9730d' }}> ⚠ {c}</span>}
                    </button>
                  );
                })}
                {!matches.length && <span className="subtle">{t('No rooms found (rooms with an existing record are hidden).', '无匹配房间（已有记录的房间不显示）。')}</span>}
              </div>
            </div>
          )}
        </Field>

        <div className="grid-2">
          <Field label={t('From', '开始日期')} required error={errors.from}>
            <TextInput type="date" value={from} min={D} onChange={setFrom} invalid={!!errors.from} />
          </Field>
          <Field label={t('Through', '结束日期')} required error={errors.to}>
            <TextInput type="date" value={to} min={from} onChange={setTo} invalid={!!errors.to} />
          </Field>
          <Field label={t('Reason', '原因')} required error={errors.reason}>
            <Select value={reason} onChange={setReason} invalid={!!errors.reason} placeholder={t('Select…', '请选择…')} options={snapshot.oooReasons.map((r) => ({ value: r.code, label: `${r.code} – ${r.description}` }))} />
          </Field>
          <Field label={t('Return Status', '恢复后房态')} required>
            <Select value={ret} onChange={(v) => v && setRet(v)} options={enabledRet.map((s) => ({ value: s, label: l.status(s) }))} />
          </Field>
        </div>
        <Field label={t('Remarks', '备注')}>
          <textarea className="textarea" rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </Field>
        <Alert kind="info">
          {type === 'OOO'
            ? t('OOO removes the room from inventory; OOS keeps it.', 'OOO 将从库存中扣除；OOS 仍保留在库存中。')
            : t('OOS keeps the room in inventory (still sellable).', 'OOS 不扣减库存（仍可售）。')}
        </Alert>

        {apiErr && (
          <Alert kind="error">
            <div>{apiErr.text}</div>
            {apiErr.code && <div className="subtle" style={{ fontSize: 11 }}>{apiErr.code}</div>}
            <div className="row-wrap" style={{ marginTop: 6 }}>
              {apiErr.code === 'ROOM_OCCUPIED' && <Button size="sm" onClick={() => nav(`/front-desk/in-house?room=${errRoom ?? ''}`)}>{t('Go to In House', '前往在住列表')}</Button>}
              {apiErr.code === 'ROOM_ASSIGNED' && <Button size="sm" onClick={() => nav(`/front-desk/arrivals?room=${errRoom ?? ''}`)}>{t('Go to Arrivals', '前往预抵列表')}</Button>}
              {apiErr.code === 'ALREADY_OOO' && errRoom && <Button size="sm" onClick={() => onShow(errRoom)}>{t('Show record', '查看记录')}</Button>}
            </div>
          </Alert>
        )}
      </div>
    </Modal>
  );
}
