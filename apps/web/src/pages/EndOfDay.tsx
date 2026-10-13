/** End of Day / Night Audit + Property Parameters + demo reset (doc 03 §4.13). */
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { addDays, type BusinessEvent, type HotelParameters } from '@opera-demo/core';
import { useStore } from '../store';
import { useT } from '../i18n';
import { Alert, Button, Checkbox, Confirm, KV, Modal, PageHeader, cx } from '../components/ui';
import { fmtBusinessDate, fmtDateTime, roomNo } from '../components/status';

type ParamKey = keyof HotelParameters;

export default function EndOfDay() {
  const { snapshot, views, backendKind, exec, toast } = useStore();
  const t = useT();
  const nav = useNavigate();
  const D = snapshot.hotel.businessDate;
  const next = addDays(D, 1);
  const p = snapshot.hotel.parameters;

  // ---- pre-checks (local preview only; the engine is authoritative)
  const pre = useMemo(() => {
    const dueOuts = snapshot.reservations.filter((r) => r.status === 'InHouse' && r.departure <= D);
    const noShows = snapshot.reservations.filter((r) => r.status === 'Reserved' && r.arrival <= D);
    const noShowsUnassigned = noShows.filter((r) => !r.roomId).length;
    const occupied = views.filter((v) => v.foStatus === 'Occupied');
    const toDirty = p.autoDirtyOnNightAudit ? occupied.filter((v) => v.hkStatus !== 'Dirty').length : 0;
    const murClear = views.filter((v) => v.serviceStatus === 'MUR').length;
    const dndKept = views.filter((v) => v.serviceStatus === 'DND' && v.foStatus === 'Occupied').length;
    const expiring = views.filter((v) => v.outOfOrder && v.outOfOrder.to <= D);
    return { dueOuts, noShows, noShowsUnassigned, toDirty, murClear, dndKept, expiring };
  }, [snapshot.reservations, views, D, p.autoDirtyOnNightAudit]);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dueOutOpen, setDueOutOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [lastEvent, setLastEvent] = useState<{ ev: BusinessEvent | null; from: string; to: string; at: string } | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [pending, setPending] = useState<ParamKey | null>(null);

  const runNightAudit = async () => {
    setConfirmOpen(false);
    setRunning(true);
    const from = D;
    const r = await exec({ type: 'nightAudit' }, { silentError: true });
    setRunning(false);
    if (r.ok) {
      const ev = r.changes?.events?.find((e) => e.eventName === 'BUSINESS DATE CHANGE') ?? null;
      setLastEvent({ ev, from, to: next, at: new Date().toISOString() });
    } else if (r.errorCode === 'DUE_OUTS_PENDING') {
      setDueOutOpen(true);
    } else {
      toast('error', r.error ?? t('End of Day failed', '日结失败'));
    }
  };

  const setParam = async (key: ParamKey, value: boolean) => {
    setPending(key);
    await exec({ type: 'setParameters', parameters: { [key]: value } });
    setPending(null);
  };

  const dueOutList = snapshot.reservations.filter((r) => r.status === 'InHouse' && r.departure <= D);

  const paramRows: { key: ParamKey; en: string; zh: string; hintEn: string; hintZh: string; offNoteEn?: string; offNoteZh?: string }[] = [
    {
      key: 'inspectedStatusEnabled',
      en: 'Inspected status',
      zh: '启用 Inspected（已检查）状态',
      hintEn: 'Adds the Inspected HK status (supervisor check after Clean).',
      hintZh: '启用督导检查后的 Inspected 状态（Clean 之后）。',
      offNoteEn: 'Off: existing Inspected rooms keep their status; the option is hidden in new status pickers.',
      offNoteZh: '关闭：已是 Inspected 的房间保持不变；新的状态选择中不再显示该选项。',
    },
    {
      key: 'pickupStatusEnabled',
      en: 'Pickup status',
      zh: '启用 Pickup（待收拾）状态',
      hintEn: 'Adds the Pickup status for rooms where only minibar/linen pickup is needed.',
      hintZh: '启用 Pickup 状态，用于仅需收取布草或迷你吧的房间。',
      offNoteEn: 'Off: the Pickup option is hidden everywhere (boards, OOO return status, task sheets).',
      offNoteZh: '关闭：Pickup 选项在所有界面中隐藏（房务看板、维修返回状态、任务单）。',
    },
    {
      key: 'allowCheckInClean',
      en: 'Allow check-in to Clean rooms',
      zh: '允许入住 Clean（已清洁）房',
      hintEn: 'When on, a Clean room is ready for check-in even if not Inspected. When off, Inspected is required.',
      hintZh: '开启后，Clean 房即可入住，无需 Inspected；关闭则必须 Inspected 才可入住。',
      offNoteEn: 'Off: check-in to a Clean room is rejected with ROOM_NOT_READY ("must be Inspected").',
      offNoteZh: '关闭：入住 Clean 房会被拒绝（ROOM_NOT_READY，要求 Inspected）。',
    },
    {
      key: 'autoDirtyOnNightAudit',
      en: 'Auto-set occupied rooms Dirty at End of Day',
      zh: '日结时将占用房自动置为 Dirty',
      hintEn: 'Night audit marks every occupied room Dirty so housekeeping services stayovers.',
      hintZh: '日结时把所有占用房置为 Dirty，便于客房清扫续住房。',
    },
  ];

  const expiringLabel = (types: string[]) => types.join(', ');

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[{ label: t('Miscellaneous', '其他') }, { label: t('End of Day', '日结') }]}
        title={t('End of Day & Settings', '夜审与参数')}
        sub={t('Advance the business date, configure OPERA controls and reset the demo.', '推进业务日期、配置 OPERA 参数并重置演示数据')}
      />

      {/* ---------------- Night audit */}
      <section className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="section-title" style={{ marginBottom: 4 }}>{t('Night Audit', '夜审')}</div>
            <div style={{ fontSize: 16 }}>
              {t('Business Date', '业务日期')}:{' '}
              <strong>{fmtBusinessDate(D, 'en')}</strong>
              <span className="muted"> → </span>
              <strong>{fmtBusinessDate(next, 'en')}</strong>
            </div>
          </div>
          <Button variant="primary" size="lg" disabled={running} onClick={() => setConfirmOpen(true)}>
            {running ? t('Running…', '执行中…') : t('Run End of Day', '执行日结')}
          </Button>
        </div>

        <div style={{ marginTop: 14, borderTop: '1px solid var(--oc-border)', paddingTop: 12 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{t('Pre-checks (preview from current data)', '预检（基于当前数据预览）')}</div>
          <ul className="col" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 10 }}>
            <li className="row-wrap">
              <span className={cx('badge', pre.dueOuts.length ? 'err' : 'ok')}>{pre.dueOuts.length ? '✖' : '✔'}</span>
              <span>
                {t(
                  `${pre.dueOuts.length} due-out reservation(s) still in house`,
                  `${pre.dueOuts.length} 位预离住客仍在住`,
                )}
              </span>
              {pre.dueOuts.length > 0 && (
                <Link to="/front-desk/in-house?filter=dueout" className="btn btn-sm">
                  {t('Go to In House (Due Out)', '前往在住页（预离）')}
                </Link>
              )}
            </li>
            <li className="row-wrap">
              <span className={cx('badge', pre.noShows.length ? 'warn' : 'ok')}>{pre.noShows.length ? '⚠' : '✔'}</span>
              <span>
                {t(
                  `${pre.noShows.length} arrival(s) not checked in → will become No Show`,
                  `${pre.noShows.length} 位预抵未入住 → 将转为 No Show`,
                )}
                {pre.noShows.length > 0 && <span className="muted">{` (${pre.noShowsUnassigned} ${t('unassigned', '未排房')})`}</span>}
              </span>
            </li>
            <li className="row-wrap">
              <span className="badge info">ℹ</span>
              <span>
                {p.autoDirtyOnNightAudit
                  ? t(`Occupied rooms to set Dirty: ${pre.toDirty}`, `将置为 Dirty 的占用房：${pre.toDirty}`)
                  : t('Occupied rooms are not auto-set Dirty (parameter off)', '占用房不会自动置 Dirty（参数已关闭）')}
                <span className="muted">
                  {` · ${t('MUR to clear', '待清除 MUR')}: ${pre.murClear} · ${t('DND kept', '保留 DND')}: ${pre.dndKept}`}
                </span>
              </span>
            </li>
            <li className="row-wrap">
              <span className={cx('badge', pre.expiring.length ? 'info' : 'neutral')}>ℹ</span>
              <span>
                {pre.expiring.length
                  ? t(
                      `${pre.expiring.length} OOO/OOS record(s) expire: ${pre.expiring
                        .map((v) => `${roomNo(v.id)} (${v.outOfOrder!.type}) → ${v.outOfOrder!.returnStatus}`)
                        .join(', ')}`,
                      `${pre.expiring.length} 条维修/停用记录到期：${pre.expiring
                        .map((v) => `${roomNo(v.id)} (${v.outOfOrder!.type}) → ${v.outOfOrder!.returnStatus}`)
                        .join('、')}`,
                    )
                  : t('No OOO/OOS records expire at this audit', '本次日结没有到期的维修/停用记录')}
              </span>
            </li>
          </ul>
          {pre.dueOuts.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Alert kind="warning">
                {t(
                  'Due-out guests must be checked out before End of Day can run. Run will show the list.',
                  '预离住客须先退房才能执行日结；点击执行将列出待处理住客。',
                )}
              </Alert>
            </div>
          )}
        </div>
      </section>

      {lastEvent && (
        <section className="card card-pad" style={{ marginBottom: 14, borderLeft: '4px solid var(--oc-success)' }}>
          <div className="section-title">
            {t('Business date rolled', '业务日期已推进')}: {fmtBusinessDate(lastEvent.from)} → {fmtBusinessDate(lastEvent.to)}
          </div>
          {lastEvent.ev ? (
            <>
              <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                {lastEvent.ev.eventName} · seq #{lastEvent.ev.seq} · {fmtDateTime(lastEvent.ev.timestamp)} · {lastEvent.ev.actor}
              </div>
              <KV items={lastEvent.ev.details.map((d) => [d.elementName, `${d.oldValue ?? '—'} → ${d.newValue ?? '—'}`] as [string, string])} />
              <div style={{ marginTop: 10 }} className="muted">{lastEvent.ev.summary}</div>
            </>
          ) : (
            <div className="muted">{t('Event details will appear in the Sync Monitor event stream.', '事件详情见同步监控的事件流。')}</div>
          )}
        </section>
      )}

      <div className="grid-2" style={{ marginBottom: 14 }}>
        {/* ---------------- Property parameters */}
        <section className="card card-pad">
          <div className="section-title">{t('Property Parameters (OPERA Controls)', '物业参数（OPERA 控制项）')}</div>
          <div className="col" style={{ gap: 14 }}>
            {paramRows.map((r) => {
              const on = p[r.key];
              return (
                <div key={r.key}>
                  <Checkbox
                    checked={on}
                    disabled={pending === r.key}
                    onChange={(v) => setParam(r.key, v)}
                    label={<strong style={{ fontWeight: 600 }}>{t(r.en, r.zh)}</strong>}
                  />
                  <div className="muted" style={{ fontSize: 12, marginLeft: 23, marginTop: 2 }}>{t(r.hintEn, r.hintZh)}</div>
                  {!on && r.offNoteEn && <div className="muted" style={{ fontSize: 12, marginLeft: 23, color: 'var(--oc-warning)' }}>{t(r.offNoteEn, r.offNoteZh!)}</div>}
                </div>
              );
            })}
            <div className="subtle" style={{ fontSize: 12 }}>
              {t('Changes apply immediately.', '修改立即生效。')}
            </div>
          </div>
        </section>

        {/* ---------------- Backend & persistence */}
        <section className="card card-pad">
          <div className="section-title">{t('Backend & persistence', '后端与持久化')}</div>
          <KV
            items={[
              [t('Backend mode', '后端模式'), backendKind === 'local' ? t('In-browser engine (GitHub Pages mode)', '浏览器内引擎（GitHub Pages 模式）') : t('Node server (apps/server)', 'Node 服务（apps/server）')],
              [t('Business date', '业务日期'), fmtBusinessDate(D, 'en')],
              [t('Hotel', '酒店'), `${snapshot.hotel.name} (${snapshot.hotel.hotelId})`],
              [t('Snapshot version', '快照版本'), String(snapshot.version)],
              [t('Persistence', '持久化'), backendKind === 'local'
                ? t('Browser localStorage (key opera-demo/state/v1). Survives reloads in this browser only; other tabs in the same browser sync live.', '浏览器 localStorage（键 opera-demo/state/v1）。仅在本浏览器内刷新后保留；同一浏览器的其他标签页实时同步。')
                : t('Server file: the Node server writes its state to a JSON data file, so every connected browser sees the same data.', '服务器文件：Node 服务把状态写入 JSON 数据文件，所有连接的浏览器看到的是同一份数据。')],
            ]}
          />
        </section>
      </div>

      {/* ---------------- Danger zone */}
      <section className="card card-pad" style={{ borderColor: 'var(--oc-danger)' }}>
        <div className="section-title" style={{ color: 'var(--oc-danger)' }}>{t('Danger zone', '危险操作')}</div>
        <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
          <span className="muted">
            {t(
              'Reset demo data: restores the seed data, sets the business date to today and clears events and deliveries. All open tabs reset too.',
              '重置演示数据：恢复种子数据，业务日期回到今天，清空事件与投递记录。所有打开的标签页同步重置。',
            )}
          </span>
          <Button variant="danger" onClick={() => setResetOpen(true)}>
            {t('Reset demo data', '重置演示数据')}
          </Button>
        </div>
      </section>

      {/* ---------------- Modals */}
      <Modal
        open={confirmOpen}
        title={t('Run End of Day?', '确认执行日结？')}
        onClose={() => setConfirmOpen(false)}
        footer={
          <>
            <Button onClick={() => setConfirmOpen(false)}>{t('Cancel', '取消')}</Button>
            <Button variant="danger" onClick={runNightAudit}>{t('Run End of Day', '执行日结')}</Button>
          </>
        }
      >
        <div className="col">
          <div>
            {t('Business date', '业务日期')}: <strong>{fmtBusinessDate(D)}</strong> → <strong>{fmtBusinessDate(next)}</strong>
          </div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>{t(`Due-outs still in house: ${pre.dueOuts.length}`, `仍在住的预离住客：${pre.dueOuts.length}`)}</li>
            <li>{t(`No Shows: ${pre.noShows.length}`, `No Show：${pre.noShows.length}`)}</li>
            <li>{t(`Occupied rooms set Dirty: ${pre.toDirty}`, `置为 Dirty 的占用房：${pre.toDirty}`)}</li>
            <li>{t(`OOO/OOS released: ${pre.expiring.length}`, `到期释放的维修/停用：${pre.expiring.length}`)}</li>
          </ul>
          <Alert kind="error">
            {t('This cannot be undone. The business date advances and room statuses change. Use Reset demo to start over.', '此操作不可撤销：业务日期将推进，房态随之变化。如需重来，请使用「重置演示数据」。')}
          </Alert>
        </div>
      </Modal>

      <Modal
        open={dueOutOpen}
        title={t('Due-out guests still in house', '仍在住的预离住客')}
        onClose={() => setDueOutOpen(false)}
        footer={
          <>
            <Button onClick={() => setDueOutOpen(false)}>{t('Close', '关闭')}</Button>
            <Button
              variant="primary"
              onClick={() => {
                setDueOutOpen(false);
                nav('/front-desk/in-house?filter=dueout');
              }}
            >
              {t('Go to In House (Due Out)', '前往在住页（预离）')}
            </Button>
          </>
        }
      >
        <div className="col">
          <Alert kind="error">
            {t('End of Day is blocked (DUE_OUTS_PENDING). Check out these guests first.', '日结被阻止（DUE_OUTS_PENDING）。请先为以下住客办理退房。')}
          </Alert>
          <div className="table-wrap" style={{ maxHeight: 260 }}>
            <table className="dt">
              <thead>
                <tr>
                  <th>{t('Room', '房间')}</th>
                  <th>{t('Guest', '住客')}</th>
                  <th>{t('Departure', '离店')}</th>
                </tr>
              </thead>
              <tbody>
                {dueOutList.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{roomNo(r.roomId)}</td>
                    <td>{r.guestName}</td>
                    <td>{r.departure}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Modal>

      <Confirm
        open={resetOpen}
        danger
        title={t('Reset demo data?', '重置演示数据？')}
        message={t('All rooms, reservations, events and deliveries return to the seed state, and the business date returns to today.', '所有房间、预订、事件与投递记录都将恢复为种子数据，业务日期回到今天。')}
        confirmLabel={t('Reset', '重置')}
        cancelLabel={t('Cancel', '取消')}
        onCancel={() => setResetOpen(false)}
        onConfirm={async () => {
          setResetOpen(false);
          setLastEvent(null);
          await exec({ type: 'resetDemo' });
        }}
      />
    </div>
  );
}
