import { useMemo, useState } from 'react';
import { isRoomReady, type Reservation } from '@opera-demo/core';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { Alert, Button, Checkbox, Drawer, Field, Select, TextInput } from '../../components/ui';
import { StatusBadge, fmtDate, roomNo } from '../../components/status';
import { blockedReason } from '../arrivals/frontdesk';

const REASONS = [
  ['Guest request', '客人要求'],
  ['Noise complaint', '噪音投诉'],
  ['Maintenance issue', '设施故障'],
  ['Upgrade', '升级'],
  ['Other', '其他'],
] as const;

export function RoomMoveDrawer({ resv, onClose }: { resv: Reservation; onClose: () => void }) {
  const t = useT();
  const { snapshot, views, exec } = useStore();
  const [sel, setSel] = useState<string | null>(null);
  const [reason, setReason] = useState<string>(REASONS[0][0]);
  const [remarks, setRemarks] = useState('');
  const [typeOk, setTypeOk] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState('');

  const cands = useMemo(() => {
    const D = snapshot.hotel.businessDate;
    const snap = { reservations: snapshot.reservations, conditions: snapshot.conditions, businessDate: D };
    const r = { ...resv, arrival: D };
    return views
      .filter((v) => v.id !== resv.roomId && v.foStatus === 'Vacant' && isRoomReady(snapshot, v))
      .filter((v) => !typeFilter || v.roomType === typeFilter)
      .map((v) => ({ v, blocked: blockedReason(v, r, snap, t) }))
      .sort((a, b) => Number(!!a.blocked) - Number(!!b.blocked) || Number(b.v.roomType === resv.roomType) - Number(a.v.roomType === resv.roomType) || a.v.number.localeCompare(b.v.number, undefined, { numeric: true }));
  }, [views, snapshot, resv, typeFilter, t]);

  const target = cands.find((c) => c.v.id === sel);
  const typeChange = !!target && target.v.roomType !== resv.roomType;
  const canSubmit = !!target && !target.blocked && (!typeChange || typeOk);

  const submit = async () => {
    if (!target) return;
    setErr(null);
    const res = await exec({ type: 'roomMove', reservationId: resv.id, toRoomId: target.v.id, reason: remarks ? `${reason}: ${remarks}` : reason }, { silentError: true });
    if (res.ok) onClose();
    else setErr(`${res.error}${res.errorCode ? ` (${res.errorCode})` : ''}`);
  };

  return (
    <Drawer
      open
      width={640}
      onClose={onClose}
      title={`${t('Room Move', '换房')} · ${resv.guestName} · ${roomNo(resv.roomId)} (${resv.roomType}) · → ${fmtDate(resv.departure)}`}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel', '取消')}</Button>
          <Button variant="primary" disabled={!canSubmit} onClick={submit}>{t('Move', '换房')}</Button>
        </>
      }
    >
      {err && <Alert kind="error">{err}</Alert>}
      <div className="row-wrap" style={{ marginBottom: 12, alignItems: 'flex-end' }}>
        <Field label={t('Room Type', '房型')}>
          <Select value={typeFilter} onChange={setTypeFilter} placeholder={t('Any', '任意')} options={snapshot.roomTypes.map((x) => ({ value: x.code, label: x.code }))} />
        </Field>
        <Field label={t('Reason', '原因')}>
          <Select value={reason} onChange={(v) => setReason(v)} options={REASONS.map(([en, zh]) => ({ value: en, label: t(en, zh) }))} />
        </Field>
        <Field label={t('Remarks', '备注')}><TextInput value={remarks} onChange={setRemarks} /></Field>
      </div>
      <div className="muted" style={{ marginBottom: 6 }}>{t('Ready vacant rooms only', '仅显示就绪的空房')}</div>
      <div className="table-wrap">
        <table className="dt">
          <thead><tr><th>{t('Room', '房号')}</th><th>{t('Type', '房型')}</th><th>{t('Floor', '楼层')}</th><th>{t('HK Status', '房态')}</th><th>{t('Note', '备注')}</th></tr></thead>
          <tbody>
            {cands.map(({ v, blocked }) => (
              <tr key={v.id} className={sel === v.id ? 'selected' : undefined} style={{ opacity: blocked ? 0.5 : 1, cursor: blocked ? 'not-allowed' : 'pointer' }} onClick={() => !blocked && (setSel(v.id), setTypeOk(false))}>
                <td><input type="radio" readOnly checked={sel === v.id} disabled={!!blocked} style={{ marginRight: 6 }} /><b>{v.number}</b></td>
                <td>{v.roomType}</td>
                <td>{v.floor}</td>
                <td><StatusBadge status={v.displayStatus} /></td>
                <td style={{ color: blocked ? 'var(--oc-danger)' : undefined }}>
                  {blocked ?? (v.roomType !== resv.roomType ? <span className="badge warn">{t('Type change', '房型变更')} {resv.roomType} → {v.roomType}</span> : '')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!cands.length && <div className="empty"><div className="title">{t('No ready vacant rooms', '没有就绪的空房')}</div></div>}
      </div>
      {typeChange && (
        <div style={{ marginTop: 12 }}>
          <Checkbox checked={typeOk} onChange={setTypeOk} label={t(`Confirm room type change ${resv.roomType} → ${target!.v.roomType}`, `确认房型变更 ${resv.roomType} → ${target!.v.roomType}`)} />
        </div>
      )}
    </Drawer>
  );
}
