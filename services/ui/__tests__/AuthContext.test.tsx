// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes, Navigate, Outlet } from 'react-router-dom';
import { AuthProvider, useAuth } from '../lib/AuthContext';
import type { SessionUser } from '../lib/api';

const mockGetMe       = vi.hoisted(() => vi.fn());
const mockLogout      = vi.hoisted(() => vi.fn());
const mockSwitchTeam  = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  getMe:      mockGetMe,
  logout:     mockLogout,
  switchTeam: mockSwitchTeam,
}));

// Inline AuthGate mirrors the one in App.tsx, avoids importing the whole app
function AuthGate() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <Outlet />;
}

const aliceUser: SessionUser = {
  id: 'u1',
  email: 'alice@example.com',
  name: 'Alice',
  teams: [{ id: 't1', name: 'team-alpha', role: 'admin' }],
  currentTeamId: 't1',
  role: 'admin',
  orgs: [],
};

const bobUser: SessionUser = {
  id: 'u2',
  email: 'bob@example.com',
  name: 'Bob',
  teams: [{ id: 't2', name: 'team-beta', role: 'member' }],
  currentTeamId: 't2',
  role: 'member',
  orgs: [],
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

// ─── AuthProvider ─────────────────────────────────────────────────────────────

const UserDisplay = () => {
  const { user, loading } = useAuth();
  if (loading) return <span>loading</span>;
  if (!user)   return <span>no user</span>;
  return <span>user:{user.email}</span>;
};

describe('AuthProvider', () => {
  it('shows loading initially then the user once getMe resolves', async () => {
    mockGetMe.mockResolvedValue(aliceUser);
    render(<AuthProvider><MemoryRouter><UserDisplay /></MemoryRouter></AuthProvider>);
    expect(screen.getByText('loading')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('user:alice@example.com')).toBeInTheDocument());
  });

  it('shows no user when getMe rejects (not logged in)', async () => {
    mockGetMe.mockRejectedValue(new Error('401'));
    render(<AuthProvider><MemoryRouter><UserDisplay /></MemoryRouter></AuthProvider>);
    await waitFor(() => expect(screen.getByText('no user')).toBeInTheDocument());
  });

  it('provides setUser so children can update the auth state', async () => {
    mockGetMe.mockRejectedValue(new Error('401'));
    const Setter = () => {
      const { user, setUser } = useAuth();
      return (
        <div>
          <span>{user ? `user:${user.email}` : 'no user'}</span>
          <button onClick={() => setUser(bobUser)}>set</button>
        </div>
      );
    };
    render(<AuthProvider><MemoryRouter><Setter /></MemoryRouter></AuthProvider>);
    await waitFor(() => expect(screen.getByText('no user')).toBeInTheDocument());
    screen.getByRole('button', { name: 'set' }).click();
    await waitFor(() => expect(screen.getByText('user:bob@example.com')).toBeInTheDocument());
  });

  it('switchTeam calls the API and updates the user state', async () => {
    mockGetMe.mockResolvedValue(aliceUser);
    const switched: SessionUser = { ...aliceUser, currentTeamId: 't2', teams: [...aliceUser.teams, { id: 't2', name: 'team-beta', role: 'viewer' }], role: 'viewer' };
    mockSwitchTeam.mockResolvedValue(switched);

    const Switcher = () => {
      const { user, switchTeam } = useAuth();
      return (
        <div>
          <span>current:{user?.currentTeamId}</span>
          <button onClick={() => switchTeam('t2')}>switch</button>
        </div>
      );
    };
    render(<AuthProvider><MemoryRouter><Switcher /></MemoryRouter></AuthProvider>);
    await waitFor(() => expect(screen.getByText('current:t1')).toBeInTheDocument());

    screen.getByRole('button', { name: 'switch' }).click();
    await waitFor(() => expect(screen.getByText('current:t2')).toBeInTheDocument());
    expect(mockSwitchTeam).toHaveBeenCalledWith('t2');
  });
});

// ─── AuthGate ─────────────────────────────────────────────────────────────────

describe('AuthGate', () => {
  it('redirects to /login when user is null', async () => {
    mockGetMe.mockRejectedValue(new Error('401'));
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/login" element={<span>login page</span>} />
            <Route element={<AuthGate />}>
              <Route path="/" element={<span>protected</span>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByText('login page')).toBeInTheDocument());
    expect(screen.queryByText('protected')).not.toBeInTheDocument();
  });

  it('renders protected content when user is authenticated', async () => {
    mockGetMe.mockResolvedValue(aliceUser);
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/login" element={<span>login page</span>} />
            <Route element={<AuthGate />}>
              <Route path="/" element={<span>protected</span>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByText('protected')).toBeInTheDocument());
    expect(screen.queryByText('login page')).not.toBeInTheDocument();
  });
});
