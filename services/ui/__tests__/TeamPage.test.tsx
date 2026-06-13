// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import TeamPage from '../app/team/page';
import type { SessionUser, TeamMemberRow, TeamQuota, TeamUsage, TeamApiKeyRow, TeamApiKeyCreated } from '../lib/api';

const mockGetTeamMembers      = vi.hoisted(() => vi.fn());
const mockAddTeamMember       = vi.hoisted(() => vi.fn());
const mockUpdateTeamMemberRole = vi.hoisted(() => vi.fn());
const mockRemoveTeamMember    = vi.hoisted(() => vi.fn());
const mockGetTeamQuota        = vi.hoisted(() => vi.fn());
const mockUpdateTeamQuota      = vi.hoisted(() => vi.fn());
const mockGetTeamApiKeys       = vi.hoisted(() => vi.fn());
const mockCreateTeamApiKey     = vi.hoisted(() => vi.fn());
const mockRevokeTeamApiKey     = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  getTeamMembers: mockGetTeamMembers,
  addTeamMember: mockAddTeamMember,
  updateTeamMemberRole: mockUpdateTeamMemberRole,
  removeTeamMember: mockRemoveTeamMember,
  getTeamQuota: mockGetTeamQuota,
  updateTeamQuota: mockUpdateTeamQuota,
  getTeamApiKeys: mockGetTeamApiKeys,
  createTeamApiKey: mockCreateTeamApiKey,
  revokeTeamApiKey: mockRevokeTeamApiKey,
}));

const mockUseAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/AuthContext', () => ({ useAuth: mockUseAuth }));

const adminUser: SessionUser = {
  id: 'u1', email: 'admin@example.com', name: 'Admin',
  teams: [{ id: 't1', name: 'team-alpha', role: 'admin' }],
  currentTeamId: 't1', role: 'admin', orgs: [],
};

const memberUser: SessionUser = {
  id: 'u2', email: 'member@example.com', name: 'Member',
  teams: [{ id: 't1', name: 'team-alpha', role: 'member' }],
  currentTeamId: 't1', role: 'member', orgs: [],
};

const members: TeamMemberRow[] = [
  { userId: 'u1', email: 'admin@example.com', name: 'Admin', role: 'admin' },
  { userId: 'u2', email: 'member@example.com', name: 'Member', role: 'member' },
];

const defaultQuota: TeamQuota = {
  maxConcurrentTests: 5,
  maxVusPerTest: 1000,
  maxTestDurationSeconds: 3600,
  maxScheduledTests: 10,
  maxGeminiCallsPerDay: 100,
};

const defaultUsage: TeamUsage = {
  concurrentTests: 1,
  scheduledTests: 2,
  geminiCallsToday: 50,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetTeamMembers.mockResolvedValue(members);
  mockGetTeamQuota.mockResolvedValue({ quota: defaultQuota, usage: defaultUsage });
  mockGetTeamApiKeys.mockResolvedValue([]);
});
afterEach(() => cleanup());

describe('TeamPage — dev mode (no team)', () => {
  it('shows a not-available message when currentTeamId is "dev"', () => {
    mockUseAuth.mockReturnValue({ user: { ...adminUser, currentTeamId: 'dev', teams: [{ id: 'dev', name: 'dev', role: 'admin' }] } });
    render(<TeamPage />);
    expect(screen.getByText(/not available/i)).toBeInTheDocument();
  });
});

