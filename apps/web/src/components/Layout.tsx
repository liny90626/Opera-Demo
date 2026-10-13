import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ROLES, useStore, type Role } from '../store';
import { useT } from '../i18n';
import { NAV } from '../nav';
import { cx, useOutside } from './ui';
import { fmtBusinessDate } from './status';

function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden>
      <circle cx="16" cy="16" r="15" fill="#2fa58f" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
        <ellipse key={a} cx="16" cy="9" rx="2.6" ry="6" fill="#bfe9df" transform={`rotate(${a} 16 16)`} opacity=".9" />
      ))}
      <circle cx="16" cy="16" r="3.5" fill="#fff" />
    </svg>
  );
}

function CloudMark() {
  return (
    <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden>
      <circle cx="16" cy="16" r="15" fill="#137e96" />
      <path d="M9.5 20.5a4 4 0 01.6-7.9 5.5 5.5 0 0110.6-1.2 4.6 4.6 0 011.3 9.1z" fill="none" stroke="#fff" strokeWidth="2" />
    </svg>
  );
}

function Header({ onBurger }: { onBurger: () => void }) {
  const { snapshot, conn, remotePulse, role, setRole, lang, setLang, backendKind } = useStore();
  const t = useT();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useOutside<HTMLDivElement>(open, () => setOpen(false));
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    if (!remotePulse) return;
    setPulse(true);
    const id = setTimeout(() => setPulse(false), 1000);
    return () => clearTimeout(id);
  }, [remotePulse]);
  const h = snapshot.hotel;
  return (
    <header className="oc-header">
      <button className="oc-burger" aria-label="Menu" onClick={onBurger}>
        <svg width="22" height="18" viewBox="0 0 22 18" aria-hidden>
          <path d="M0 1h22M0 9h22M0 17h22" stroke="#fff" strokeWidth="2.4" />
        </svg>
      </button>
      <div className="oc-logo-box">
        <Logo />
      </div>
      <div className="spacer" />
      <span
        className={cx('oc-conn', conn, pulse && 'pulse')}
        title={backendKind === 'local' ? t('Running in-browser PMS engine (GitHub Pages mode). Open another tab to see live sync.', '浏览器内置 PMS 引擎（GitHub Pages 模式），打开多个标签页可观察实时同步') : t('Connected to PMS server via Server-Sent Events', '通过 SSE 连接 PMS 服务器')}
      >
        <span className="dot" />
        <span className="label">{conn === 'online' ? t('Live', '实时同步') : conn === 'connecting' ? t('Connecting…', '连接中…') : t('Offline', '离线')}</span>
      </span>
      <div className="oc-date">{fmtBusinessDate(h.businessDate, lang)}</div>
      <button className="oc-lang" onClick={() => setLang(lang === 'en' ? 'zh' : 'en')} title="Language / 语言">
        {lang === 'en' ? '中文' : 'EN'}
      </button>
      <div ref={ref} style={{ position: 'relative' }}>
        <button className="oc-prop" onClick={() => setOpen((o) => !o)} aria-haspopup="menu">
          <span className="oc-avatar">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
              <circle cx="8" cy="5" r="3.2" fill="#3c3c3c" />
              <path d="M2 15c.5-3.6 3-5.3 6-5.3s5.5 1.7 6 5.3z" fill="#3c3c3c" />
            </svg>
          </span>
          <span>
            <div className="p1">
              {h.hotelId} - {h.name}
            </div>
            <div className="p2">
              {ROLES[role].user} · {t(ROLES[role].en, ROLES[role].zh)}
            </div>
          </span>
        </button>
        {open && (
          <div className="role-menu" role="menu">
            <div className="menu-group">{t('Switch role (demo)', '切换演示角色')}</div>
            {(Object.keys(ROLES) as Role[]).map((r) => (
              <button
                key={r}
                className={cx(r === role && 'on')}
                onClick={() => {
                  setRole(r);
                  setOpen(false);
                  nav(ROLES[r].home);
                }}
              >
                {t(ROLES[r].en, ROLES[r].zh)} <span className="subtle">({ROLES[r].user})</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </header>
  );
}

function MegaMenu() {
  const t = useT();
  const loc = useLocation();
  const nav = useNavigate();
  const { backendKind } = useStore();
  const [open, setOpen] = useState<string | null>(null);
  const ref = useOutside<HTMLDivElement>(!!open, () => setOpen(null));
  useEffect(() => setOpen(null), [loc.pathname]);
  return (
    <nav className="oc-menubar" ref={ref}>
      <button className="oc-brand" onClick={() => nav('/')}>
        <CloudMark />
        <span>OPERA Cloud</span>
      </button>
      {NAV.map((m) => {
        const active = m.groups.some((g) => g.items.some((i) => loc.pathname.startsWith(i.path)));
        return (
          <div key={m.key} className={cx('oc-menu', open === m.key && 'open', active && 'active')}>
            <button onClick={() => setOpen(open === m.key ? null : m.key)} aria-expanded={open === m.key}>
              {t(m.en, m.zh)} <span style={{ fontSize: 9 }}>▼</span>
            </button>
            {open === m.key && (
              <div className="oc-mega">
                {m.groups.map((g) => (
                  <div key={g.en}>
                    <h4>{t(g.en, g.zh)}</h4>
                    {g.items.map((i) => (
                      <Link key={i.path} to={i.path}>
                        {i.en}
                        <span className="zh">{i.zh}</span>
                      </Link>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div className="right">
        <span className="oc-mode" title={t('Where the PMS engine runs', 'PMS 引擎运行位置')}>
          {backendKind === 'local' ? t('Backend: in-browser engine', '后端：浏览器内引擎') : t('Backend: Node server', '后端：Node 服务')}
        </span>
        <Link to="/guide" className="btn btn-sm btn-secondary" style={{ textDecoration: 'none' }}>
          ? {t('Guide', '指南')}
        </Link>
      </div>
    </nav>
  );
}

function SideNav({ onClose }: { onClose: () => void }) {
  const t = useT();
  const loc = useLocation();
  const ref = useOutside<HTMLDivElement>(true, onClose);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay">
      <div className="oc-side" ref={ref}>
        <Link to="/" className={cx(loc.pathname === '/' && 'on')} onClick={onClose}>
          {t('Home Dashboard', '首页仪表盘')}
        </Link>
        {NAV.map((m) => (
          <div key={m.key}>
            <h4>{t(m.en, m.zh)}</h4>
            {m.groups.flatMap((g) => g.items).map((i) => (
              <Link key={i.path} to={i.path} className={cx(loc.pathname === i.path && 'on')} onClick={onClose}>
                {t(i.en, i.zh)}
              </Link>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function Toasts() {
  const { toasts, dismissToast } = useStore();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((m) => (
        <div key={m.id} className={`toast toast-${m.kind}`}>
          <span>{m.kind === 'success' ? '✔' : m.kind === 'warning' ? '⚠' : m.kind === 'error' ? '✖' : 'ℹ'}</span>
          <span>{m.text}</span>
          <button className="x-btn" aria-label="Dismiss" onClick={() => dismissToast(m.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [side, setSide] = useState(false);
  const loc = useLocation();
  // the mobile attendant page renders its own phone-frame chrome
  const bare = loc.pathname === '/mobile' && new URLSearchParams(loc.search).has('bare');
  return (
    <div className="app">
      {!bare && <Header onBurger={() => setSide(true)} />}
      {!bare && <MegaMenu />}
      <main style={{ flex: 1 }}>{children}</main>
      {side && <SideNav onClose={() => setSide(false)} />}
      <Toasts />
    </div>
  );
}
