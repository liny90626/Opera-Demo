/** Helpers shared by the Housekeeping Board / Discrepancies / Out of Order pages. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx, useOutside, type MenuItem } from '../../components/ui';
import { useStore } from '../../store';

// ------------------------------------------------------------------ URL list params
export const getList = (sp: URLSearchParams, key: string): string[] =>
  (sp.get(key) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
export const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, '');
export const isTrue = (v: string | null) => v === '1' || v === 'true' || v === 'yes';

/** Update some query keys (empty / null value removes the key). */
export function patchParams(sp: URLSearchParams, patch: Record<string, string | string[] | null | undefined>): URLSearchParams {
  const n = new URLSearchParams(sp);
  for (const [k, v] of Object.entries(patch)) {
    const s = Array.isArray(v) ? v.join(',') : v;
    if (s) n.set(k, s);
    else n.delete(k);
  }
  return n;
}

export const shortDate = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  return `${String(d.getDate()).padStart(2, '0')}-${d.toLocaleDateString('en-GB', { month: 'short' })}`;
};

/** Room-number string range compare (spec 3.2: string comparison, From only => everything after). */
export function inRoomRange(number: string, from: string, to: string) {
  if (from && number < from) return false;
  if (to && number > to) return false;
  return true;
}

// ------------------------------------------------------------------ flash tick
/** Re-renders the caller once the 2.5 s flash window of the latest change has elapsed. Returns isFlashing(roomId). */
export function useFlash() {
  const { recentRooms } = useStore();
  const [, force] = useState(0);
  const latest = Object.values(recentRooms).reduce((a, b) => Math.max(a, b), 0);
  useEffect(() => {
    if (!latest) return;
    const left = 2600 - (Date.now() - latest);
    if (left <= 0) return;
    const t = setTimeout(() => force((x) => x + 1), left);
    return () => clearTimeout(t);
  }, [latest]);
  return (roomId: string) => {
    const ts = recentRooms[roomId];
    return !!ts && Date.now() - ts < 2500;
  };
}

// ------------------------------------------------------------------ MultiSelect
export function MultiSelect({ value, onChange, options, allLabel = 'All', width = 150 }: {
  value: string[];
  onChange: (v: string[]) => void;
  options: { value: string; label: string }[];
  allLabel?: string;
  width?: number | string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutside<HTMLDivElement>(open, () => setOpen(false));
  const summary =
    value.length === 0 ? allLabel : value.length === 1 ? options.find((o) => o.value === value[0])?.label ?? value[0] : `${value.length} selected`;
  return (
    <div className="menu-wrap" ref={ref} style={{ width, display: 'block' }}>
      <button type="button" className="select" style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
        <span style={{ fontSize: 9 }}>▼</span>
      </button>
      {open && (
        <div className="menu left" role="listbox" style={{ minWidth: '100%', maxHeight: 260, overflow: 'auto', padding: 4, zIndex: 40 }}>
          {options.map((o) => {
            const on = value.includes(o.value);
            return (
              <label key={o.value} className="check" style={{ display: 'flex', padding: '4px 8px', whiteSpace: 'nowrap' }}>
                <input type="checkbox" checked={on} onChange={() => onChange(on ? value.filter((x) => x !== o.value) : [...value, o.value])} />
                {o.label}
              </label>
            );
          })}
          {value.length > 0 && (
            <button type="button" className="menu-item" onClick={() => onChange([])}>
              ✕ {allLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Row "⋮" menu (portal, so table scrolling never clips it)
export function RowMenu({ items, label = 'Actions' }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (menu.current?.contains(e.target as Node) || btn.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !btn.current || !menu.current) return;
    const r = btn.current.getBoundingClientRect();
    const m = menu.current.getBoundingClientRect();
    const top = r.bottom + m.height + 8 > window.innerHeight ? Math.max(8, r.top - m.height - 4) : r.bottom + 4;
    const left = Math.max(8, Math.min(window.innerWidth - m.width - 8, r.right - m.width));
    setPos({ top, left });
  }, [open]);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="btn btn-link btn-sm"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{ fontSize: 18, lineHeight: 1, padding: '0 6px' }}
        onClick={(e) => {
          e.stopPropagation();
          setPos(null);
          setOpen((o) => !o);
        }}
      >
        ⋮
      </button>
      {open &&
        createPortal(
          <div ref={menu} className={cx('menu')} role="menu" style={{ position: 'fixed', right: 'auto', top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden', zIndex: 300 }}>
            {items.map((it, i) =>
              'divider' in it ? (
                <div key={i} className="menu-sep" />
              ) : 'group' in it ? (
                <div key={i} className="menu-group">{it.group}</div>
              ) : (
                <button
                  key={i}
                  role="menuitem"
                  className="menu-item"
                  style={it.danger ? { color: 'var(--oc-danger)' } : undefined}
                  disabled={it.disabled}
                  onClick={() => {
                    setOpen(false);
                    it.onClick();
                  }}
                >
                  {it.label}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

/** Applied-filter chip with an ✕. */
export function FilterChip({ children, onRemove }: { children: ReactNode; onRemove: () => void }) {
  return (
    <span className="chip on" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'default' }}>
      {children}
      <button type="button" aria-label="Remove filter" onClick={onRemove} style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 0, fontSize: 14, lineHeight: 1, color: 'inherit' }}>
        ×
      </button>
    </span>
  );
}