describe('TeamPage — admin', () => {
  beforeEach(() => mockUseAuth.mockReturnValue({ user: adminUser }));

  it('renders the team name and member list', async () => {
    render(<TeamPage />);
    expect(screen.getByText(/team-alpha/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('admin@example.com')).toBeInTheDocument());
    expect(screen.getByText('member@example.com')).toBeInTheDocument();
  });

  it('shows the Add Member form', async () => {
    render(<TeamPage />);
    await waitFor(() => expect(mockGetTeamMembers).toHaveBeenCalledWith('t1'));
    expect(screen.getByPlaceholderText('teammate@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^add$/i })).toBeInTheDocument();
  });

  it('calls addTeamMember and reloads the list on submit', async () => {
    mockAddTeamMember.mockResolvedValue({ success: true });
    render(<TeamPage />);
    await waitFor(() => expect(screen.getByText('admin@example.com')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('teammate@example.com'), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => expect(mockAddTeamMember).toHaveBeenCalledWith('t1', 'new@example.com', 'member'));
    expect(mockGetTeamMembers).toHaveBeenCalledTimes(2);
  });

  it('shows an error message when addTeamMember rejects', async () => {
    mockAddTeamMember.mockRejectedValue(new Error('No user with that email'));
    render(<TeamPage />);
    await waitFor(() => expect(screen.getByText('admin@example.com')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('teammate@example.com'), { target: { value: 'ghost@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => expect(screen.getByText(/no user with that email/i)).toBeInTheDocument());
  });

  it('allows changing a member role and removing a member', async () => {
    mockUpdateTeamMemberRole.mockResolvedValue({ success: true });
    mockRemoveTeamMember.mockResolvedValue({ success: true });
    render(<TeamPage />);
    await waitFor(() => expect(screen.getByText('member@example.com')).toBeInTheDocument());

    const selects = screen.getAllByRole('combobox');
    // selects[0] = "add member" role select, selects[1] = admin row, selects[2] = member row
    fireEvent.change(selects[2], { target: { value: 'viewer' } });
    await waitFor(() => expect(mockUpdateTeamMemberRole).toHaveBeenCalledWith('t1', 'u2', 'viewer'));

    const removeButtons = screen.getAllByRole('button', { name: /remove/i });
    fireEvent.click(removeButtons[1]);
    await waitFor(() => expect(mockRemoveTeamMember).toHaveBeenCalledWith('t1', 'u2'));
  });
});

describe('TeamPage — non-admin (member)', () => {
  beforeEach(() => mockUseAuth.mockReturnValue({ user: memberUser }));

  it('does not show the Add Member form', async () => {
    render(<TeamPage />);
    await waitFor(() => expect(screen.getByText('admin@example.com')).toBeInTheDocument());
    expect(screen.queryByPlaceholderText('teammate@example.com')).not.toBeInTheDocument();
  });

  it('shows read-only role labels instead of selects', async () => {
    render(<TeamPage />);
    await waitFor(() => expect(screen.getByText('admin@example.com')).toBeInTheDocument());
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.getByText('admin')).toBeInTheDocument();
    expect(screen.getByText('member')).toBeInTheDocument();
  });
});

describe('TeamPage — Usage & Limits', () => {
  it('admin sees editable limits and usage values, and can save', async () => {
    mockUseAuth.mockReturnValue({ user: adminUser });
    mockUpdateTeamQuota.mockResolvedValue({ quota: { ...defaultQuota, maxConcurrentTests: 8 } });

    render(<TeamPage />);
    await waitFor(() => expect(mockGetTeamQuota).toHaveBeenCalledWith('t1'));

    expect(await screen.findByText('Usage & Limits')).toBeInTheDocument();

    const concurrentInput = await screen.findByDisplayValue('5');
    expect(concurrentInput).toBeInTheDocument();

    fireEvent.change(concurrentInput, { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: /save limits/i }));

    await waitFor(() => expect(mockUpdateTeamQuota).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ maxConcurrentTests: 8 })
    ));
  });

  it('shows an error if loading quota fails', async () => {
    mockUseAuth.mockReturnValue({ user: adminUser });
    mockGetTeamQuota.mockRejectedValue(new Error('boom'));

    render(<TeamPage />);
    await waitFor(() => expect(screen.getByText(/failed to load usage/i)).toBeInTheDocument());
  });

  it('non-admin member sees read-only usage / limit values', async () => {
    mockUseAuth.mockReturnValue({ user: memberUser });

    render(<TeamPage />);
    await waitFor(() => expect(mockGetTeamQuota).toHaveBeenCalledWith('t1'));

    expect(await screen.findByText('Usage & Limits')).toBeInTheDocument();
    // concurrentTests usage=1, limit=5
    expect(await screen.findByText('1 / 5')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save limits/i })).not.toBeInTheDocument();
  });
});

describe('TeamPage — API Keys', () => {
  const existingKeys: TeamApiKeyRow[] = [
    { id: 'k1', name: 'CI key', createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: '2026-01-02T00:00:00.000Z', revoked: false },
    { id: 'k2', name: 'Old key', createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: null, revoked: true },
  ];

  beforeEach(() => mockUseAuth.mockReturnValue({ user: adminUser }));

  it('admin sees the API Keys section with existing keys', async () => {
    mockGetTeamApiKeys.mockResolvedValue(existingKeys);
    render(<TeamPage />);

    expect(await screen.findByText('API Keys')).toBeInTheDocument();
    expect(await screen.findByText(/CI key/)).toBeInTheDocument();
    expect(screen.getByText(/Old key/)).toBeInTheDocument();
    expect(screen.getByText('Revoked')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/key name/i)).toBeInTheDocument();
  });

  it('shows "No API keys" when the team has none', async () => {
    mockGetTeamApiKeys.mockResolvedValue([]);
    render(<TeamPage />);
    expect(await screen.findByText('No API keys')).toBeInTheDocument();
  });

  it('generates a new key, shows the raw key banner, and reloads the list', async () => {
    mockGetTeamApiKeys.mockResolvedValue([]);
    const created: TeamApiKeyCreated = { id: 'k3', name: 'CI pipeline', key: 'rawkey-abc123', createdAt: '2026-01-05T00:00:00.000Z' };
    mockCreateTeamApiKey.mockResolvedValue(created);

    render(<TeamPage />);
    await waitFor(() => expect(mockGetTeamApiKeys).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByPlaceholderText(/key name/i), { target: { value: 'CI pipeline' } });
    fireEvent.click(screen.getByRole('button', { name: /generate key/i }));

    await waitFor(() => expect(mockCreateTeamApiKey).toHaveBeenCalledWith('t1', 'CI pipeline'));
    expect(await screen.findByText('rawkey-abc123')).toBeInTheDocument();
    expect(screen.getByText(/won't be shown again/i)).toBeInTheDocument();
    await waitFor(() => expect(mockGetTeamApiKeys).toHaveBeenCalledTimes(2));
  });

  it('shows an error when generating a key fails without a name', async () => {
    mockGetTeamApiKeys.mockResolvedValue([]);
    render(<TeamPage />);
    await waitFor(() => expect(mockGetTeamApiKeys).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /generate key/i }));
    expect(await screen.findByText(/name is required/i)).toBeInTheDocument();
    expect(mockCreateTeamApiKey).not.toHaveBeenCalled();
  });

  it('revokes a key and reloads the list', async () => {
    mockGetTeamApiKeys.mockResolvedValue(existingKeys);
    mockRevokeTeamApiKey.mockResolvedValue({ success: true });

    render(<TeamPage />);
    await waitFor(() => expect(screen.getByText(/CI key/)).toBeInTheDocument());

    const revokeButtons = screen.getAllByRole('button', { name: /revoke/i });
    fireEvent.click(revokeButtons[0]);

    await waitFor(() => expect(mockRevokeTeamApiKey).toHaveBeenCalledWith('t1', 'k1'));
    await waitFor(() => expect(mockGetTeamApiKeys).toHaveBeenCalledTimes(2));
  });
});
