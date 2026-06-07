// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import LoginPage from '../app/login/page';

const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetUser  = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({ setUser: mockSetUser }),
}));

const mockLogin = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ login: mockLogin }));

beforeEach(() => {
  vi.clearAllMocks();
  mockLogin.mockResolvedValue({ projectId: 'p1', username: 'alice', projectName: 'proj' });
});
afterEach(() => cleanup());

describe('LoginPage', () => {
  it('renders username and project inputs', () => {
    render(<LoginPage />);
    expect(screen.getByPlaceholderText('your name')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('my-project')).toBeInTheDocument();
  });

  it('renders Sign in button', () => {
    render(<LoginPage />);
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('calls login() with trimmed username and projectName on submit', async () => {
    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText('your name'),    { target: { value: '  alice  ' } });
    fireEvent.change(screen.getByPlaceholderText('my-project'),   { target: { value: '  my-team  ' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(mockLogin).toHaveBeenCalledWith('alice', 'my-team'));
  });

  it('calls setUser and navigates to / on success', async () => {
    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText('your name'),  { target: { value: 'alice' } });
    fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'proj' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(mockSetUser).toHaveBeenCalledWith({ projectId: 'p1', username: 'alice', projectName: 'proj' }));
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('shows error message when login() rejects', async () => {
    mockLogin.mockRejectedValueOnce(new Error('network error'));
    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText('your name'),  { target: { value: 'alice' } });
    fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'proj' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(screen.getByText(/login failed/i)).toBeInTheDocument());
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('disables the button while signing in', async () => {
    let resolve!: (v: unknown) => void;
    mockLogin.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText('your name'),  { target: { value: 'alice' } });
    fireEvent.change(screen.getByPlaceholderText('my-project'), { target: { value: 'proj' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled());
    resolve({ projectId: 'p1', username: 'alice', projectName: 'proj' });
  });
});
