/** Room-level dialogs shared across pages: room detail drawer and Out of Order / Service dialog. */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { addDays, type HkStatus, type OutOfOrderType, type RoomView } from '@opera-demo/core';
import { useStore } from '../store';
import { useT } from '../i18n';
import { DeviceList, ErrBadge, Flag, MaskedPin, OrderStateBadge, pmsFlags } from '../pages/akubela/shared';
import { Alert, Button, Drawer, Field, KV, Modal, Select, TextInput } from './ui';
import { DiscrepancyBadge, FoBadge, HK_STATUSES, ResvStatusBadge, ServiceBadge, StatusBadge, StatusIcon, fmtDate, fmtDateTime, roomNo, useLabels } from './status';

/** Place one or more rooms Out of Order / Out of Service. */
export function OutOfOrderDialog({ open, roomIds, defaultType = 'OOO', onClose, onDone }: { open: boolean; roomIds: string[]; defaultType?: OutOfOrderType; onClose: () => void; onDone?: () => void }) {
  const { snapshot, exec } = useStore();
  const t = useT();
  const l = useLabels();
  const D = snapshot.hotel.businessDate;
  const [type, setType] = useState<OutOfOrderType>(defaultType);
  const [from, setFrom] = useState(D);
  const [to, setTo] = useState(addDays(D, 1));
  const [reason, setReason] = useState('');
  const [ret, setRet] = useState<HkStatus>('Dirty');
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setType(defaultType);
      setFrom(D);
      setTo(addDays(D, 1));
      setReason('');
      setRet('Dirty');
      setRemarks('');
      setError(null);
    }
  }, [open, defaultType, D]);
  const enabled = HK_STATUSES.filter((s) => (s !== 'Inspected' || snapshot.hotel.parameters.inspectedStatusEnabled) && (s !== 'Pickup' || snapshot.hotel.parameters.pickupStatusEnabled));
  const submit = async () => {
    if (!reason) return setError(t('Reason is required', '请选择原因'));
    if (to < from) return setError(t('To date must be on or after From date', '结束日期不能早于开始日期'));
    setBusy(true);
    const r = await exec({ type: 'placeOutOfOrder', roomIds, oooType: type, from, to, reasonCode: reason, returnStatus: ret, remarks: remarks || undefined }, { silentError: true });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? 'Error');
    onDone?.();
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('Out of Order / Out of Service', '设置维修房 / 停用房')}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel', '取消')}</Button>
          <Button variant="primary" disabled={busy} onClick={submit}>
            {t('Save', '保存')}
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <div className="muted">
          {t('Rooms', '房间')}: <b>{roomIds.map(roomNo).join(', ')}</b>
        </div>
        <div className="row" style={{ gap: 16 }}>
          {(['OOO', 'OOS'] as OutOfOrderType[]).map((k) => (
            <label key={k} className="check">
              <input type="radio" checked={type === k} onChange={() => setType(k)} />
              {k === 'OOO' ? l.status('OutOfOrder') : l.status('OutOfService')}
            </label>
          ))}
        </div>
        <Alert kind="info">
          {type === 'OOO'
            ? t('Out of Order removes the room from sellable inventory. Rooms that are occupied or assigned in this period cannot be placed OOO.', 'OOO（维修房）将从可售库存中扣除；期间内有在住或已排房预订的房间不能设为 OOO。')
            : t('Out of Service keeps the room in inventory (still sellable); it only flags it for housekeeping/engineering.', 'OOS（停用房）不扣减库存，仍可售卖，仅作为房务/工程提示。')}
        </Alert>
        <div className="grid-2">
          <Field label={t('From', '开始日期')} required>
            <TextInput type="date" value={from} min={D} onChange={setFrom} />
          </Field>
          <Field label={t('Through', '结束日期')} required>
            <TextInput type="date" value={to} min={from} onChange={setTo} />
          </Field>
          <Field label={t('Reason', '原因')} required>
            <Select value={reason} onChange={(v) => setReason(v)} placeholder={t('Select…', '请选择…')} options={snapshot.oooReasons.map((r) => ({ value: r.code, label: `${r.code} – ${r.description}` }))} invalid={!!error && !reason} />
          </Field>
          <Field label={t('Return Status', '恢复后房态')} required>
            <Select value={ret} onChange={(v) => v && setRet(v)} options={enabled.map((s) => ({ value: s, label: l.status(s) }))} />
          </Field>
        </div>
        <Field label={t('Remarks', '备注')}>
          <textarea className="textarea" rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </Field>
        {error && <Alert kind="error">{error}</Alert>}
      </div>
    </Modal>
  );
}

