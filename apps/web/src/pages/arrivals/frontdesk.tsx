/** Shared front-desk flows: Assign Room drawer + Check In (with ROOM_NOT_READY / NO_ROOM handling). */
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { isRoomReady, staysOverlap, stayOverlaps, type Reservation, type RoomView } from '@opera-demo/core';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { Alert, Button, Checkbox, Confirm, Drawer, Field, Modal, Select } from '../../components/ui';
import { StatusBadge, fmtDate, roomNo } from '../../components/status';

export interface Candidate {
  room: RoomView;
  ready: boolean;
  /** Non-null => cannot be selected */
  blocked: string | null;
  current: boolean;
}

/** Why a room cannot take this reservation (null = ok). Mirrors the engine's assignRoom checks. */
export function blockedReason(
  v: RoomView,
  r: Reservation,
  snap: { reservations: Reservation[]; conditions: { code: string; blocksAssignment: boolean; description: string }[]; businessDate: string },
  t: ReturnType<typeof useT>,
): string | null {
  const o = v.outOfOrder;
  if (o && o.type === 'OOO' && stayOverlaps(r.arrival, r.departure, o.from, o.to)) return t('Out of Order', '维修房');
  const cond = snap.conditions.find((c) => c.code === v.conditionCode);
  if (cond?.blocksAssignment) return `${t('Condition', '房间状况')} ${cond.code}`;
  const D = snap.businessDate;
  const c = snap.reservations.find(
    (x) =>
      x.roomId === v.id &&
      x.id !== r.id &&
      (x.status === 'Reserved' || x.status === 'InHouse') &&
      staysOverlap(x.arrival, x.status === 'InHouse' && x.departure < D ? D : x.departure, r.arrival, r.departure),
  );
  if (c) return c.status === 'InHouse' ? t(`Occupied by ${c.guestName}`, `已被 ${c.guestName} 占用`) : t(`Assigned to ${c.guestName}`, `已分配给 ${c.guestName}`);
  return null;
}

