// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { createRoutesStub } from 'react-router';
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

const mockUseHealth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/HealthContext', () => ({ useHealth: mockUseHealth }));

const baseUser: SessionUser = {
  id: 'u1', email: 'alice@example.com', name: 'Alice',
  teams: [{ id: 't1', name: 'team-alpha', role: 'admin' }],
  currentTeamId: 't1', role: 'admin', orgs: [],
};

// Sidebar calls useRevalidator() (to re-run loader-backed pages' data on
// workspace switch), which requires a data router — a plain MemoryRouter
// doesn't provide one, so render through a routes stub instead.
const renderSidebar = (open = true) => {
  const Stub = createRoutesStub([{ path: '/', Component: () => <Sidebar open={open} onNavigate={() => {}} /> }]);
  return render(<Stub initialEntries={['/']} />);
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLogout.mockResolvedValue(undefined);
  mockUseDarkMode.mockReturnValue({ dark: false, toggle: mockToggleDark });
  mockUseHealth.mockReturnValue({ services: [], activeTests: [] });
  mockUseAuth.mockReturnValue({ user: baseUser, logout: mockLogout, switchTeam: mockSwitchTeam });
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
    await waitFor(() => expect(mockLogout).toHaveBeenCalled());
    expect(mockNavigate).toHaveBeenCalledWith('/login');
  });

  it('toggles dark mode via the theme button', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: /dark mode/i }));
    expect(mockToggleDark).toHaveBeenCalled();
  });

  it('does not render the user/logout section when no user is present', () => {
    mockUseAuth.mockReturnValue({ user: null, logout: mockLogout, switchTeam: mockSwitchTeam });
    renderSidebar();
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
  });

  it('shows the live-run count from the shared HealthContext', () => {
    mockUseHealth.mockReturnValue({ services: [], activeTests: [{ test_id: 't1', type: 'backend', target_url: 'https://a.com' }] });
    renderSidebar();
    expect(screen.getByText('1 LIVE RUN')).toBeInTheDocument();
  });

  it('hides the drawer (mobile) when open is false', () => {
    const { container } = renderSidebar(false);
    expect(container.querySelector('aside')).toHaveClass('hidden');
  });
});
