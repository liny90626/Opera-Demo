import { useState } from 'react';
import type { AkubelaState, SimAction } from '@opera-demo/core';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { Alert, Button, Field, Select, TextInput } from '../../components/ui';
import { roomNo } from '../../components/status';

type Alarm = Extract<SimAction, { type: 'raiseAlarm' }>['alarmType'];

/** Emulate changes made on the GRMS side so the demo can show inbound sync. */
export default function SimTab({ st }: { st: AkubelaState }) {
  const t = useT();
  const { akubelaCall, toast } = useStore();
  const mapped = st.mappings.filter((m) => m.residenceId);
  const [resId, setResId] = useState('');
  const sel = resId || mapped[0]?.residenceId || '';
  const [orderId, setOrderId] = useState('');
  const [alarm, setAlarm] = useState<Alarm>('sos');
  const [msg, setMsg] = useState('');
  const openOrders = st.links.filter((l) => !l.closed && l.state === 'checked_in');
  const ord = orderId || openOrders[0]?.orderId || '';
  const send = async (a: SimAction, ok: string) => {
    const r = await akubelaCall('POST', '/sim', a);
    if (r.status < 400) {
      toast('success', ok);
      void akubelaCall('POST', '/poll', undefined, { silent: true });
    }
  };
  if (st.mode !== 'sim') return <Alert kind="info">{t('The simulator is only available in Simulator mode.', '仅在模拟器模式下可用。')}</Alert>;
  const g = sel ? st.grmsRooms[sel] : null;
  return (
    <div className="col" style={{ gap: 14 }}>
      <Alert kind="info">
        {t('These controls emulate actions on the GRMS side (room panel, housekeeping app, guest kiosk). The connector picks them up on the next poll and updates OPERA.', '这些按钮模拟 GRMS 侧的操作（房内面板、清洁 App、自助机）。连接器在下次轮询时发现变化并回写 OPERA。')}
      </Alert>
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="card card-pad col" style={{ gap: 10 }}>
          <div className="section-title" style={{ margin: 0 }}>{t('Room state in GRMS', 'GRMS 房间状态')}</div>
          <Field label={t('Room', '房间')}>
            <Select value={sel} onChange={setResId} options={mapped.map((m) => ({ value: m.residenceId!, label: `${roomNo(m.roomId)} → ${m.residenceName ?? ''}` }))} />
          </Field>
          {g && (
            <div className="subtle">
              GRMS: dirty={String(g.dirty)} · occupied={String(g.occupied)} · dnd={String(g.dnd)}
            </div>
          )}
          <div className="row-wrap">
            <Button variant="primary" disabled={!sel} onClick={() => send({ type: 'setRoomState', residenceId: sel, dirty: false }, t('GRMS: room marked clean', 'GRMS：已标记净房'))}>
              {t('Mark room clean', '标记净房')}
            </Button>
            <Button disabled={!sel} onClick={() => send({ type: 'setRoomState', residenceId: sel, dirty: true }, t('GRMS: room marked dirty', 'GRMS：已标记脏房'))}>
              {t('Mark room dirty', '标记脏房')}
            </Button>
            <Button disabled={!sel} onClick={() => send({ type: 'setRoomState', residenceId: sel, dnd: true }, 'GRMS: DND on')}>
              DND on
            </Button>
            <Button disabled={!sel} onClick={() => send({ type: 'setRoomState', residenceId: sel, dnd: false }, 'GRMS: DND off')}>
              DND off
            </Button>
          </div>
        </div>
        <div className="card card-pad col" style={{ gap: 10 }}>
          <div className="section-title" style={{ margin: 0 }}>{t('Guest self check-out', '客人自助退房')}</div>
          <Field label={t('Checked-in order', '在住订单')}>
            <Select value={ord} onChange={setOrderId} placeholder={t('— no checked-in order —', '— 无在住订单 —')} options={openOrders.map((l) => ({ value: l.orderId, label: `${roomNo(l.roomId)} · #${l.orderNumber} · ${l.confirmationNo}` }))} />
          </Field>
          <div>
            <Button variant="danger" disabled={!ord} onClick={() => send({ type: 'guestSelfCheckout', orderId: ord }, t('GRMS: guest checked out', 'GRMS：客人已自助退房'))}>
              {t('Guest checks out in GRMS', '客人在 GRMS 自助退房')}
            </Button>
          </div>
        </div>
        <div className="card card-pad col" style={{ gap: 10 }}>
          <div className="section-title" style={{ margin: 0 }}>{t('Raise alarm', '触发告警')}</div>
          <div className="grid-2">
            <Field label={t('Type', '类型')}>
              <Select value={alarm} onChange={(v) => v && setAlarm(v)} options={(['sos', 'smoke', 'low_power', 'water_leak'] as Alarm[]).map((a) => ({ value: a, label: a }))} />
            </Field>
            <Field label={t('Message', '消息')}>
              <TextInput value={msg} onChange={setMsg} placeholder={t('optional', '可选')} />
            </Field>
          </div>
          <div>
            <Button disabled={!sel} onClick={() => send({ type: 'raiseAlarm', residenceId: sel, alarmType: alarm, message: msg || undefined }, t('GRMS: alarm raised', 'GRMS：已触发告警'))}>
              {t('Raise alarm in selected room', '在所选房间触发告警')}
            </Button>
          </div>
        </div>
        <div className="card card-pad col" style={{ gap: 10 }}>
          <div className="section-title" style={{ margin: 0 }}>{t('Fault injection', '故障注入')}</div>
          <div className="subtle">{t('"UAT profile" reproduces the platform errors seen in the real UAT (20950001, 20950005 …) so retry / DEAD handling can be demonstrated.', '“UAT 档案”复现真实 UAT 的平台错误（20950001、20950005 …），用于演示重试 / DEAD 处理。')}</div>
          <div className="row-wrap">
            <Button onClick={() => send({ type: 'setFaults', profile: 'uat' }, t('UAT fault profile on', '已启用 UAT 故障档案'))}>{t('UAT fault profile', 'UAT 故障档案')}</Button>
            <Button onClick={() => send({ type: 'setFaults', profile: 'none' }, t('Faults cleared', '已清除故障'))}>{t('No faults', '无故障')}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
