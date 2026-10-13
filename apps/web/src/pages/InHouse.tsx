import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { type Reservation, type RoomView } from '@opera-demo/core';
import { useStore } from '../store';
import { useT } from '../i18n';
import { ActionMenu, Alert, Button, Chips, Confirm, DataTable, EmptyState, Field, PageHeader, SearchPanel, Select, Tabs, TextInput, type Column } from '../components/ui';
import { DiscrepancyBadge, ResvStatusBadge, ServiceBadge, StatusBadge, fmtDate, roomNo } from '../components/status';
import { RoomDetailDrawer } from '../components/RoomDialogs';
import { RoomMoveDrawer } from './inhouse/RoomMove';

type Tab = 'all' | 'dueout' | 'stay' | 'day';
type Flag = 'dueout' | 'stay' | 'day' | 'disc';
interface Row { r: Reservation; v: RoomView | undefined }

export default function InHouse() {
  const t = useT();
  const { snapshot, viewById, exec, recentRooms, toast } = useStore();
  const [sp, setSp] = useSearchParams();
  const D = snapshot.hotel.businessDate;

  const initTab = (): Tab => {
    const x = sp.get('tab') ?? sp.get('filter');
    return x === 'dueout' ? 'dueout' : x === 'stay' ? 'stay' : x === 'day' ? 'day' : 'all';
  };
  const [tab, setTab] = useState<Tab>(initTab);
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [type, setType] = useState('');
  const [flags, setFlags] = useState<Flag[]>([]);
  const roomParam = sp.get('room');
  const [selected, setSelected] = useState<string[]>([]);
  const [outFor, setOutFor] = useState<Reservation[] | null>(null);
  const [moveFor, setMoveFor] = useState<Reservation | null>(null);
  const [history, setHistory] = useState<string | null>(null);

  // ?room=NNN&action=checkout => open the check-out confirm once
  const done = useRef(false);
  useEffect(() => {
    if (done.current || sp.get('action') !== 'checkout' || !roomParam) return;
    const r = snapshot.reservations.find((x) => x.status === 'InHouse' && roomNo(x.roomId) === roomNo(roomParam));
    done.current = true;
    if (r) setOutFor([r]);
  }, [sp, roomParam, snapshot.reservations]);

  const all: Row[] = useMemo(
    () => snapshot.reservations.filter((r) => r.status === 'InHouse').map((r) => ({ r, v: r.roomId ? viewById.get(r.roomId) : undefined })),
    [snapshot.reservations, viewById],
  );
  const cnt = (k: string) => all.filter((x) => x.v?.resvStatus === k).length;

  const rows = useMemo(
    () =>
      all.filter(({ r, v }) => {
        const st = v?.resvStatus;
        if (tab === 'dueout' && st !== 'Due Out') return false;
        if (tab === 'stay' && st !== 'Stay Over' && st !== 'Arrived') return false;
        if (tab === 'day' && st !== 'Day Use') return false;
        if (name && !r.guestName.toLowerCase().includes(name.toLowerCase())) return false;
        const n = roomNo(r.roomId);
        if (from && n.localeCompare(roomNo(from), undefined, { numeric: true }) < 0) return false;
        if (to && n.localeCompare(roomNo(to), undefined, { numeric: true }) > 0) return false;
        if (roomParam && n !== roomNo(roomParam)) return false;
        if (type && r.roomType !== type) return false;
        if (flags.includes('dueout') && st !== 'Due Out') return false;
        if (flags.includes('stay') && st !== 'Stay Over') return false;
        if (flags.includes('day') && st !== 'Day Use') return false;
        if (flags.includes('disc') && !v?.discrepancies.length) return false;
        return true;
      }),
    [all, tab, name, from, to, type, flags, roomParam],
  );

  const clear = () => { setName(''); setFrom(''); setTo(''); setType(''); setFlags([]); if (sp.size) setSp({}, { replace: true }); };

  const doCheckOut = async (list: Reservation[]) => {
    setOutFor(null);
    if (list.length === 1) await exec({ type: 'checkOut', reservationId: list[0].id }, { silentError: true }).then((res) => !res.ok && toast('error', res.error ?? 'Error'));
    else {
      let ok = 0;
      const bad: string[] = [];
      for (const r of list) {
        const res = await exec({ type: 'checkOut', reservationId: r.id }, { silentError: true, silentSuccess: true });
        if (res.ok) ok++;
        else bad.push(`${r.guestName}: ${res.error}`);
      }
      toast(bad.length ? 'warning' : 'success', t(`${ok} checked out, rooms set to Dirty`, `${ok} 位已退房，房间置为脏房`) + (bad.length ? ` · ${bad.length} ${t('failed', '失败')}: ${bad.join('; ')}` : ''));
    }
    setSelected([]);
  };

  const cols: Column<Row>[] = [
    { key: 'room', header: t('Room', '房号'), sortValue: ({ r }) => roomNo(r.roomId).padStart(4, '0'), render: ({ r }) => <b>{roomNo(r.roomId)}</b> },
    { key: 'guest', header: t('Guest', '客人'), sortValue: ({ r }) => r.guestName, render: ({ r }) => <>{r.guestName}{r.vip && <span className="vip-dot" style={{ marginLeft: 6, background: '#b8860b', color: '#fff', borderRadius: 3, fontSize: 10, padding: '0 4px' }}>{r.vip}</span>}</> },
    { key: 'type', header: t('Type', '房型'), sortValue: ({ r }) => r.roomType, render: ({ r }) => r.roomType },
    { key: 'pers', header: t('Pers', '人数'), align: 'right', render: ({ r }) => r.adults + r.children },
    { key: 'dates', header: t('Arr → Dep', '到→离'), sortValue: ({ r }) => r.departure, render: ({ r }) => <span style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.arrival).slice(0, 6)} → {fmtDate(r.departure)}</span> },
    { key: 'rs', header: t('Resv Status', '预订状态'), render: ({ v }) => (v ? <ResvStatusBadge status={v.resvStatus} /> : null) },
    { key: 'hk', header: t('HK Status', '房态'), render: ({ v }) => (v ? <StatusBadge status={v.displayStatus} /> : null) },
    { key: 'svc', header: t('Svc', '服务'), render: ({ v }) => (v ? <ServiceBadge service={v.serviceStatus} /> : null) },
    { key: 'disc', header: t('Disc', '差异'), render: ({ v }) => <>{v?.discrepancies.map((d) => <DiscrepancyBadge key={d} type={d} />)}</> },
    {
      key: 'act',
      header: t('Actions', '操作'),
      render: ({ r, v }) => (
        <div className="row-actions" style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant={v?.resvStatus === 'Due Out' ? 'primary' : 'secondary'} onClick={() => setOutFor([r])}>{t('Check Out', '退房')}</Button>
          <ActionMenu
            label="⋮"
            items={[
              { label: t('Room Move', '换房'), onClick: () => setMoveFor(r) },
              { divider: true },
              { group: t('Service Status', '服务状态') },
              { label: t('Set DND', '设置 DND'), disabled: v?.serviceStatus === 'DND', onClick: () => r.roomId && exec({ type: 'setServiceStatus', roomIds: [r.roomId], service: 'DND' }) },
              { label: t('Set MUR', '设置 MUR'), disabled: v?.serviceStatus === 'MUR', onClick: () => r.roomId && exec({ type: 'setServiceStatus', roomIds: [r.roomId], service: 'MUR' }) },
              { label: t('Clear service status', '清除服务状态'), disabled: !v?.serviceStatus, onClick: () => r.roomId && exec({ type: 'setServiceStatus', roomIds: [r.roomId], service: null }) },
              { divider: true },
              { label: t('Room History', '房间历史'), onClick: () => setHistory(r.roomId) },
              { label: t('Resolve Discrepancy', '解决差异'), disabled: !v?.discrepancies.length, onClick: () => r.roomId && exec({ type: 'resolveDiscrepancy', roomId: r.roomId }) },
            ]}
          />
        </div>
      ),
    },
  ];

  const selRows = selected.map((id) => rows.find((x) => x.r.id === id)?.r).filter(Boolean) as Reservation[];
  const dueSelectable = rows.filter((x) => x.v?.resvStatus === 'Due Out').map((x) => x.r);
  const outEarly = outFor?.filter((r) => r.departure > D) ?? [];

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[{ label: t('Front Desk', '前台') }, { label: t('In House', '在住') }]}
        title={t('In House', '在住客人')}
        actions={
          <ActionMenu
            items={[
              { label: t('Check Out Selected', '批量退房'), disabled: !selRows.length, onClick: () => setOutFor(selRows) },
              { label: t('Check Out All Due Outs', '退房所有预离'), disabled: !dueSelectable.length, onClick: () => setOutFor(dueSelectable) },
            ]}
          />
        }
      />
      <SearchPanel title={t('Search', '查询')} onClear={clear} clearLabel={t('Clear', '清除')} searchLabel={t('Search', '查询')} onSearch={() => undefined}>
        <Field label={t('Guest Name', '客人姓名')}><TextInput value={name} onChange={setName} /></Field>
        <Field label={t('Room From', '房号从')}><TextInput value={from} onChange={setFrom} /></Field>
        <Field label={t('Room To', '房号到')}><TextInput value={to} onChange={setTo} /></Field>
        <Field label={t('Room Type', '房型')}>
          <Select value={type} onChange={setType} placeholder={t('All', '全部')} options={snapshot.roomTypes.map((x) => ({ value: x.code, label: x.code }))} />
        </Field>
        <Field label={t('Filters', '筛选')}>
          <Chips<Flag> value={flags} onChange={setFlags} options={[
            { value: 'dueout', label: t('Due Out', '预离') },
            { value: 'stay', label: t('Stay Over', '续住') },
            { value: 'day', label: t('Day Use', '钟点房') },
            { value: 'disc', label: t('Discrepancy', '差异') },
          ]} />
        </Field>
        {roomParam && <Field label={t('Room', '房号')}><span className="badge info">{roomNo(roomParam)}</span></Field>}
      </SearchPanel>
      <Tabs<Tab>
        value={tab}
        onChange={(k) => { setTab(k); setSelected([]); }}
        tabs={[
          { key: 'all', label: t('All', '全部'), count: all.length },
          { key: 'dueout', label: t('Due Out', '预离'), count: cnt('Due Out') },
          { key: 'stay', label: t('Stay Over', '续住'), count: cnt('Stay Over') + cnt('Arrived') },
          { key: 'day', label: t('Day Use', '钟点房'), count: cnt('Day Use') },
        ]}
      />
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={({ r }) => r.id}
        selectable
        selected={selected}
        onSelectedChange={setSelected}
        rowClassName={({ r, v }) => [r.roomId && recentRooms[r.roomId] && Date.now() - recentRooms[r.roomId] < 2500 ? 'flash' : '', v?.resvStatus === 'Due Out' ? 'dueout-row' : ''].join(' ').trim() || undefined}
        toolbar={
          <>
            <b>{selected.length ? t(`${selected.length} selected`, `已选 ${selected.length}`) : `${rows.length} ${t('in house', '在住')}`}</b>
            {selected.length > 0 && <Button size="sm" variant="link" onClick={() => setSelected([])}>{t('Clear selection', '清除选择')}</Button>}
            {selected.length > 0 && <Button size="sm" variant="primary" onClick={() => setOutFor(selRows)}>{t('Check Out Selected', '批量退房')}</Button>}
            {tab === 'dueout' && !selected.length && dueSelectable.length > 0 && <Button size="sm" onClick={() => setSelected(dueSelectable.map((r) => r.id))}>{t('Select all due outs', '选择全部预离')}</Button>}
          </>
        }
        empty={<EmptyState title={t('No in-house guests match', '没有符合条件的在住客人')} />}
      />
      <style>{`.dt tr.dueout-row td:first-child{box-shadow:inset 3px 0 0 var(--oc-warning,#e68a00)} .dt tr.dueout-row td{background:#fffaf0}`}</style>
      <Confirm
        open={!!outFor}
        title={t('Check Out', '退房')}
        confirmLabel={t('Check Out', '退房')}
        cancelLabel={t('Cancel', '取消')}
        onCancel={() => setOutFor(null)}
        onConfirm={() => doCheckOut(outFor!)}
        message={
          outFor && (
            <div className="col">
              <div>
                {outFor.length === 1
                  ? t(`Check out ${outFor[0].guestName} from room ${roomNo(outFor[0].roomId)}? Room will be set to Dirty.`, `确认将 ${outFor[0].guestName} 从房间 ${roomNo(outFor[0].roomId)} 退房？房间将置为脏房。`)
                  : t(`Check out ${outFor.length} guests? Their rooms will be set to Dirty.`, `确认退房 ${outFor.length} 位客人？房间将置为脏房。`)}
              </div>
              {outEarly.length > 0 && (
                <Alert kind="warning">
                  {t('Early departure: departure will change to', '提前离店：离店日期将改为')} {fmtDate(D)}
                  {outFor.length > 1 && <> ({outEarly.map((r) => roomNo(r.roomId)).join(', ')})</>}
                </Alert>
              )}
            </div>
          )
        }
      />
      {moveFor && <RoomMoveDrawer resv={snapshot.reservations.find((x) => x.id === moveFor.id) ?? moveFor} onClose={() => setMoveFor(null)} />}
      <RoomDetailDrawer roomId={history} onClose={() => setHistory(null)} />
    </div>
  );
}
