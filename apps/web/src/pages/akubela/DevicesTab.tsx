import { useEffect, useState } from 'react';
import type { AkubelaState } from '@opera-demo/core';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { Alert, Button, EmptyState, Field, Select } from '../../components/ui';
import { roomNo } from '../../components/status';
import { DeviceList, useScenes } from './shared';

export default function DevicesTab({ st }: { st: AkubelaState }) {
  const t = useT();
  const { akubelaCall, toast } = useStore();
  const mapped = st.mappings.filter((m) => m.residenceId);
  const [roomId, setRoomId] = useState('');
  useEffect(() => {
    if (!roomId && mapped.length) setRoomId(mapped[0].roomId);
  }, [roomId, mapped]);
  const { scenes, error } = useScenes();
  if (!mapped.length) return <EmptyState title={t('No mapped rooms', '没有已映射的房间')} hint={t('Map an OPERA room to a GRMS residence in the Rooms tab first.', '请先在“房间”标签页映射房间。')} />;
  const trigger = async (sceneId: string) => {
    const r = await akubelaCall('POST', `/scenes/${encodeURIComponent(sceneId)}/trigger`, { roomIds: [roomId] });
    if (r.status < 400) toast('success', t('Scene triggered', '场景已触发'));
  };
  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div className="card card-pad">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <div className="section-title" style={{ margin: 0 }}>{t('Devices', '设备')}</div>
          <Field label={t('Room', '房间')} className="aku-inline">
            <Select value={roomId} onChange={setRoomId} options={mapped.map((m) => ({ value: m.roomId, label: `${roomNo(m.roomId)} → ${m.residenceName ?? ''}` }))} />
          </Field>
        </div>
        {roomId && <DeviceList key={roomId} roomId={roomId} />}
      </div>
      <div className="card card-pad">
        <div className="section-title">{t('Scenes', '场景')}</div>
        {error && <Alert kind="error">{error}</Alert>}
        {scenes && !scenes.length && <div className="subtle">{t('No scenes defined.', '没有场景。')}</div>}
        <div className="col" style={{ gap: 8 }}>
          {scenes?.map((s) => (
            <div key={s.scene_id} className="aku-device row" style={{ justifyContent: 'space-between' }}>
              <span>{s.scene_name}</span>
              <Button size="sm" variant="primary" disabled={!roomId} onClick={() => trigger(s.scene_id)}>
                {t('Trigger for room', '为该房间触发')} {roomId && roomNo(roomId)}
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
