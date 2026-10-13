/** Room-status visuals shared by every page (icons mimic the OPERA Cloud dashboard tiles). */
import type { DiscrepancyType, DisplayRoomStatus, FoStatus, HkStatus, RoomResvStatus, ServiceStatus } from '@opera-demo/core';
import { useT } from '../i18n';

export const STATUS_COLOR: Record<DisplayRoomStatus, string> = {
  Inspected: 'var(--st-inspected)',
  Clean: 'var(--st-clean)',
  Pickup: 'var(--st-pickup)',
  Dirty: 'var(--st-dirty)',
  OutOfOrder: 'var(--st-ooo)',
  OutOfService: 'var(--st-oos)',
};
export const STATUS_BG: Record<DisplayRoomStatus, string> = {
  Inspected: 'var(--st-inspected-bg)',
  Clean: 'var(--st-clean-bg)',
  Pickup: 'var(--st-pickup-bg)',
  Dirty: 'var(--st-dirty-bg)',
  OutOfOrder: 'var(--st-ooo-bg)',
  OutOfService: 'var(--st-oos-bg)',
};

const STATUS_ZH: Record<DisplayRoomStatus, string> = {
  Inspected: '已查',
  Clean: '干净',
  Pickup: '小清扫',
  Dirty: '脏房',
  OutOfOrder: '维修房',
  OutOfService: '停用房',
};
const STATUS_EN: Record<DisplayRoomStatus, string> = {
  Inspected: 'Inspected',
  Clean: 'Clean',
  Pickup: 'Pickup',
  Dirty: 'Dirty',
  OutOfOrder: 'Out of Order',
  OutOfService: 'Out of Service',
};
export const HK_STATUSES: HkStatus[] = ['Inspected', 'Clean', 'Pickup', 'Dirty'];
export const ALL_DISPLAY_STATUSES: DisplayRoomStatus[] = ['Inspected', 'Clean', 'Pickup', 'Dirty', 'OutOfOrder', 'OutOfService'];

const RESV_ZH: Record<RoomResvStatus, string> = {
  'Not Reserved': '无预订',
  Arrival: '预抵',
  Arrived: '已到',
  'Stay Over': '续住',
  'Due Out': '预离',
  Departed: '已离',
  'Day Use': '钟点房',
};
const DISC_ZH: Record<DiscrepancyType, string> = { Skip: 'Skip 走单', Sleep: 'Sleep 睡房', Person: 'Person 人数差异' };

export function useLabels() {
  const t = useT();
  return {
    status: (s: DisplayRoomStatus) => t(STATUS_EN[s], STATUS_ZH[s]),
    fo: (s: FoStatus) => t(s, s === 'Occupied' ? '住客' : '空房'),
    hkOcc: (s: FoStatus | null) => (s ? t(s, s === 'Occupied' ? '有人' : '无人') : '—'),
    resv: (s: RoomResvStatus) => t(s, RESV_ZH[s]),
    disc: (d: DiscrepancyType) => t(d === 'Person' ? 'Person' : d, DISC_ZH[d]),
    service: (s: ServiceStatus) => (s === 'DND' ? t('Do Not Disturb', '请勿打扰') : s === 'MUR' ? t('Make Up Room', '请即打扫') : '—'),
  };
}