/** GRMS (Akubela) block of the room drawer: mapping, GRMS flags, linked order, devices. */
function GrmsSection({ v }: { v: RoomView }) {
  const { akubela: st, akubelaCall, toast } = useStore();
  const t = useT();
  const [showDev, setShowDev] = useState(false);
  if (!st || st.mode === 'off') return null;
  const m = st.mappings.find((x) => x.roomId === v.id);
  const g = m?.residenceId ? st.grmsRooms[m.residenceId] : null;
  const p = pmsFlags(v);
  const link = st.links.find((l) => l.roomId === v.id && !l.closed);
  return (
    <div className="aku-grms-section" style={{ marginTop: 18 }}>
      <div className="section-title">
        GRMS <span className="badge neutral">{st.mode === 'sim' ? t('Simulator', '模拟器') : 'UAT'}</span>
      </div>
      {!m?.residenceId ? (
        <div className="subtle">
          {t('This room is not mapped to a GRMS residence.', '该房间未映射到 GRMS 房间。')} <Link to="/integration/akubela">{t('Map it', '去映射')}</Link>
        </div>
      ) : (
        <>
          <KV
            items={[
              [t('GRMS residence', 'GRMS 房间'), `${m.residenceName ?? ''} (${m.origin})`],
              ['Dirty', <span key="d"><Flag v={g?.dirty} bad={g?.dirty != null && g.dirty !== p.dirty} /></span>],
              [t('Occupied', '入住'), <span key="o"><Flag v={g?.occupied} bad={g?.occupied != null && g.occupied !== p.occupied} /></span>],
              ['DND', <span key="n"><Flag v={g?.dnd} bad={g?.dnd != null && g.dnd !== p.dnd} /></span>],
              [t('Error', '错误'), g?.error ? <span key="e"><ErrBadge e={g.error} /> {g.error.message}</span> : '—'],
              [
                t('GRMS order', 'GRMS 订单'),
                link ? (
                  <span key="l" className="row-wrap">
                    <span className="mono">{link.orderNumber}</span> <OrderStateBadge state={link.state} /> <Link to="/integration/akubela">#{link.confirmationNo}</Link>
                  </span>
                ) : (
                  '—'
                ),
              ],
              ['PIN', link ? <MaskedPin key="p" pin={link.pin} /> : '—'],
            ]}
          />
          <div className="subtle" style={{ marginTop: 8, fontSize: 12 }}>
            {st.settings.syncMode === 'bidirectional'
              ? t('Bidirectional sync: GRMS changes may update OPERA.', '双向同步：GRMS 的变更可能回写 OPERA。')
              : t('OPERA is the master: this room\'s state is pushed to GRMS.', 'OPERA 为主系统：本房状态会推送到 GRMS。')}
          </div>
          <div className="row-wrap" style={{ marginTop: 8 }}>
            <Button
              size="sm"
              title={t('No per-room route: pushes all mapped rooms', '没有单房接口：将推送全部已映射房间')}
              onClick={async () => {
                const r = await akubelaCall('POST', '/push');
                const n = (r.body as { jobs?: number } | undefined)?.jobs;
                if (r.status < 400) toast('success', t(`${n ?? ''} jobs queued (all mapped rooms)`, `已排队 ${n ?? ''} 个作业（全部已映射房间）`));
              }}
            >
              {t('Push OPERA → GRMS (all mapped rooms)', '推送 OPERA → GRMS（全部已映射房间）')}
            </Button>
          </div>
          <div style={{ marginTop: 10 }}>
            {showDev ? <DeviceList roomId={v.id} /> : <Button size="sm" onClick={() => setShowDev(true)}>{t('Show devices', '显示设备')}</Button>}
          </div>
        </>
      )}
    </div>
  );
}

