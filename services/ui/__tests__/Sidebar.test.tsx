// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Sidebar from '../app/components/Sidebar';
import type { SessionUser } from '../lib/api';

const mockNavigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockLogout     = vi.hoisted(() => vi.fn());
const mockSwitchTeam = vi.hoisted(() => vi.fn());
const mockUseAuth    = vi.hoisted(() => vi.fn());
vi.mock('@/lib/AuthContext', () => ({ useAuth: mockUseAuth }));

const mockToggleDark   = vi.hoisted(() => vi.fn());
const mockUseDarkMode  = vi.hoisted(() => vi.fn());
vi.mock('@/lib/useDarkMode', () => ({ useDarkMode: mockUseDarkMode }));

// Defaults to desktop (lg+) width so existing tests exercise the expand/collapse-by-choice
// behavior; tablet-width (md-only) tests below override this to simulate < lg.
const mockUseMediaQuery = vi.hoisted(() => vi.fn());
vi.mock('@/lib/useMediaQuery', () => ({ useMediaQuery: mockUseMediaQuery }));

const baseUser: SessionUser = {
  id: 'u1', email: 'alice@example.com', name: 'Alice',
  teams: [{ id: 't1', name: 'team-alpha', role: 'admin' }],
  currentTeamId: 't1', role: 'admin', orgs: [],
};

const renderSidebar = () => render(<MemoryRouter><Sidebar /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  mockLogout.mockResolvedValue(undefined);
  mockUseDarkMode.mockReturnValue({ dark: false, toggle: mockToggleDark });
  mockUseMediaQuery.mockReturnValue(true);
  mockUseAuth.mockReturnValue({ user: baseUser, logout: mockLogout, switchTeam: mockSwitchTeam });
  try { localStorage.clear(); } catch {}
});
afterEach(() => cleanup());

describe('Sidebar', () => {
  it('renders the core nav items but not Org when the user has no orgs', () => {
    renderSidebar();
    expect(screen.getByRole('link', { name: /new test/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /results/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /schedules/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /presets/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /webhooks/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /team/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /org/i })).not.toBeInTheDocument();
  });

  it('renders the Org nav item when the user belongs to an org', () => {
    mockUseAuth.mockReturnValue({
      user: { ...baseUser, orgs: [{ id: 'o1', name: 'org-1', role: 'owner' }] },
      logout: mockLogout,
      switchTeam: mockSwitchTeam,
    });
    renderSidebar();
    expect(screen.getByRole('link', { name: /org/i })).toBeInTheDocument();
  });

  it('shows the user email and current team/role', () => {
    renderSidebar();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('team-alpha')).toBeInTheDocument();
    expect(screen.getByText('(Admin)')).toBeInTheDocument();
  });

  it('renders a team switcher when the user belongs to multiple teams and calls switchTeam on change', () => {
    mockUseAuth.mockReturnValue({
      user: {
        ...baseUser,
        teams: [{ id: 't1', name: 'team-alpha', role: 'admin' }, { id: 't2', name: 'team-beta', role: 'member' }],
      },
      logout: mockLogout,
      switchTeam: mockSwitchTeam,
    });
    renderSidebar();
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 't2' } });
    expect(mockSwitchTeam).toHaveBeenCalledWith('t2');
  });

  it('does not render a team switcher for a single-team user', () => {
    renderSidebar();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('signing out calls logout() and navigates to /login', async () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    await vi.waitFor(() => expect(mockLogout).toHaveBeenCalled());
    expect(mockNavigate).toHaveBeenCalledWith('/login');
  });

  it('toggles dark mode via the theme button', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: /dark mode/i }));
    expect(mockToggleDark).toHaveBeenCalled();
  });

  it('collapses and expands the sidebar, persisting to localStorage', () => {
    renderSidebar();
    const collapseBtn = screen.getByTitle('Collapse sidebar');
    fireEvent.click(collapseBtn);
    expect(localStorage.getItem('sidebar-open')).toBe('false');
    expect(screen.getByTitle('Expand sidebar')).toBeInTheDocument();
  });

  it('does not render the user/logout section when no user is present', () => {
    mockUseAuth.mockReturnValue({ user: null, logout: mockLogout, switchTeam: mockSwitchTeam });
    renderSidebar();
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
  });
});

describe('Sidebar — tablet width (md: but below lg:)', () => {
  it('forces the collapsed icon-rail and hides the expand/collapse toggle', () => {
    mockUseMediaQuery.mockReturnValue(false);
    renderSidebar();
    expect(screen.queryByTitle('Collapse sidebar')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Expand sidebar')).not.toBeInTheDocument();
    expect(screen.queryByText('alice@example.com')).not.toBeInTheDocument();
    // Nav links remain reachable (accessible name still includes the sr-only label)
    expect(screen.getByRole('link', { name: /new test/i })).toBeInTheDocument();
  });

  it('ignores a stored lg+ "open" preference when below lg', () => {
    localStorage.setItem('sidebar-open', 'true');
    mockUseMediaQuery.mockReturnValue(false);
    renderSidebar();
    expect(screen.queryByText('alice@example.com')).not.toBeInTheDocument();
  });
});
