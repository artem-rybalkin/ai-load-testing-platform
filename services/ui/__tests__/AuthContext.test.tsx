// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes, Navigate, Outlet } from 'react-router-dom';
import { AuthProvider, useAuth } from '../lib/AuthContext';

const mockGetMe  = vi.hoisted(() => vi.fn());
const mockLogout = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  getMe:   mockGetMe,
  logout:  mockLogout,
}));

// Inline AuthGate mirrors the one in App.tsx, avoids importing the whole app
function AuthGate() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <Outlet />;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

// ─── AuthProvider ─────────────────────────────────────────────────────────────

const UserDisplay = () => {
  const { user, loading } = useAuth();
  if (loading) return <span>loading</span>;
  if (!user)   return <span>no user</span>;
  return <span>user:{user.username}</span>;
};

describe('AuthProvider', () => {
  it('shows loading initially then the user once getMe resolves', async () => {
    mockGetMe.mockResolvedValue({ projectId: 'p1', username: 'alice', projectName: 'team' });
    render(<AuthProvider><MemoryRouter><UserDisplay /></MemoryRouter></AuthProvider>);
    expect(screen.getByText('loading')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('user:alice')).toBeInTheDocument());
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
          <span>{user ? `user:${user.username}` : 'no user'}</span>
          <button onClick={() => setUser({ projectId: 'p2', username: 'bob', projectName: 'team' })}>set</button>
        </div>
      );
    };
    render(<AuthProvider><MemoryRouter><Setter /></MemoryRouter></AuthProvider>);
    await waitFor(() => expect(screen.getByText('no user')).toBeInTheDocument());
    screen.getByRole('button', { name: 'set' }).click();
    await waitFor(() => expect(screen.getByText('user:bob')).toBeInTheDocument());
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
    mockGetMe.mockResolvedValue({ projectId: 'p1', username: 'carol', projectName: 'team' });
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
