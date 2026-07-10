import { Link, useLocation, useNavigate, useRevalidator } from 'react-router-dom';
import { useDarkMode } from '@/lib/useDarkMode';
import { useAuth } from '@/lib/AuthContext';
import { useHealth } from '@/lib/HealthContext';
import { useWorkspace } from '@/lib/WorkspaceContext';

const NAV = [
  { href: '/', label: 'New test', icon: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M10 4.5v11M4.5 10h11" /></svg>
  ) },
  { href: '/chat', label: 'Chat', icon: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5.5h12v8H8.5L5 17v-3.5H4z" /></svg>
  ) },
  { href: '/results', label: 'Results', icon: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M4 6h12M4 10h12M4 14h8" /></svg>
  ) },
  { href: '/schedules', label: 'Schedules', icon: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><circle cx="10" cy="10" r="6.2" /><path d="M10 6.6V10l2.4 1.6" /></svg>
  ) },
  { href: '/presets', label: 'Presets', icon: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9"><rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1" /><rect x="11" y="3.5" width="5.5" height="5.5" rx="1" /><rect x="3.5" y="11" width="5.5" height="5.5" rx="1" /><rect x="11" y="11" width="5.5" height="5.5" rx="1" /></svg>
  ) },
  { href: '/library', label: 'Library', icon: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round"><rect x="4" y="3.5" width="9" height="13" rx="1" /><path d="M7 7h3M7 10h3" strokeLinecap="round" /><path d="M15 5.5l1.6.4-2 11-1.6-.4" /></svg>
  ) },
  { href: '/webhooks', label: 'Webhooks', icon: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M8 7.5a3 3 0 0 1 4.5 1M12 12.5a3 3 0 0 1-4.5-1M7 10.5l-1.5 2.5a2.5 2.5 0 1 1-2-3M13 9.5l1.5-2.5a2.5 2.5 0 1 1 2 3" /></svg>
  ) },
  { href: '/team', label: 'Team', icon: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9"><circle cx="7" cy="8" r="2.4" /><circle cx="13.5" cy="8.5" r="2" /><path d="M3 16c.4-2.2 2-3.2 4-3.2s3.6 1 4 3.2M12 13c1.8 0 3.4.9 3.8 3" strokeLinecap="round" /></svg>
  ) },
  { href: '/org', label: 'Org', icon: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round"><path d="M10 3l6 3.5v7L10 17l-6-3.5v-7z" /></svg>
  ) },
  { href: '/workspaces', label: 'Projects', icon: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="14" height="12" rx="1.5" /><path d="M3 8h14M7 5V3.5M13 5V3.5" /></svg>
  ) },
  { href: '/settings', label: 'Settings', icon: (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="10" cy="10" r="2.6" /><path d="M10 3.5v2M10 14.5v2M16.5 10h-2M5.5 10h-2M14.8 5.2l-1.4 1.4M6.6 13.4l-1.4 1.4M14.8 14.8l-1.4-1.4M6.6 6.6 5.2 5.2" /></svg>
  ) },
];

const ROLE_LABEL: Record<string, string> = { admin: 'Admin', member: 'Member', viewer: 'Viewer' };

const SunIcon = () => (
  <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="10" cy="10" r="3.4" /><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.6 4.6l1.4 1.4M14 14l1.5 1.5M15.4 4.6 14 6M6 14l-1.4 1.5" strokeLinecap="round" /></svg>
);
const MoonIcon = () => (
  <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M16 11.5A6.5 6.5 0 1 1 8.5 4a5 5 0 0 0 7.5 7.5Z" strokeLinejoin="round" /></svg>
);

interface SidebarProps {
  /** Mobile drawer open state. Ignored on desktop (always shown). */
  open: boolean;
  onNavigate: () => void;
}

