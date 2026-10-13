import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { isRoomReady, type Reservation } from '@opera-demo/core';
import { useStore } from '../store';
import { useT } from '../i18n';
import { ActionMenu, Alert, Button, Chips, Confirm, DataTable, EmptyState, Field, PageHeader, SearchPanel, Select, Tabs, TextInput, type Column } from '../components/ui';
import { StatusBadge, fmtBusinessDate, roomNo } from '../components/status';
import { RoomDetailDrawer } from '../components/RoomDialogs';
import { useFrontDesk } from './arrivals/frontdesk';
import './arrivals/arrivals.css';

type Flag = 'unassigned' | 'assigned' | 'queue' | 'vip';

export default function Arrivals() {
  const t = useT();
  const { snapshot, viewById, exec, recentRooms, toast, lang } = useStore();
  const [sp, setSp] = useSearchParams();
  const fd = useFrontDesk();
  const D = snapshot.hotel.businessDate;

  const [tab, setTab] = useState<'due' | 'in'>('due');
  const [name, setName] = useState('');
  const [conf, setConf] = useState('');
  const [type, setType] = useState('');
  const [flags, setFlags] = useState<Flag[]>(() => {
    const f = sp.get('filter');
    return f === 'unassigned' || f === 'assigned' || f === 'queue' || f === 'vip' ? [f] : [];
  });
  const roomParam = sp.get('room');
  const [selected, setSelected] = useState<string[]>([]);
  const [history, setHistory] = useState<string | null>(null);
  const [batchSummary, setBatchSummary] = useState<null | { ok: number; notReady: Reservation[]; other: string[] }>(null);
  const [unassign, setUnassign] = useState<Reservation | null>(null);

  const base = useMemo(() => snapshot.reservations.filter((r) => r.arrival === D), [snapshot.reservations, D]);
  const due = base.filter((r) => r.status === 'Reserved');
  const inH = base.filter((r) => r.status === 'InHouse');

  const rows = useMemo(() => {
    const src = tab === 'due' ? due : inH;
    return src.filter((r) => {
      if (name && !r.guestName.toLowerCase().includes(name.toLowerCase())) return false;
      if (conf && !r.confirmationNo.includes(conf)) return false;
      if (type && r.roomType !== type) return false;
      if (roomParam && roomNo(r.roomId) !== roomNo(roomParam)) return false;
      if (flags.includes('unassigned') && r.roomId) return false;
      if (flags.includes('assigned') && !r.roomId) return false;
      if (flags.includes('queue') && !r.queue) return false;
      if (flags.includes('vip') && !r.vip) return false;
      return true;
    });
  }, [tab, due, inH, name, conf, type, flags, roomParam]);

  const clear = () => {
    setName(''); setConf(''); setType(''); setFlags([]);
    if (sp.size) setSp({}, { replace: true });
  };

  const qPos = (r: Reservation) => r.queue?.priority;
  const selResv = selected.map((id) => rows.find((r) => r.id === id)).filter(Boolean) as Reservation[];

  const batchCheckIn = async () => {
    let ok = 0;
    const notReady: Reservation[] = [];
    const other: string[] = [];
    for (const r of selResv) {
      const res = await exec({ type: 'checkIn', reservationId: r.id }, { silentError: true, silentSuccess: true });
      if (res.ok) ok++;
      else if (res.errorCode === 'ROOM_NOT_READY') notReady.push(r);
      else other.push(`${r.guestName}: ${res.error}`);
    }
    setSelected([]);
    setBatchSummary({ ok, notReady, other });
  };
  const batchQueue = async (list: Reservation[]) => {
    let n = 0;
    for (const r of list) if ((await exec({ type: 'queueReservation', reservationId: r.id }, { silentError: true, silentSuccess: true })).ok) n++;
    toast('success', t(`${n} reservation(s) added to the queue`, `${n} 个预订已加入排队`));
    setBatchSummary(null);
  };

  const cols: Column<Reservation>[] = [
    { key: 'conf', header: t('Conf No', '确认号'), render: (r) => <span className="mono">{r.confirmationNo}</span>, sortValue: (r) => r.confirmationNo },
    { key: 'guest', header: t('Guest', '客人'), render: (r) => <b>{r.guestName}</b>, sortValue: (r) => r.guestName },
    { key: 'vip', header: 'VIP', render: (r) => (r.vip ? <span className="vip-dot">{r.vip}</span> : null) },
    { key: 'type', header: t('Type', '房型'), render: (r) => r.roomType, sortValue: (r) => r.roomType },
    { key: 'pers', header: t('Pers', '人数'), render: (r) => r.adults + r.children, align: 'right' },
    { key: 'eta', header: 'ETA', render: (r) => r.eta ?? '—', sortValue: (r) => r.eta ?? '99:99' },
    { key: 'nts', header: t('Nts', '晚数'), render: (r) => Math.max(1, Math.round((+new Date(r.departure) - +new Date(r.arrival)) / 864e5)), align: 'right' },
    {
      key: 'room',
      header: t('Room', '房号'),
      sortValue: (r) => r.roomId ?? 'zzzz',
      render: (r) => (
        <>
          {r.roomId ? <a href={`#/front-desk/arrivals?room=${roomNo(r.roomId)}`} onClick={(e) => { e.preventDefault(); setHistory(r.roomId); }}>{roomNo(r.roomId)}</a> : '—'}
          {r.queue && <span className="qmark" title={t('In queue', '排队中')}>⏳ Q{qPos(r)}</span>}
        </>
      ),
    },
    {
      key: 'rs',
      header: t('Room Status', '房态'),
      render: (r) => {
        const v = r.roomId ? viewById.get(r.roomId) : null;
        if (!v) return null;
        return (
          <>
            <StatusBadge status={v.displayStatus} />
            {r.status === 'Reserved' && !isRoomReady(snapshot, v) && <span className="warn-ic" title={t('Not ready for check-in', '尚不可入住')}>⚠</span>}
          </>
        );
      },
    },
    {
      key: 'act',
      header: t('Actions', '操作'),
      render: (r) => {
        if (r.status !== 'Reserved') return <span className="muted">{t('Checked in', '已入住')} {roomNo(r.roomId)}</span>;
        const v = r.roomId ? viewById.get(r.roomId) : null;
        const ready = !!v && isRoomReady(snapshot, v);
        return (
          <div className="row-actions" onClick={(e) => e.stopPropagation()}>
            {r.roomId ? (
              <Button variant="primary" size="sm" className={r.queue && ready ? 'pulse' : undefined} onClick={() => fd.checkIn(r)}>{t('Check In', '入住')}</Button>
            ) : (
              <Button variant="primary" size="sm" onClick={() => fd.assign(r)}>{t('Assign Room', '排房')}</Button>
            )}
            <ActionMenu
              label="⋮"
              items={[
                { label: r.roomId ? t('Change Room', '更换房间') : t('Assign Room', '排房'), onClick: () => fd.assign(r) },
                { label: t('Unassign Room', '取消排房'), disabled: !r.roomId, onClick: () => setUnassign(r) },
                { divider: true },
                { label: t('Add to Queue', '加入排队'), disabled: !!r.queue, onClick: () => exec({ type: 'queueReservation', reservationId: r.id }) },
                { label: t('Remove from Queue', '移出排队'), disabled: !r.queue, onClick: () => exec({ type: 'removeFromQueue', reservationId: r.id }) },
                { divider: true },
                { label: t('Room History', '房间历史'), disabled: !r.roomId, onClick: () => setHistory(r.roomId) },
              ]}
            />
          </div>
        );
      },
    },
  ];

  const toolbar = (
    <>
      <b>{selected.length ? t(`${selected.length} selected`, `已选 ${selected.length}`) : `${rows.length} ${t('arrivals', '到店')}`}</b>
      {selected.length > 0 && <Button size="sm" variant="link" onClick={() => setSelected([])}>{t('Clear selection', '清除选择')}</Button>}
      <span className="muted" style={{ marginLeft: 'auto' }}>{t('Arrival date', '到店日期')}: {fmtBusinessDate(D, lang)}</span>
    </>
  );

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[{ label: t('Front Desk', '前台') }, { label: t('Arrivals', '到店') }]}
        title={t('Arrivals', '到店')}
        actions={
          <ActionMenu
            items={[
              { label: t('Check In Selected', '批量入住'), disabled: !selResv.some((r) => r.status === 'Reserved'), onClick: batchCheckIn },
              { label: t('Add Selected to Queue', '批量加入排队'), disabled: !selResv.length, onClick: () => batchQueue(selResv.filter((r) => !r.queue)) },
            ]}
          />
        }
      />
      <SearchPanel title={t('Search', '查询')} onClear={clear} clearLabel={t('Clear', '清除')} searchLabel={t('Search', '查询')} onSearch={() => undefined}>
        <Field label={t('Guest Name', '客人姓名')}><TextInput value={name} onChange={setName} /></Field>
        <Field label={t('Conf No', '确认号')}><TextInput value={conf} onChange={setConf} /></Field>
        <Field label={t('Room Type', '房型')}>
          <Select value={type} onChange={setType} placeholder={t('All', '全部')} options={snapshot.roomTypes.map((x) => ({ value: x.code, label: x.code }))} />
        </Field>
        <Field label={t('Filters', '筛选')}>
          <Chips<Flag>
            value={flags}
            onChange={setFlags}
            options={[
              { value: 'unassigned', label: t('Unassigned only', '未排房') },
              { value: 'assigned', label: t('Assigned', '已排房') },
              { value: 'queue', label: t('In queue', '排队中') },
              { value: 'vip', label: 'VIP' },
            ]}
          />
        </Field>
        {roomParam && <Field label={t('Room', '房号')}><span className="badge info">{roomNo(roomParam)}</span></Field>}
      </SearchPanel>
      <Tabs
        tabs={[
          { key: 'due', label: t('Due In', '待入住'), count: due.length },
          { key: 'in', label: t('Checked In', '已入住'), count: inH.length },
        ]}
        value={tab}
        onChange={(k) => { setTab(k); setSelected([]); }}
      />
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id}
        selectable
        selected={selected}
        onSelectedChange={setSelected}
        toolbar={toolbar}
        rowClassName={(r) => (r.roomId && recentRooms[r.roomId] && Date.now() - recentRooms[r.roomId] < 2500 ? 'flash' : undefined)}
        empty={<EmptyState title={t('No arrivals for this business date', '本营业日没有到店预订')} />}
      />
      {fd.element}
      <RoomDetailDrawer roomId={history} onClose={() => setHistory(null)} />
      <Confirm
        open={!!unassign}
        title={t('Unassign room', '取消排房')}
        message={unassign ? t(`Release room ${roomNo(unassign.roomId)} from ${unassign.guestName}?`, `释放 ${unassign.guestName} 的房间 ${roomNo(unassign.roomId)}？`) : ''}
        onCancel={() => setUnassign(null)}
        onConfirm={() => { const r = unassign!; setUnassign(null); exec({ type: 'unassignRoom', reservationId: r.id }); }}
      />
      {batchSummary && (
        <Confirm
          open
          title={t('Check In Selected', '批量入住')}
          confirmLabel={batchSummary.notReady.length ? t('Add them to Queue', '批量加入排队') : t('OK', '确定')}
          cancelLabel={t('Close', '关闭')}
          onCancel={() => setBatchSummary(null)}
          onConfirm={() => (batchSummary.notReady.length ? batchQueue(batchSummary.notReady.filter((r) => !r.queue)) : setBatchSummary(null))}
          message={
            <div className="col">
              <Alert kind="success">{t(`${batchSummary.ok} checked in`, `${batchSummary.ok} 个已入住`)}</Alert>
              {batchSummary.notReady.length > 0 && (
                <Alert kind="warning">
                  {t(`${batchSummary.notReady.length} skipped, room not ready:`, `${batchSummary.notReady.length} 个因房间未就绪被跳过：`)}
                  <ul>{batchSummary.notReady.map((r) => <li key={r.id}>{r.guestName} – {roomNo(r.roomId)}</li>)}</ul>
                </Alert>
              )}
              {batchSummary.other.length > 0 && <Alert kind="error"><ul>{batchSummary.other.map((m, i) => <li key={i}>{m}</li>)}</ul></Alert>}
            </div>
          }
        />
      )}
    </div>
  );
}
