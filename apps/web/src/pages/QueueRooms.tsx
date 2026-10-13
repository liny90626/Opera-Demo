import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { isRoomReady, minutesSince, queueReservations, type Reservation } from '@opera-demo/core';
import { useStore } from '../store';
import { useT } from '../i18n';
import { ActionMenu, Button, Checkbox, DataTable, EmptyState, Field, PageHeader, SearchPanel, Select, TextInput, Modal, type Column } from '../components/ui';
import { StatusBadge, roomNo, fmtTime } from '../components/status';
import { RoomDetailDrawer } from '../components/RoomDialogs';
import { useFrontDesk } from './arrivals/frontdesk';
import './arrivals/arrivals.css';

const LS = 'opera-demo/queue-notified';
const loadNotified = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(LS) ?? '{}');
  } catch {
    return {};
  }
};

export default function QueueRooms() {
  const t = useT();
  const { snapshot, viewById, exec, toast } = useStore();
  const [sp] = useSearchParams();
  const fd = useFrontDesk();
  const [now, setNow] = useState(Date.now());
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [readyOnly, setReadyOnly] = useState(false);
  const [history, setHistory] = useState<string | null>(null);
  const [notify, setNotify] = useState<Reservation | null>(null);
  const [notified, setNotified] = useState<Record<string, string>>(loadNotified);
  const [readyAt, setReadyAt] = useState<Record<string, number>>({});
  const prev = useRef<Record<string, boolean> | null>(null);
  const highlight = sp.get('highlight');

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(i);
  }, []);

  const queue = useMemo(() => queueReservations(snapshot), [snapshot]);
  const readiness = (r: Reservation) => {
    const v = r.roomId ? viewById.get(r.roomId) : undefined;
    return { v, ready: !!v && isRoomReady(snapshot, v) };
  };

  // detect rooms that just became ready
  useEffect(() => {
    const cur: Record<string, boolean> = {};
    for (const r of queue) cur[r.id] = readiness(r).ready;
    if (prev.current) {
      const fresh = queue.filter((r) => cur[r.id] && prev.current![r.id] === false);
      if (fresh.length) {
        const ts = Date.now();
        setReadyAt((m) => ({ ...m, ...Object.fromEntries(fresh.map((r) => [r.id, ts])) }));
        fresh.forEach((r) => toast('info', t(`Room ${roomNo(r.roomId)} is ready for ${r.guestName}`, `房间 ${roomNo(r.roomId)} 已为 ${r.guestName} 就绪`)));
      }
    }
    prev.current = cur;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);
  useEffect(() => {
    if (!Object.keys(readyAt).length) return;
    const i = setTimeout(() => setNow(Date.now()), 10_500);
    return () => clearTimeout(i);
  }, [readyAt]);

  const rows = useMemo(
    () =>
      queue.filter((r) => {
        if (name && !r.guestName.toLowerCase().includes(name.toLowerCase())) return false;
        if (type && r.roomType !== type) return false;
        if (readyOnly && !readiness(r).ready) return false;
        return true;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queue, name, type, readyOnly, snapshot],
  );

  const waits = queue.map((r) => minutesSince(r.queue!.queuedAt, now));
  const avg = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0;
  const readyCount = queue.filter((r) => readiness(r).ready).length;
  const attName = (id: string | null | undefined) => snapshot.attendants.find((a) => a.id === id)?.name ?? '—';

  const sendNotify = () => {
    if (!notify) return;
    const stamp = fmtTime(new Date().toISOString());
    const next = { ...notified, [notify.id]: stamp };
    setNotified(next);
    try { localStorage.setItem(LS, JSON.stringify(next)); } catch { /* ignore */ }
    toast('success', t(`SMS sent to ${notify.guestName} (simulated)`, `已向 ${notify.guestName} 发送短信（模拟）`));
    setNotify(null);
  };

  const cols: Column<Reservation>[] = [
    { key: 'pri', header: t('Pri', '优先'), width: 50, render: (r) => <b>{r.queue!.priority}</b> },
    { key: 'guest', header: t('Guest', '客人'), render: (r) => <><b>{r.guestName}</b>{r.vip && <span className="vip-dot" style={{ marginLeft: 6 }}>{r.vip}</span>}<div className="muted mono" style={{ fontSize: 11 }}>#{r.confirmationNo}</div></> },
    { key: 'type', header: t('Type', '房型'), render: (r) => r.roomType },
    { key: 'room', header: t('Room', '房号'), render: (r) => (r.roomId ? <b>{roomNo(r.roomId)}</b> : <span className="muted">{t('No room assigned', '未排房')}</span>) },
    {
      key: 'wait',
      header: t('Wait', '等待'),
      render: (r) => {
        const m = minutesSince(r.queue!.queuedAt, now);
        return <span style={{ color: m > 30 ? 'var(--oc-danger)' : undefined, fontWeight: m > 30 ? 600 : undefined }}>{m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`}</span>;
      },
    },
    {
      key: 'ready',
      header: t('Readiness', '就绪'),
      render: (r) => {
        const { v, ready } = readiness(r);
        if (!v) return <Button size="sm" onClick={() => fd.assign(r)}>{t('Assign Room', '排房')}</Button>;
        return (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <StatusBadge status={v.displayStatus} />
            <span className={`badge ${ready ? 'ok' : 'err'}`}>{ready ? `✔ ${t('Ready', '就绪')}` : `✖ ${t('Not Ready', '未就绪')}`}</span>
          </span>
        );
      },
    },
    { key: 'att', header: t('Attendant', '客房员'), render: (r) => attName(r.roomId ? viewById.get(r.roomId)?.attendantId : null) },
    {
      key: 'act',
      header: t('Actions', '操作'),
      render: (r) => {
        const { ready } = readiness(r);
        return (
          <div className="row-actions">
            {notified[r.id] && <span className="muted" style={{ fontSize: 11 }}>{t('Notified', '已通知')} {notified[r.id]}</span>}
            <Button size="sm" disabled={!ready} title={ready ? undefined : t('Room not ready', '房间未就绪')} onClick={() => setNotify(r)}>{t('Notify Guest', '通知客人')}</Button>
            <Button size="sm" variant="primary" disabled={!ready} className={ready && readyAt[r.id] && now - readyAt[r.id] < 10_000 ? 'pulse' : undefined} title={ready ? undefined : t('Room not ready', '房间未就绪')} onClick={() => fd.checkIn(r)}>{t('Check In', '入住')}</Button>
            <ActionMenu
              label="⋮"
              items={[
                { label: t('Remove from Queue', '移出排队'), onClick: () => exec({ type: 'removeFromQueue', reservationId: r.id }) },
                { label: r.roomId ? t('Change Room', '更换房间') : t('Assign Room', '排房'), onClick: () => fd.assign(r) },
                { label: t('Room History', '房间历史'), disabled: !r.roomId, onClick: () => setHistory(r.roomId) },
              ]}
            />
          </div>
        );
      },
    },
  ];

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[{ label: t('Front Desk', '前台') }, { label: t('Queue Rooms', '排队房') }]}
        title={t('Queue Rooms', '排队房')}
        sub={
          <span>
            {t('Avg wait', '平均等待')} <b>{avg} {t('min', '分钟')}</b> · {t('In queue', '排队')} <b>{queue.length}</b> · {t('Ready', '就绪')} <b style={{ color: 'var(--oc-success, #2a7a2e)' }}>{readyCount}</b>
          </span>
        }
      />
      <SearchPanel title={t('Search', '查询')} onClear={() => { setName(''); setType(''); setReadyOnly(false); }} clearLabel={t('Clear', '清除')} searchLabel={t('Search', '查询')} onSearch={() => undefined}>
        <Field label={t('Guest Name', '客人姓名')}><TextInput value={name} onChange={setName} /></Field>
        <Field label={t('Room Type', '房型')}>
          <Select value={type} onChange={setType} placeholder={t('All', '全部')} options={snapshot.roomTypes.map((x) => ({ value: x.code, label: x.code }))} />
        </Field>
        <Field label=" "><Checkbox checked={readyOnly} onChange={setReadyOnly} label={t('Ready only', '仅就绪')} /></Field>
      </SearchPanel>
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id}
        rowClassName={(r) => ((readyAt[r.id] && now - readyAt[r.id] < 10_000) || highlight === r.id ? 'flash' : undefined)}
        empty={<EmptyState title={t('Queue is empty — rooms are ready for all arrivals ✔', '排队为空——所有到店客人的房间均已就绪 ✔')} />}
      />
      {fd.element}
      <RoomDetailDrawer roomId={history} onClose={() => setHistory(null)} />
      <Modal
        open={!!notify}
        title={t('Notify Guest (SMS preview)', '通知客人（短信预览）')}
        onClose={() => setNotify(null)}
        footer={<><Button onClick={() => setNotify(null)}>{t('Cancel', '取消')}</Button><Button variant="primary" onClick={sendNotify}>{t('Send', '发送')}</Button></>}
      >
        {notify && (
          <div className="card-pad" style={{ background: '#f6f6f6', borderRadius: 6 }}>
            {t(`Dear ${notify.guestName}, your room ${roomNo(notify.roomId)} is ready. Please come to the front desk to collect your key.`, `尊敬的 ${notify.guestName}，您的房间 ${roomNo(notify.roomId)} 已准备好，请到前台领取房卡。`)}
          </div>
        )}
        <div className="muted" style={{ marginTop: 8 }}>{t('Simulation only — no message is actually sent.', '仅为模拟，不会真正发送。')}</div>
      </Modal>
    </div>
  );
}
