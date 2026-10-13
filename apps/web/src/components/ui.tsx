/**
 * Shared OPERA-style UI kit. Pages should compose these instead of re-inventing markup.
 * Styling lives in styles/components.css.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export { cx };

// ------------------------------------------------------------------ Button
export function Button({
  variant = 'secondary',
  size,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'link'; size?: 'sm' | 'lg' }) {
  return <button type="button" className={cx('btn', `btn-${variant}`, size && `btn-${size}`, className)} {...rest} />;
}

// ------------------------------------------------------------------ Form fields
export function Field({ label, required, error, children, className }: { label: ReactNode; required?: boolean; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <div className={cx('field', className)}>
      <label>
        {label}
        {required && <span className="req">*</span>}
      </label>
      {children}
      {error && <div className="field-error">{error}</div>}
    </div>
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  className,
  disabled,
  invalid,
}: {
  value: T | '';
  onChange: (v: T | '') => void;
  options: { value: T; label: string }[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  return (
    <select className={cx('select', invalid && 'invalid', className)} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T | '')}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function TextInput({ value, onChange, placeholder, type = 'text', className, invalid, ...rest }: {
  value: string | number;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  className?: string;
  invalid?: boolean;
  min?: string | number;
  max?: string | number;
  autoFocus?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  return <input className={cx('input', invalid && 'invalid', className)} type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} {...rest} />;
}

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** Multi-select toggle chips (filters). */
export function Chips<T extends string>({ options, value, onChange }: { options: { value: T; label: ReactNode }[]; value: T[]; onChange: (v: T[]) => void }) {
  return (
    <div className="chips">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button type="button" key={o.value} className={cx('chip', on && 'on')} onClick={() => onChange(on ? value.filter((x) => x !== o.value) : [...value, o.value])}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ Page header / breadcrumb
export function PageHeader({ title, sub, breadcrumb, actions }: { title: ReactNode; sub?: ReactNode; breadcrumb?: { label: string; to?: string }[]; actions?: ReactNode }) {
  return (
    <>
      {breadcrumb && (
        <div className="breadcrumb">
          {breadcrumb.map((b, i) => (
            <span key={i}>
              {b.to ? <Link to={b.to}>{b.label}</Link> : b.label}
              {i < breadcrumb.length - 1 && <span style={{ marginLeft: 6 }}>›</span>}
            </span>
          ))}
        </div>
      )}
      <div className="page-header">
        <div>
          <h1>{title}</h1>
          {sub && <div className="sub">{sub}</div>}
        </div>
        {actions && <div className="row-wrap">{actions}</div>}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ Search panel
export function SearchPanel({ title, children, onSearch, onClear, searchLabel = 'Search', clearLabel = 'Clear', extra }: {
  title?: ReactNode;
  children: ReactNode;
  onSearch?: () => void;
  onClear?: () => void;
  searchLabel?: string;
  clearLabel?: string;
  extra?: ReactNode;
}) {
  return (
    <div className="card search-panel">
      {title && (
        <div className="search-panel-head">
          <h3>{title}</h3>
          {extra}
        </div>
      )}
      <div className="fields">{children}</div>
      {(onSearch || onClear) && (
        <div className="actions">
          {onClear && <Button variant="link" onClick={onClear}>{clearLabel}</Button>}
          {onSearch && <Button variant="primary" onClick={onSearch}>{searchLabel}</Button>}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Data table
export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /** Enables sorting on this column. */
  sortValue?: (row: T) => string | number;
  width?: number | string;
  align?: 'left' | 'right' | 'center';
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  selectable,
  selected,
  onSelectedChange,
  onRowClick,
  rowClassName,
  empty,
  pageSize = 50,
  toolbar,
  initialSort,
  maxHeight,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  selectable?: boolean;
  selected?: string[];
  onSelectedChange?: (keys: string[]) => void;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  empty?: ReactNode;
  pageSize?: number;
  toolbar?: ReactNode;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  maxHeight?: number | string;
}) {
  const [sort, setSort] = useState(initialSort ?? null);
  const [page, setPage] = useState(0);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const sv = col.sortValue;
    return [...rows].sort((a, b) => {
      const x = sv(a);
      const y = sv(b);
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return sort.dir === 'asc' ? r : -r;
    });
  }, [rows, sort, columns]);
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const p = Math.min(page, pages - 1);
  const visible = sorted.slice(p * pageSize, (p + 1) * pageSize);
  const sel = new Set(selected ?? []);
  const allKeys = sorted.map(rowKey);
  const allOn = allKeys.length > 0 && allKeys.every((k) => sel.has(k));
  const toggle = (k: string) => {
    const n = new Set(sel);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    onSelectedChange?.([...n]);
  };
  return (
    <div className="table-wrap">
      {toolbar && <div className="table-toolbar">{toolbar}</div>}
      <div style={{ maxHeight, overflow: maxHeight ? 'auto' : undefined }}>
        <table className="dt">
          <thead>
            <tr>
              {selectable && (
                <th className="sel">
                  <input type="checkbox" aria-label="Select all" checked={allOn} onChange={() => onSelectedChange?.(allOn ? [] : allKeys)} />
                </th>
              )}
              {columns.map((c) => (
                <th
                  key={c.key}
                  style={{ width: c.width }}
                  className={cx(c.sortValue && 'sortable', c.align === 'right' && 'num', c.align === 'center' && 'center')}
                  onClick={() => c.sortValue && setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: 'asc' }))}
                >
                  {c.header}
                  {sort?.key === c.key && <span style={{ marginLeft: 4 }}>{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const k = rowKey(row);
              return (
                <tr key={k} className={cx(sel.has(k) && 'selected', onRowClick && 'clickable', rowClassName?.(row))} onClick={() => onRowClick?.(row)}>
                  {selectable && (
                    <td className="sel" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label={`Select ${k}`} checked={sel.has(k)} onChange={() => toggle(k)} />
                    </td>
                  )}
                  {columns.map((c) => (
                    <td key={c.key} className={cx(c.align === 'right' && 'num', c.align === 'center' && 'center')}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && (empty ?? <EmptyState title="No records found" />)}
      </div>
      {pages > 1 && (
        <div className="pager">
          <span>
            {p * pageSize + 1}–{Math.min(sorted.length, (p + 1) * pageSize)} / {sorted.length}
          </span>
          <Button size="sm" disabled={p === 0} onClick={() => setPage(p - 1)}>‹</Button>
          <Button size="sm" disabled={p >= pages - 1} onClick={() => setPage(p + 1)}>›</Button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Tile
export function Tile({ title, onTitleClick, children, className, actions }: { title: ReactNode; onTitleClick?: () => void; children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <section className={cx('tile', className)}>
      <div className="row" style={{ justifyContent: 'center', position: 'relative' }}>
        <h3 className={cx('tile-title', onTitleClick && 'link')} onClick={onTitleClick}>
          {title}
        </h3>
        {actions && <div style={{ position: 'absolute', right: 0, top: 0 }}>{actions}</div>}
      </div>
      <div className="tile-body">{children}</div>
    </section>
  );
}

export function Stat({ label, value, tone }: { label: ReactNode; value: ReactNode; tone?: string }) {
  return (
    <div className="stat">
      <div className="v" style={{ color: tone }}>{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

// ------------------------------------------------------------------ Popover hook
function useOutside<T extends HTMLElement>(open: boolean, close: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
    };
  }, [open, close]);
  return ref;
}
export { useOutside };

// ------------------------------------------------------------------ Action menu ("I Want To…")
export type MenuItem =
  | { label: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }
  | { divider: true }
  | { group: ReactNode };

export function ActionMenu({ label = 'I Want To…', items, variant = 'secondary', align = 'right', disabled }: { label?: ReactNode; items: MenuItem[]; variant?: 'primary' | 'secondary' | 'link'; align?: 'left' | 'right'; disabled?: boolean }) {
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null);
  const btnRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = !!pos;
  const close = () => setPos(null);
  // The menu is portalled to <body> with fixed positioning so scrolling tables (.table-wrap) never clip it.
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !menuRef.current?.contains(t)) close();
    };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  // keep the menu inside the viewport vertically
  useLayoutEffect(() => {
    if (!pos || !menuRef.current || !btnRef.current) return;
    const m = menuRef.current.getBoundingClientRect();
    if (m.bottom > window.innerHeight - 8) {
      const b = btnRef.current.getBoundingClientRect();
      const top = Math.max(8, b.top - m.height - 4);
      if (top !== pos.top) setPos({ ...pos, top });
    }
  }, [pos]);
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (open) return close();
    const b = btnRef.current!.getBoundingClientRect();
    setPos(align === 'left' || b.right < 240 ? { top: b.bottom + 4, left: b.left } : { top: b.bottom + 4, right: window.innerWidth - b.right });
  };
  const iconOnly = typeof label === 'string' && /^[⋮⋯…]$/.test(label.trim());
  return (
    <div className="menu-wrap" ref={btnRef}>
      <Button variant={variant} disabled={disabled} onClick={toggle} onDoubleClick={(e) => e.stopPropagation()} aria-haspopup="menu" aria-expanded={open}>
        {label}
        {!iconOnly && <span style={{ fontSize: 10 }}>▼</span>}
      </Button>
      {pos &&
        createPortal(
          <div ref={menuRef} className="menu" role="menu" style={{ position: 'fixed', top: pos.top, left: pos.left, right: pos.right ?? 'auto', zIndex: 150 }} onClick={(e) => e.stopPropagation()}>
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
                    close();
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
    </div>
  );
}

// ------------------------------------------------------------------ Modal & Drawer
export function Modal({ open, title, onClose, children, footer, width }: { open: boolean; title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" style={width ? { width: `min(${width}px, calc(100vw - 32px))` } : undefined}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="x-btn" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ open, title, onClose, children, footer, width }: { open: boolean; title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" style={width ? { width: `min(${width}px, 100vw)` } : undefined}>
        <div className="drawer-head">
          <h2>{title}</h2>
          <button className="x-btn" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </div>
  );
}

/** Simple confirm dialog. */
export function Confirm({ open, title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger, onConfirm, onCancel }: {
  open: boolean;
  title: ReactNode;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      width={460}
      footer={
        <>
          <Button onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message}
    </Modal>
  );
}

// ------------------------------------------------------------------ Tabs
export function Tabs<K extends string>({ tabs, value, onChange }: { tabs: { key: K; label: ReactNode; count?: number }[]; value: K; onChange: (k: K) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={t.key === value} className={cx('tab', t.key === value && 'on')} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count !== undefined && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Empty state / alert
export function EmptyState({ title, hint, action }: { title: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="title">{title}</div>
      {hint && <div>{hint}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

export function Alert({ kind = 'info', children }: { kind?: 'info' | 'warning' | 'error' | 'success'; children: ReactNode }) {
  return <div className={`alert alert-${kind}`}>{children}</div>;
}

/** Key/value list for detail drawers. */
export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