export function AssignRoomDrawer({ resv, onClose }: { resv: Reservation | null; onClose: () => void }) {
  const t = useT();
  const { snapshot, views, exec } = useStore();
  const [typeFilter, setTypeFilter] = useState<string>(''); // '' = reserved type
  const [allTypes, setAllTypes] = useState(false);
  const [notReady, setNotReady] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | { kind: 'dirty' | 'upgrade'; room: RoomView }>(null);
  const [busy, setBusy] = useState(false);

  // always read the live reservation
  const live = resv ? snapshot.reservations.find((x) => x.id === resv.id) ?? resv : null;

  const cands: Candidate[] = useMemo(() => {
    if (!live) return [];
    const snap = { reservations: snapshot.reservations, conditions: snapshot.conditions, businessDate: snapshot.hotel.businessDate };
    const wantType = typeFilter || live.roomType;
    return views
      .filter((v) => allTypes || v.roomType === wantType)
      .map((v) => ({ room: v, ready: isRoomReady(snapshot, v), blocked: blockedReason(v, live, snap, t), current: live.roomId === v.id }))
      .filter((c) => notReady || c.ready || c.current || c.blocked)
      .sort((a, b) => Number(!!a.blocked) - Number(!!b.blocked) || Number(b.ready) - Number(a.ready) || a.room.number.localeCompare(b.room.number, undefined, { numeric: true }));
  }, [live, views, snapshot, typeFilter, allTypes, notReady, t]);

  if (!live) return null;
  const selected = cands.find((c) => c.room.id === sel);
  const types = snapshot.roomTypes.map((x) => ({ value: x.code, label: `${x.code} – ${x.name}` }));

  const doAssign = async (roomId: string, force = false) => {
    setBusy(true);
    setErr(null);
    const res = await exec({ type: 'assignRoom', reservationId: live.id, roomId, force }, { silentError: true });
    setBusy(false);
    if (res.ok) {
      setSel(null);
      onClose();
      return;
    }
    if (res.errorCode === 'ROOM_TYPE_MISMATCH') {
      const room = views.find((v) => v.id === roomId);
      if (room) setConfirm({ kind: 'upgrade', room });
      return;
    }
    setErr(`${res.error ?? 'Error'}${res.errorCode ? ` (${res.errorCode})` : ''}`);
  };

  const onAssign = () => {
    if (!selected || selected.blocked) return;
    if (!selected.ready) setConfirm({ kind: 'dirty', room: selected.room });
    else doAssign(selected.room.id);
  };

  return (
    <>
      <Drawer
        open
        width={640}
        onClose={onClose}
        title={`${t('Assign Room', '排房')} · ${live.guestName} · ${live.roomType} · ${fmtDate(live.arrival)} → ${fmtDate(live.departure)}`}
        footer={
          <>
            <span className="muted" style={{ marginRight: 'auto' }}>
              {t('Selected', '已选')}: {selected ? roomNo(selected.room.id) : '—'}
            </span>
            <Button onClick={onClose}>{t('Cancel', '取消')}</Button>
            <Button variant="primary" disabled={!selected || !!selected.blocked || busy} onClick={onAssign}>
              {t('Assign', '排房')}
            </Button>
          </>
        }
      >
        {err && <Alert kind="error">{err}</Alert>}
        <div className="row-wrap" style={{ marginBottom: 12, alignItems: 'flex-end' }}>
          <Field label={t('Room Type', '房型')}>
            <Select value={typeFilter || live.roomType} disabled={allTypes} onChange={(v) => setTypeFilter(v)} options={types} />
          </Field>
          <Checkbox checked={allTypes} onChange={setAllTypes} label={t('Show all room types', '显示所有房型')} />
          <Checkbox checked={notReady} onChange={setNotReady} label={t('Include not-ready rooms', '包含未就绪房')} />
        </div>
        {live.roomId && (
          <div className="muted" style={{ marginBottom: 8 }}>
            {t('Currently assigned', '当前排房')}: {roomNo(live.roomId)}
          </div>
        )}
        <div className="table-wrap">
          <table className="dt">
            <thead>
              <tr>
                <th>{t('Room', '房号')}</th>
                <th>{t('Type', '房型')}</th>
                <th>{t('Floor', '楼层')}</th>
                <th>{t('HK Status', '房态')}</th>
                <th>{t('Cond', '状况')}</th>
                <th>{t('Note', '备注')}</th>
              </tr>
            </thead>
            <tbody>
              {cands.map((c) => {
                const v = c.room;
                const note = c.blocked ?? (v.outOfOrder?.type === 'OOS' && v.oooActive ? 'OOS' : !c.ready ? t('Not ready', '未就绪') : c.current ? t('Current', '当前') : v.roomType !== live.roomType ? t(`Upgrade/change ${live.roomType}→${v.roomType}`, `换房型 ${live.roomType}→${v.roomType}`) : '');
                return (
                  <tr
                    key={v.id}
                    className={sel === v.id ? 'selected' : undefined}
                    style={{ opacity: c.blocked ? 0.5 : 1, cursor: c.blocked ? 'not-allowed' : 'pointer' }}
                    onClick={() => !c.blocked && setSel(v.id)}
                    title={c.blocked ?? undefined}
                  >
                    <td>
                      <input type="radio" checked={sel === v.id} disabled={!!c.blocked} readOnly style={{ marginRight: 6 }} />
                      <b>{v.number}</b>
                    </td>
                    <td>{v.roomType}</td>
                    <td>{v.floor}</td>
                    <td><StatusBadge status={v.displayStatus} /></td>
                    <td>{v.conditionCode ?? ''}</td>
                    <td style={{ color: c.blocked ? 'var(--oc-danger)' : undefined }}>{note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!cands.length && <div className="empty"><div className="title">{t('No rooms match', '没有符合条件的房间')}</div></div>}
        </div>
      </Drawer>
      <Confirm
        open={confirm?.kind === 'dirty'}
        title={t('Room is not ready', '房间未就绪')}
        message={confirm ? t(`Room ${confirm.room.number} is ${confirm.room.displayStatus} and not ready for check-in. Assign anyway?`, `房间 ${confirm.room.number} 状态为 ${confirm.room.displayStatus}，尚不可入住。仍要排房吗？`) : ''}
        confirmLabel={t('Assign anyway', '仍然排房')}
        cancelLabel={t('Cancel', '取消')}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const r = confirm!.room;
          setConfirm(null);
          doAssign(r.id);
        }}
      />
      <Confirm
        open={confirm?.kind === 'upgrade'}
        title={t('Room type differs', '房型不符')}
        message={confirm ? t(`Room ${confirm.room.number} is ${confirm.room.roomType}, reservation is ${live.roomType}. Upgrade guest to ${confirm.room.roomType}?`, `房间 ${confirm.room.number} 为 ${confirm.room.roomType}，预订房型为 ${live.roomType}。确认升级/更换为 ${confirm.room.roomType} 吗？`) : ''}
        confirmLabel={t('Upgrade (Confirm)', '升级（确认）')}
        cancelLabel={t('Cancel', '取消')}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const r = confirm!.room;
          setConfirm(null);
          doAssign(r.id, true);
        }}
      />
    </>
  );
}

