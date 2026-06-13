// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import LoginPage from '../app/login/page';
import type { SessionUser } from '../lib/api';

const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetUser  = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({ setUser: mockSetUser }),
}));

const mockLogin    = vi.hoisted(() => vi.fn());
const mockRegister = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ login: mockLogin, register: mockRegister }));

const sessionUser: SessionUser = {
  id: 'u1',
  email: 'alice@example.com',
  name: 'Alice',
  teams: [{ id: 't1', name: 'team-alpha', role: 'admin' }],
  currentTeamId: 't1',
  role: 'admin',
  orgs: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLogin.mockResolvedValue(sessionUser);
  mockRegister.mockResolvedValue(sessionUser);
});
afterEach(() => cleanup());

describe('LoginPage — sign in mode', () => {
  it('renders email and password inputs and a Sign in button', () => {
    render(<LoginPage />);
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('••••••••')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('does not show register-only fields by default', () => {
    render(<LoginPage />);
    expect(screen.queryByPlaceholderText('your name')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('my-team')).not.toBeInTheDocument();
  });

  it('calls login() with trimmed email and password on submit', async () => {
    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: '  alice@example.com  ' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(mockLogin).toHaveBeenCalledWith('alice@example.com', 'password123'));
  });

  it('calls setUser and navigates to / on success', async () => {
    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'alice@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(mockSetUser).toHaveBeenCalledWith(sessionUser));
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('shows an error message when login() rejects', async () => {
    mockLogin.mockRejectedValueOnce(new Error('Invalid email or password'));
    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'alice@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(screen.getByText(/invalid email or password/i)).toBeInTheDocument());
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('disables the button while signing in', async () => {
    let resolve!: (v: unknown) => void;
    mockLogin.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    render(<LoginPage />);
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'alice@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled());
    resolve(sessionUser);
  });
});

describe('LoginPage — register mode', () => {
  const switchToRegister = () => {
    fireEvent.click(screen.getByRole('button', { name: /don't have an account/i }));
  };

  it('shows name and team name fields after switching to register', () => {
    render(<LoginPage />);
    switchToRegister();
    expect(screen.getByPlaceholderText('your name')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('my-team')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
  });

  it('calls register() with email, password, teamName, and name on submit', async () => {
    render(<LoginPage />);
    switchToRegister();
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'alice@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    fireEvent.change(screen.getByPlaceholderText('your name'), { target: { value: 'Alice' } });
    fireEvent.change(screen.getByPlaceholderText('my-team'), { target: { value: 'team-alpha' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    await waitFor(() => expect(mockRegister).toHaveBeenCalledWith('alice@example.com', 'password123', 'team-alpha', 'Alice'));
  });

  it('calls setUser and navigates to / on successful registration', async () => {
    render(<LoginPage />);
    switchToRegister();
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'alice@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    fireEvent.change(screen.getByPlaceholderText('my-team'), { target: { value: 'team-alpha' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    await waitFor(() => expect(mockSetUser).toHaveBeenCalledWith(sessionUser));
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('shows an error message when register() rejects', async () => {
    mockRegister.mockRejectedValueOnce(new Error('Email already registered'));
    render(<LoginPage />);
    switchToRegister();
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'alice@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } });
    fireEvent.change(screen.getByPlaceholderText('my-team'), { target: { value: 'team-alpha' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    await waitFor(() => expect(screen.getByText(/email already registered/i)).toBeInTheDocument());
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('toggles back to sign in mode', () => {
    render(<LoginPage />);
    switchToRegister();
    fireEvent.click(screen.getByRole('button', { name: /already have an account/i }));
    expect(screen.getByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('my-team')).not.toBeInTheDocument();
  });
});