/** Room detail drawer: current status, occupant, OOO, quick actions and change history (business events). */
export function RoomDetailDrawer({ roomId, onClose }: { roomId: string | null; onClose: () => void }) {
  const { viewById, snapshot, exec } = useStore();
  const t = useT();
  const l = useLabels();
  const [ooo, setOoo] = useState(false);
  const v = roomId ? viewById.get(roomId) : undefined;
  const history = useMemo(() => (v ? snapshot.events.filter((e) => e.roomIds.includes(v.id)).slice(0, 30) : []), [snapshot.events, v]);
  if (!v) return null;
  const att = snapshot.attendants.find((a) => a.id === v.attendantId);
  const cond = snapshot.conditions.find((c) => c.code === v.conditionCode);
  const p = snapshot.hotel.parameters;
  const guest = v.inHouse ?? v.arrival ?? v.departed;
  return (
    <>
      <Drawer open={!!roomId} onClose={onClose} title={`${t('Room', '房间')} ${v.number}`} width={500}>
        <div className="row" style={{ gap: 14, marginBottom: 14 }}>
          <StatusIcon status={v.displayStatus} size={48} />
          <div className="col" style={{ gap: 4 }}>
            <div className="row-wrap">
              <StatusBadge status={v.displayStatus} />
              <FoBadge status={v.foStatus} />
              <ResvStatusBadge status={v.resvStatus} />
              <ServiceBadge service={v.serviceStatus} />
              {v.discrepancies.map((d) => (
                <DiscrepancyBadge key={d} type={d} />
              ))}
            </div>
            <div className="muted">
              {v.roomType} · {v.roomTypeName} · {t('Floor', '楼层')} {v.floor} · {t('Section', '区域')} {v.section}
            </div>
          </div>
        </div>

        <div className="section-title">{t('Set Room Status', '设置房态')}</div>
        <div className="row-wrap" style={{ marginBottom: 14 }}>
          {HK_STATUSES.filter((s) => (s !== 'Inspected' || p.inspectedStatusEnabled) && (s !== 'Pickup' || p.pickupStatusEnabled)).map((s) => (
            <Button key={s} size="sm" variant={v.hkStatus === s ? 'primary' : 'secondary'} disabled={v.oooActive} onClick={() => exec({ type: 'setHkStatus', roomIds: [v.id], status: s })}>
              {l.status(s)}
            </Button>
          ))}
          {v.outOfOrder ? (
            <Button size="sm" variant="danger" onClick={() => exec({ type: 'releaseOutOfOrder', roomIds: [v.id] })}>
              {t('Return to Service', '恢复使用')}
            </Button>
          ) : (
            <Button size="sm" onClick={() => setOoo(true)}>
              OOO / OOS…
            </Button>
          )}
        </div>

        <KV
          items={[
            [t('HK Occupancy', '房务查房'), v.hkOccupancy ? `${l.hkOcc(v.hkOccupancy)}${v.hkPersons != null ? ` · ${v.hkPersons} pax` : ''}` : t('Not checked', '未查')],
            [t('FO Persons', '前台人数'), v.persons],
            [t('Turndown', '开夜床'), v.turndown],
            [t('Condition', '房间条件'), cond ? `${cond.code} – ${cond.description}` : '—'],
            [t('Attendant', '客房员'), att?.name ?? '—'],
            [t('Features', '特征'), v.features.join(', ')],
            [t('Guest', '客人'), guest ? `${guest.guestName}${guest.vip ? ` (${guest.vip})` : ''} · #${guest.confirmationNo} · ${fmtDate(guest.arrival)} → ${fmtDate(guest.departure)}` : '—'],
            [
              t('Out of Order', '维修/停用'),
              v.outOfOrder ? `${v.outOfOrder.type} ${fmtDate(v.outOfOrder.from)} → ${fmtDate(v.outOfOrder.to)} · ${v.outOfOrder.reasonCode} · ${t('return', '恢复为')} ${v.outOfOrder.returnStatus}${v.oooActive ? '' : ` (${t('future', '未来')})`}` : '—',
            ],
            [t('Last change', '最后变更'), `${fmtDateTime(v.lastStatusChange)} · ${v.lastChangedBy}`],
          ]}
        />

        <GrmsSection v={v} />

        <div className="section-title" style={{ marginTop: 18 }}>
          {t('Room History (business events)', '房间历史（业务事件）')}
        </div>
        {history.length ? (
          <ul className="timeline">
            {history.map((e) => (
              <li key={e.id}>
                <div className="t">
                  {fmtDateTime(e.timestamp)} · {e.actor} · {e.source}
                </div>
                <div>
                  <code>{e.eventName}</code> {e.summary}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="subtle">{t('No changes recorded in this session yet.', '本次会话暂无变更记录。')}</div>
        )}
      </Drawer>
      <OutOfOrderDialog open={ooo} roomIds={[v.id]} onClose={() => setOoo(false)} />
    </>
  );
}
