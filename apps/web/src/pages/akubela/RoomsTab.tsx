import { useMemo, useState } from 'react';
import type { AkubelaState, RoomView } from '@opera-demo/core';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { Checkbox, DataTable, EmptyState, Select, TextInput, type Column } from '../../components/ui';
import { roomNo } from '../../components/status';
import { ErrBadge, Flag, pmsFlags } from './shared';

interface Row {
  v: RoomView;
  residenceId: string | null;
  residenceName: string | null;
  origin: 'auto' | 'manual' | null;
  grms: AkubelaState['grmsRooms'][string] | null;
}

export default function RoomsTab({ st, onOpen }: { st: AkubelaState; onOpen: (roomId: string) => void }) {
  const t = useT();
  const { views, akubelaCall } = useStore();
  const [mappedOnly, setMappedOnly] = useState(true);
  const [q, setQ] = useState('');
  const rows = useMemo<Row[]>(() => {
    const mp = new Map(st.mappings.map((m) => [m.roomId, m]));
    return views
      .map((v) => {
        const m = mp.get(v.id);
        return { v, residenceId: m?.residenceId ?? null, residenceName: m?.residenceName ?? null, origin: m?.origin ?? null, grms: m?.residenceId ? st.grmsRooms[m.residenceId] ?? null : null };
      })
      .filter((r) => (!mappedOnly || r.residenceId) && (!q || r.v.number.includes(q)));
  }, [views, st.mappings, st.grmsRooms, mappedOnly, q]);
  const mappedCount = st.mappings.filter((m) => m.residenceId).length;
  const taken = new Set(st.mappings.map((m) => m.residenceId).filter(Boolean));
  const resOptions = (cur: string | null) => st.residences.filter((r) => r.residence_id === cur || !taken.has(r.residence_id)).map((r) => ({ value: r.residence_id, label: `${r.residence_name} · ${r.building_name}/${r.floor_name}` }));

  const mismatch = (r: Row) => {
    const p = pmsFlags(r.v);
    return !!r.grms && (r.grms.dirty !== p.dirty || r.grms.occupied !== p.occupied || r.grms.dnd !== p.dnd);
  };
  const cols: Column<Row>[] = [
    { key: 'room', header: t('OPERA (master) Room', 'OPERA（主）房间'), sortValue: (r) => r.v.number, render: (r) => <b>{roomNo(r.v.id)}</b>, width: 90 },
    {
      key: 'map',
      header: t('→ GRMS Residence', '→ GRMS 房间'),
      render: (r) => (
        <span onClick={(e) => e.stopPropagation()} className="row" style={{ gap: 6 }}>
          <Select
            value={r.residenceId ?? ''}
            placeholder={t('— not mapped —', '— 未映射 —')}
            options={resOptions(r.residenceId)}
            onChange={(val) => void akubelaCall('PUT', '/mapping', { roomId: r.v.id, residenceId: val || null })}
          />
          {r.origin && r.residenceId && <span className="badge neutral">{r.origin}</span>}
        </span>
      ),
    },
    { key: 'hk', header: 'OPERA HK', render: (r) => r.v.hkStatus },
    { key: 'fo', header: 'OPERA FO', render: (r) => r.v.foStatus },
    { key: 'pdnd', header: 'OPERA DND', render: (r) => <Flag v={pmsFlags(r.v).dnd} /> },
    {
      key: 'gd',
      header: 'GRMS dirty',
      render: (r) => <Flag v={r.grms?.dirty} bad={r.grms?.dirty != null && r.grms.dirty !== pmsFlags(r.v).dirty} />,
    },
    {
      key: 'go',
      header: 'GRMS occupied',
      render: (r) => <Flag v={r.grms?.occupied} bad={r.grms?.occupied != null && r.grms.occupied !== pmsFlags(r.v).occupied} />,
    },
    {
      key: 'gn',
      header: 'GRMS DND',
      render: (r) => <Flag v={r.grms?.dnd} bad={r.grms?.dnd != null && r.grms.dnd !== pmsFlags(r.v).dnd} />,
    },
    { key: 'sync', header: t('Sync', '同步'), render: (r) => (r.grms && mismatch(r) ? <span className="badge warn">→ {t('push', '推送')}</span> : r.grms ? <span className="subtle">✓</span> : null) },
    { key: 'err', header: t('Error', '错误'), render: (r) => <ErrBadge e={r.grms?.error} /> },
  ];

  return (
    <DataTable
      columns={cols}
      rows={rows}
      rowKey={(r) => r.v.id}
      pageSize={40}
      onRowClick={(r) => onOpen(r.v.id)}
      rowClassName={(r) => {
        if (!r.grms) return undefined;
        const p = pmsFlags(r.v);
        return r.grms.dirty !== p.dirty || r.grms.occupied !== p.occupied || r.grms.dnd !== p.dnd ? 'aku-mismatch' : undefined;
      }}
      empty={<EmptyState title={t('No mapped rooms', '没有已映射的房间')} hint={t('Turn off "Mapped only" and map an OPERA room to a GRMS residence.', '关闭“仅显示已映射”，并将 OPERA 房间映射到 GRMS 房间。')} />}
      toolbar={
        <>
          <Checkbox checked={mappedOnly} onChange={setMappedOnly} label={`${t('Mapped only', '仅显示已映射')} (${mappedCount}/${st.mappings.length})`} />
          <TextInput value={q} onChange={setQ} placeholder={t('Room no.', '房号')} className="aku-q" />
          <span className="subtle">{t('Red = GRMS differs from OPERA (the master) – will be pushed', '红色 = GRMS 与主系统 OPERA 不一致，将被推送覆盖')}</span>
        </>
      }
    />
  );
}
