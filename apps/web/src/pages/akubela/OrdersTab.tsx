import { useMemo } from 'react';
import type { AkubelaState, OrderLink } from '@opera-demo/core';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { DataTable, EmptyState, type Column } from '../../components/ui';
import { roomNo } from '../../components/status';
import { MaskedPin, OrderStateBadge, fmtStamp } from './shared';

export default function OrdersTab({ st }: { st: AkubelaState }) {
  const t = useT();
  const { snapshot } = useStore();
  const resv = useMemo(() => new Map(snapshot.reservations.map((r) => [r.id, r])), [snapshot.reservations]);
  const resName = useMemo(() => new Map(st.residences.map((r) => [r.residence_id, r.residence_name])), [st.residences]);
  const cols: Column<OrderLink>[] = [
    { key: 'resv', header: t('OPERA Reservation', 'OPERA 预订'), sortValue: (l) => l.confirmationNo, render: (l) => <b>#{l.confirmationNo}</b> },
    { key: 'guest', header: t('Guest', '客人'), render: (l) => resv.get(l.reservationId)?.guestName ?? '—' },
    { key: 'st', header: t('Resv Status', '预订状态'), render: (l) => resv.get(l.reservationId)?.status ?? '—' },
    { key: 'room', header: t('Room', '房间'), render: (l) => roomNo(l.roomId) },
    { key: 'ord', header: t('GRMS Order', 'GRMS 订单'), render: (l) => <span className="mono">{l.orderNumber}</span> },
    { key: 'state', header: t('Order State', '订单状态'), render: (l) => (
      <span className="row" style={{ gap: 4 }}>
        <OrderStateBadge state={l.state} />
        {l.closed && <span className="badge neutral">{t('closed', '已关闭')}</span>}
      </span>
    ) },
    { key: 'res', header: t('Residence', 'GRMS 房间'), render: (l) => resName.get(l.residenceId) ?? l.residenceId.slice(0, 8) },
    { key: 'pin', header: 'PIN', render: (l) => <MaskedPin pin={l.pin} /> },
    { key: 'upd', header: t('Updated', '更新时间'), sortValue: (l) => l.updatedAt, render: (l) => fmtStamp(l.updatedAt) },
  ];
  const links = [...st.links].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div className="col" style={{ gap: 18 }}>
      <div>
        <div className="section-title">{t('OPERA reservation ↔ GRMS order links', 'OPERA 预订 ↔ GRMS 订单关联')}</div>
        <DataTable columns={cols} rows={links} rowKey={(l) => l.orderId} pageSize={30} rowClassName={(l) => (l.closed ? 'aku-closed' : undefined)} empty={<EmptyState title={t('No order links yet', '暂无订单关联')} hint={t('Assign a room to an arrival or check a guest in (mapped room).', '为预抵客人分配房间，或为已映射房间办理入住。')} />} />
      </div>
      <div>
        <div className="section-title">
          {t('External GRMS orders (not created by OPERA)', '外部 GRMS 订单（非 OPERA 创建）')} <span className="subtle">({st.externalOrders.length})</span>
        </div>
        <DataTable
          columns={[
            { key: 'n', header: t('Order No.', '订单号'), render: (o) => <span className="mono">{o.order_number}</span> },
            { key: 'r', header: t('Residence', 'GRMS 房间'), render: (o) => o.residence_no },
            { key: 's', header: t('State', '状态'), render: (o) => <OrderStateBadge state={o.order_state} /> },
            { key: 'g', header: t('Guests', '客人'), render: (o) => o.guests.map((g) => g.guest_name).join(', ') || '—' },
            { key: 'f', header: t('From', '开始'), render: (o) => o.start_time },
            { key: 't', header: t('To', '结束'), render: (o) => o.finish_time },
            { key: 'src', header: t('Source', '来源'), render: (o) => o.source ?? '—' },
          ]}
          rows={st.externalOrders}
          rowKey={(o) => o.order_id}
          empty={<EmptyState title={t('No external orders', '没有外部订单')} />}
        />
      </div>
    </div>
  );
}