/** Round status icon, like the dashboard "Room Status" tile. */
export function StatusIcon({ status, size = 56 }: { status: DisplayRoomStatus; size?: number }) {
  const c = STATUS_COLOR[status];
  const glyph = (() => {
    switch (status) {
      case 'Inspected': // clipboard with check
        return (
          <g fill="none" stroke="#fff" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round">
            <rect x="17" y="15" width="22" height="27" rx="2" fill="#fff" stroke="none" />
            <rect x="23" y="12" width="10" height="6" rx="1.5" fill={c} stroke="#fff" strokeWidth="2" />
            <path d="M22 29l4.5 4.5L34 24" stroke={c} />
          </g>
        );
      case 'Clean': // sparkle
        return <path fill="#fff" d="M28 12c1.4 7.6 4.4 10.6 12 12-7.6 1.4-10.6 4.4-12 12-1.4-7.6-4.4-10.6-12-12 7.6-1.4 10.6-4.4 12-12zm9 18c.6 3 1.8 4.2 4.8 4.8-3 .6-4.2 1.8-4.8 4.8-.6-3-1.8-4.2-4.8-4.8 3-.6 4.2-1.8 4.8-4.8z" />;
      case 'Pickup': // bin with magnifier (pickup)
        return (
          <g fill="#fff">
            <path d="M18 18h18l-2 22H20z" />
            <rect x="16" y="14" width="22" height="3" rx="1" />
            <circle cx="35" cy="34" r="6" fill={c} stroke="#fff" strokeWidth="2.4" />
            <path d="M39 38l4 4" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
          </g>
        );
      case 'Dirty': // trash can
        return (
          <g fill="#fff">
            <rect x="17" y="15" width="22" height="3.5" rx="1" />
            <rect x="24" y="11.5" width="8" height="4" rx="1" />
            <path d="M19 20h18l-1.8 21H20.8z" />
            <path d="M24 24v13M28 24v13M32 24v13" stroke={c} strokeWidth="1.8" />
          </g>
        );
      case 'OutOfOrder': // traffic cone
        return (
          <g fill="#fff">
            <path d="M25 13h6l7 26H18z" />
            <path d="M22.5 24h11M21 31h14" stroke={c} strokeWidth="3" />
            <rect x="14" y="39" width="28" height="4" rx="1" />
          </g>
        );
      case 'OutOfService': // circle-slash
        return (
          <g fill="none" stroke="#fff" strokeWidth="3.4">
            <circle cx="28" cy="28" r="12" />
            <path d="M19.5 36.5l17-17" />
          </g>
        );
    }
  })();
  return (
    <svg width={size} height={size} viewBox="0 0 56 56" role="img" aria-label={status}>
      <circle cx="28" cy="28" r="27" fill={c} />
      {glyph}
    </svg>
  );
}

export function StatusBadge({ status }: { status: DisplayRoomStatus }) {
  const l = useLabels();
  return (
    <span className={`badge st-${status}`}>
      <span className="badge-dot" style={{ background: status === 'OutOfOrder' || status === 'OutOfService' ? '#fff' : STATUS_COLOR[status] }} />
      {l.status(status)}
    </span>
  );
}

export function FoBadge({ status }: { status: FoStatus }) {
  const l = useLabels();
  return <span className={`badge fo-${status}`}>{l.fo(status)}</span>;
}

export function DiscrepancyBadge({ type }: { type: DiscrepancyType }) {
  const l = useLabels();
  return <span className={`badge disc disc-${type}`}>{l.disc(type)}</span>;
}

export function ServiceBadge({ service }: { service: ServiceStatus }) {
  const l = useLabels();
  if (!service) return null;
  return <span className={`badge svc-${service}`} title={l.service(service)}>{service}</span>;
}

export function ResvStatusBadge({ status }: { status: RoomResvStatus }) {
  const l = useLabels();
  const tone = status === 'Arrival' ? 'info' : status === 'Due Out' ? 'warn' : status === 'Departed' ? 'neutral' : status === 'Not Reserved' ? 'neutral' : 'ok';
  return <span className={`badge ${tone}`}>{l.resv(status)}</span>;
}

// ------------------------------------------------------------------ formatting helpers
export function fmtBusinessDate(iso: string, lang: 'en' | 'zh' = 'en') {
  const d = new Date(`${iso}T12:00:00`);
  return lang === 'zh'
    ? d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
    : d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
}
export function fmtTime(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
export function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-CA')} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}
export function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
/** "0305" -> "305" */
export const roomNo = (id: string | null | undefined) => (id ? id.replace(/^0+/, '') : '—');
