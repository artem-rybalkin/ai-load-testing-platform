import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useDarkMode } from '@/lib/useDarkMode';
import { useAuth } from '@/lib/AuthContext';

const NAV = [
  { href: '/',          icon: '⊕', label: 'New Test'  },
  { href: '/results',   icon: '≡', label: 'Results'   },
  { href: '/schedules', icon: '⏱', label: 'Schedules' },
  { href: '/presets', icon: '◫', label: 'Presets' },
  { href: '/webhooks',  icon: '◻', label: 'Webhooks'  },
];

export default function Sidebar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(true);
  const { dark, toggle: toggleDark } = useDarkMode();
  const { user, logout } = useAuth();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  useEffect(() => {
    try {
      const stored = localStorage.getItem('sidebar-open');
      if (stored !== null) setOpen(stored === 'true');
    } catch {}
  }, []);

  const toggle = () => {
    setOpen(v => {
      const next = !v;
      try { localStorage.setItem('sidebar-open', String(next)); } catch {}
      return next;
    });
  };

  return (
    <aside
      className="hidden lg:flex flex-col flex-shrink-0 border-r border-[#d0d7de] dark:border-[#30363d] sticky top-0 h-screen overflow-y-auto transition-[width] duration-150 ease-in-out"
      style={{ width: open ? 220 : 48, background: 'var(--surface)', color: 'var(--text-primary)' }}
    >
      {/* Logo + toggle */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-[#d0d7de] min-h-[48px]">
        {open && (
          <span className="text-[13px] font-semibold text-[#24292f] whitespace-nowrap overflow-hidden">
            ⚡ AI Load Testing
          </span>
        )}
        <button
          onClick={toggle}
          title={open ? 'Collapse sidebar' : 'Expand sidebar'}
          className="w-6 h-6 flex items-center justify-center rounded border border-[#d0d7de] bg-[#f6f8fa] hover:bg-[#eaeef2] text-[#57606a] text-[10px] flex-shrink-0 transition-colors ml-auto"
        >
          {open ? '◀' : '▶'}
        </button>
      </div>

      {/* Dark mode toggle */}
      <div className={`flex items-center border-b border-[#d0d7de] min-h-[40px] ${open ? 'px-3' : 'justify-center'}`}>
        <button
          onClick={toggleDark}
          title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
          className="flex items-center gap-2 text-[12px] text-[#57606a] hover:text-[#24292f] transition-colors py-2"
        >
          <span className="text-[14px]">{dark ? '☀' : '🌙'}</span>
          {open && <span>{dark ? 'Light mode' : 'Dark mode'}</span>}
        </button>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-0.5 p-2 flex-1">
        {NAV.map(({ href, icon, label }) => {
          const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
          return (
            <Link
              key={href}
              to={href}
              title={!open ? label : undefined}
              className={`flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[13px] transition-colors group relative ${
                active
                  ? 'bg-[#ddf4ff] text-[#0969da] font-medium'
                  : 'text-[#57606a] hover:bg-[#f6f8fa] hover:text-[#24292f]'
              }`}
            >
              <span className="text-[15px] w-5 text-center flex-shrink-0">{icon}</span>
              {open ? (
                <span className="truncate">{label}</span>
              ) : (
                <span className="sr-only">{label}</span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* User + Logout */}
      {user && (
        <div className={`border-t border-[#d0d7de] p-2 ${open ? '' : 'flex justify-center'}`}>
          {open && (
            <div className="px-2.5 py-1 text-[11px] text-[#57606a] truncate" title={`${user.username} / ${user.projectName}`}>
              <span className="font-medium text-[#24292f]">{user.username}</span>
              <span className="text-[#8c959f]"> / {user.projectName}</span>
            </div>
          )}
          <button
            onClick={handleLogout}
            title={open ? undefined : 'Sign out'}
            className={`flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[13px] text-[#57606a] hover:bg-[#f6f8fa] hover:text-[#cf222e] transition-colors w-full ${open ? '' : 'justify-center'}`}
          >
            <span className="text-[15px] w-5 text-center flex-shrink-0">⏻</span>
            {open ? <span className="truncate">Sign out</span> : <span className="sr-only">Sign out</span>}
          </button>
        </div>
      )}
    </aside>
  );
}