export default function Sidebar({ open, onNavigate }: SidebarProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const { dark, toggle: toggleDark } = useDarkMode();
  const { user, logout, switchTeam } = useAuth();
  const { services, activeTests: active } = useHealth();
  const { workspaces, activeWorkspaceId, setActiveWorkspaceId } = useWorkspace();

  const workers = services.filter(s => s.metrics);
  const poolUsed = workers.reduce((sum, w) => sum + (w.metrics?.activeTests ?? 0), 0);
  const poolMax = workers.reduce((sum, w) => sum + (w.metrics?.maxTests ?? 0), 0);
  const poolPct = poolMax > 0 ? Math.round((poolUsed / poolMax) * 100) : 0;

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const currentTeam = user?.teams.find(t => t.id === user.currentTeamId);
  const initials = (user?.name || user?.email || '?').slice(0, 2).toUpperCase();

  return (
    <aside
      className={`flex-col flex-shrink-0 px-5 py-6.5 h-screen overflow-y-auto bg-sidebar-bg text-sidebar-bright
        md:flex md:w-[230px] md:sticky md:top-0
        ${open ? 'flex fixed top-0 left-0 z-50 w-[264px] shadow-[0_0_40px_rgba(0,0,0,.45)]' : 'hidden'}`}
    >
      <div className="font-display text-[16px] font-bold tracking-[-0.01em] text-white leading-none mb-0.5 whitespace-nowrap">
        ARTEM RYBALKIN<span className="text-accent">.</span>
      </div>
      <div className="font-mono text-[10.5px] tracking-[0.16em] text-sidebar-muted-2 uppercase mb-7.5">load testing</div>

      <nav className="flex flex-col gap-0.5">
        {NAV.filter(({ href }) => href !== '/org' || (user?.orgs?.length ?? 0) > 0).map(({ href, label, icon }) => {
          const active = href === '/results' ? (pathname === '/results' || pathname.startsWith('/results/')) : (href === '/' ? pathname === '/' : pathname.startsWith(href));
          return (
            <Link
              key={href}
              to={href}
              onClick={onNavigate}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-[11px] text-[14px] transition-colors duration-[120ms] ${
                active ? 'bg-accent text-white font-semibold' : 'text-sidebar-muted hover:text-white'
              }`}
            >
              {icon}{label}
            </Link>
          );
        })}
      </nav>

      {workspaces.length > 0 && (
        <div className="mt-4 pt-3.5 border-t border-sidebar-border">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-sidebar-muted-2 mb-1.5 px-1">Project</div>
          <select
            value={activeWorkspaceId ?? ''}
            onChange={e => {
              setActiveWorkspaceId(e.target.value || null);
              // Route loaders don't observe WorkspaceContext changes on their
              // own (they only re-run on navigation) — revalidate the current
              // route so pages already converted to the loader pattern
              // (Presets/Schedules/Webhooks/Results) pick up the new filter.
              revalidator.revalidate();
            }}
            className="w-full bg-sidebar-panel border border-sidebar-border text-[12.5px] text-sidebar-bright rounded-[9px] px-2.5 py-1.5 focus:outline-none cursor-pointer"
          >
            <option value="">All projects</option>
            {workspaces.map(w => <option key={w.id} value={w.id} className="text-black">{w.name}</option>)}
          </select>
        </div>
      )}

      <div className="flex-1" />

      <button
        onClick={toggleDark}
        className="flex items-center gap-2.5 px-3 py-2.5 rounded-[11px] cursor-pointer text-sidebar-muted hover:text-white mb-3 border border-sidebar-border transition-colors"
      >
        {dark ? <SunIcon /> : <MoonIcon />}
        <span className="text-[13px] font-medium">{dark ? 'Light mode' : 'Dark mode'}</span>
      </button>

      <div className="bg-sidebar-panel rounded-[14px] p-3.5">
        <div className="flex items-center gap-1.5 mb-2">
          <span className="w-1.5 h-1.5 rounded-full bg-live pulse-dot" />
          <span className="font-mono text-[10.5px] tracking-[0.1em] text-live">{active.length} LIVE RUN{active.length === 1 ? '' : 'S'}</span>
        </div>
        <div className="text-[12px] text-sidebar-muted leading-[1.5]">
          Worker pool at <span className="text-white font-semibold">{poolPct}%</span> capacity
        </div>
      </div>

      {user && (
        <div className="flex items-center gap-2.5 mt-4 pt-4 border-t border-sidebar-border">
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[12px] font-bold flex-shrink-0" style={{ background: 'linear-gradient(135deg,#ff5a2c,#ff8a5c)' }}>
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-semibold text-sidebar-bright-2 truncate" title={user.email}>{user.email}</div>
            {currentTeam && (
              <div className="flex items-center gap-1 mt-0.5 text-[11px] text-sidebar-muted-2">
                {user.teams.length > 1 ? (
                  <select
                    value={user.currentTeamId ?? ''}
                    onChange={e => switchTeam(e.target.value)}
                    className="bg-transparent border-none text-[11px] text-sidebar-muted-2 cursor-pointer focus:outline-none -ml-0.5"
                  >
                    {user.teams.map(t => <option key={t.id} value={t.id} className="text-black">{t.name}</option>)}
                  </select>
                ) : (
                  <span>{currentTeam.name}</span>
                )}
                <span className="uppercase tracking-wide">({ROLE_LABEL[currentTeam.role] ?? currentTeam.role})</span>
              </div>
            )}
            <button onClick={handleLogout} className="text-[11px] text-sidebar-muted-2 hover:text-white mt-0.5">Sign out</button>
          </div>
        </div>
      )}
    </aside>
  );
}