/** Hook bundling assign drawer + check-in flow. Render `element` once in the page. */
export function useFrontDesk(): {
  assign: (r: Reservation) => void;
  checkIn: (r: Reservation) => Promise<boolean>;
  element: ReactNode;
} {
  const t = useT();
  const nav = useNavigate();
  const { exec, snapshot, toast } = useStore();
  const [assignFor, setAssignFor] = useState<Reservation | null>(null);
  const [notReady, setNotReady] = useState<null | { resv: Reservation; message: string }>(null);

  const checkIn = async (r: Reservation) => {
    const res = await exec({ type: 'checkIn', reservationId: r.id }, { silentError: true });
    if (res.ok) return true;
    if (res.errorCode === 'ROOM_NOT_READY') setNotReady({ resv: r, message: res.error ?? '' });
    else if (res.errorCode === 'NO_ROOM') setAssignFor(r);
    else toast('error', `${res.error ?? 'Error'}${res.errorCode === 'ROOM_OCCUPIED' ? ' – ' + t('Go to In House', '请到在住客人页面') : ''}`);
    return false;
  };

  const queued = notReady ? snapshot.reservations.find((x) => x.id === notReady.resv.id)?.queue : null;
  const element = (
    <>
      {assignFor && <AssignRoomDrawer resv={assignFor} onClose={() => setAssignFor(null)} />}
      <Modal
        open={!!notReady}
        title={notReady ? t(`Room ${roomNo(notReady.resv.roomId)} is not ready`, `房间 ${roomNo(notReady.resv.roomId)} 未就绪`) : ''}
        onClose={() => setNotReady(null)}
        width={480}
        footer={
          <>
            <Button onClick={() => setNotReady(null)}>{t('Cancel', '取消')}</Button>
            <Button
              onClick={() => {
                const r = notReady!.resv;
                setNotReady(null);
                setAssignFor(r);
              }}
            >
              {t('Assign another room', '更换房间')}
            </Button>
            {queued && (
              <Button variant="primary" onClick={() => { const r = notReady!.resv; setNotReady(null); nav(`/front-desk/queue?highlight=${r.id}`); }}>
                {t('Go to Queue', '前往排队')}
              </Button>
            )}
            {!queued && (
              <Button
                variant="primary"
                onClick={async () => {
                  const r = notReady!.resv;
                  setNotReady(null);
                  const res = await exec({ type: 'queueReservation', reservationId: r.id });
                  if (res.ok) nav(`/front-desk/queue?highlight=${r.id}`);
                }}
              >
                {t('Add to Queue', '加入排队')}
              </Button>
            )}
          </>
        }
      >
        <Alert kind="warning">{notReady?.message}</Alert>
      </Modal>
    </>
  );
  return { assign: setAssignFor, checkIn, element };
}
