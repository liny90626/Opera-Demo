import { useEffect, useState } from 'react';
import type { AkubelaSettings, AkubelaState } from '@opera-demo/core';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { Button, Checkbox, Field, TextInput } from '../../components/ui';
import { useScenes } from './shared';

export default function SettingsTab({ st }: { st: AkubelaState }) {
  const t = useT();
  const { akubelaCall, toast } = useStore();
  const [draft, setDraft] = useState<AkubelaSettings>(st.settings);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(st.settings);
  }, [st.settings, dirty]);
  const { scenes } = useScenes();
  const set = <K extends keyof AkubelaSettings>(k: K, v: AkubelaSettings[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setDirty(true);
  };
  const save = async () => {
    const r = await akubelaCall('PUT', '/settings', draft);
    if (r.status < 400) {
      setDirty(false);
      toast('success', t('Settings saved', '设置已保存'));
    }
  };
  const toggles: { k: keyof AkubelaSettings; en: string; zh: string; dEn: string; dZh: string }[] = [
    { k: 'preRegisterOnAssign', en: 'Pre-register on room assign', zh: '排房即预登记', dEn: 'Create a pending (check_in) GRMS order when a room is assigned to an arrival, so the lock and room are ready before arrival.', dZh: '为预抵客人分配房间时，在 GRMS 创建待入住 (check_in) 订单，便于提前准备门锁与房间。' },
    { k: 'syncHkStatus', en: 'Push housekeeping status', zh: '推送房务状态', dEn: 'Send OPERA Dirty/Clean changes to GRMS (dirty flag).', dZh: '把 OPERA 的脏/净变更推送到 GRMS（dirty 标志）。' },
    { k: 'acceptGrmsClean', en: 'Accept clean/dirty from GRMS', zh: '接受 GRMS 清洁/脏房回写', dEn: 'When GRMS marks a room clean or dirty (e.g. attendant on HyPanel), update the OPERA HK status.', dZh: 'GRMS 侧（如客房员面板）标记净房/脏房时，更新 OPERA 房务状态。' },
    { k: 'acceptGrmsDnd', en: 'Accept DND from GRMS', zh: '接受 GRMS 请勿打扰', dEn: 'Mirror the guest DND switch from the room panel into OPERA service status (in-house rooms).', dZh: '把客人在房内面板设置的请勿打扰同步为 OPERA 服务状态（在住房）。' },
    { k: 'acceptGrmsCheckout', en: 'Accept guest self check-out', zh: '接受自助退房', dEn: 'Check the reservation out in OPERA when GRMS reports the order checked_out.', dZh: 'GRMS 订单变为 checked_out 时，自动在 OPERA 办理退房。' },
    { k: 'doorPinOnCheckIn', en: 'Door PIN on check-in', zh: '入住发放门锁 PIN', dEn: 'Create a door PIN authorization record on check-in and delete it on check-out.', dZh: '入住时创建门锁 PIN 授权，退房时删除。' },
  ];
  const sceneOpts = (scenes ?? []).map((s) => ({ v: s.scene_id, l: s.scene_name }));
  const sceneSel = (k: 'welcomeSceneId' | 'checkoutSceneId') => (
    <select className="select" value={draft[k] ?? ''} onChange={(e) => set(k, e.target.value || null)}>
      <option value="">{t('— none —', '— 无 —')}</option>
      {sceneOpts.map((o) => (
        <option key={o.v} value={o.v}>
          {o.l}
        </option>
      ))}
      {draft[k] && !sceneOpts.some((o) => o.v === draft[k]) && <option value={draft[k]!}>{draft[k]}</option>}
    </select>
  );
  return (
    <div className="card card-pad col" style={{ gap: 14 }}>
      <div className="aku-settings">
        {toggles.map((x) => (
          <div key={x.k} className="aku-setting">
            <Checkbox checked={draft[x.k] as boolean} onChange={(v) => set(x.k, v as never)} label={<b>{t(x.en, x.zh)}</b>} />
            <div className="subtle" style={{ fontSize: 12, marginLeft: 24 }}>{t(x.dEn, x.dZh)}</div>
          </div>
        ))}
      </div>
      <div className="grid-3">
        <Field label={t('Welcome scene (check-in)', '欢迎场景（入住）')}>{sceneSel('welcomeSceneId')}</Field>
        <Field label={t('Check-out scene', '退房场景')}>{sceneSel('checkoutSceneId')}</Field>
        <Field label={t('Order source', '订单来源')}>
          <TextInput value={draft.orderSource} onChange={(v) => set('orderSource', v)} />
        </Field>
        <Field label={t('Hotel timezone (IANA)', '酒店时区 (IANA)')}>
          <TextInput value={draft.hotelTimezone} onChange={(v) => set('hotelTimezone', v)} />
        </Field>
        <Field label={t('Check-in time (local)', '入住时间（本地）')}>
          <TextInput type="time" value={draft.checkInTime} onChange={(v) => set('checkInTime', v)} />
        </Field>
        <Field label={t('Check-out time (local)', '退房时间（本地）')}>
          <TextInput type="time" value={draft.checkOutTime} onChange={(v) => set('checkOutTime', v)} />
        </Field>
        <Field label={t('Poll interval (seconds)', '轮询间隔（秒）')}>
          <TextInput type="number" min={5} max={600} value={draft.pollSeconds} onChange={(v) => set('pollSeconds', Math.max(5, Number(v) || 20))} />
        </Field>
      </div>
      <div className="subtle" style={{ fontSize: 12 }}>
        {t('OPERA dates are converted to GRMS UTC times using the hotel timezone and the check-in/out times above.', 'OPERA 日期会按酒店时区与上述入离时间转换为 GRMS 使用的 UTC 时间。')}
      </div>
      <div className="row">
        <Button variant="primary" disabled={!dirty} onClick={save}>
          {t('Save', '保存')}
        </Button>
        <Button disabled={!dirty} onClick={() => { setDraft(st.settings); setDirty(false); }}>
          {t('Discard', '放弃')}
        </Button>
      </div>
    </div>
  );
}
