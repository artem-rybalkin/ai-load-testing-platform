// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import OrgPage from '../app/org/page';
import type { SessionUser, OrgDetail } from '../lib/api';

const mockGetOrg              = vi.hoisted(() => vi.fn());
const mockAddOrgMember        = vi.hoisted(() => vi.fn());
const mockUpdateOrgMemberRole = vi.hoisted(() => vi.fn());
const mockRemoveOrgMember     = vi.hoisted(() => vi.fn());
const mockCreateOrgTeam       = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  getOrg: mockGetOrg,
  addOrgMember: mockAddOrgMember,
  updateOrgMemberRole: mockUpdateOrgMemberRole,
  removeOrgMember: mockRemoveOrgMember,
  createOrgTeam: mockCreateOrgTeam,
}));

const mockUseAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/AuthContext', () => ({ useAuth: mockUseAuth }));

const ownerUser: SessionUser = {
  id: 'u1', email: 'owner@example.com', name: 'Owner',
  teams: [{ id: 't1', name: 'team-alpha', role: 'admin' }],
  currentTeamId: 't1', role: 'admin',
  orgs: [{ id: 'org1', name: 'Acme Org', role: 'owner' }],
};

const memberUser: SessionUser = {
  id: 'u2', email: 'member@example.com', name: 'Member',
  teams: [{ id: 't1', name: 'team-alpha', role: 'member' }],
  currentTeamId: 't1', role: 'member',
  orgs: [{ id: 'org1', name: 'Acme Org', role: 'member' }],
};

const noOrgUser: SessionUser = {
  id: 'u3', email: 'solo@example.com', name: 'Solo',
  teams: [{ id: 't1', name: 'team-alpha', role: 'admin' }],
  currentTeamId: 't1', role: 'admin', orgs: [],
};

const ownerDetail: OrgDetail = {
  org: { id: 'org1', name: 'Acme Org', createdAt: '2026-01-01T00:00:00.000Z' },
  members: [
    { userId: 'u1', email: 'owner@example.com', name: 'Owner', role: 'owner' },
    { userId: 'u2', email: 'member@example.com', name: 'Member', role: 'member' },
  ],
  teams: [
    {
      id: 't1', name: 'team-alpha',
      quota: { maxConcurrentTests: 5, maxVusPerTest: 1000, maxTestDurationSeconds: 3600, maxScheduledTests: 10, maxGeminiCallsPerDay: 100 },
      usage: { concurrentTests: 1, scheduledTests: 2, geminiCallsToday: 3 },
    },
  ],
  role: 'owner',
};

const memberDetail: OrgDetail = { ...ownerDetail, role: 'member' };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetOrg.mockResolvedValue(ownerDetail);
});
afterEach(() => cleanup());

describe('OrgPage — no organization', () => {
  it('shows a not-a-member message when user has no orgs', () => {
    mockUseAuth.mockReturnValue({ user: noOrgUser });
    render(<OrgPage />);
    expect(screen.getByText('Organization')).toBeInTheDocument();
    expect(screen.getByText(/not a member of any organization/i)).toBeInTheDocument();
    expect(mockGetOrg).not.toHaveBeenCalled();
  });
});

describe('OrgPage — owner/admin', () => {
  beforeEach(() => mockUseAuth.mockReturnValue({ user: ownerUser }));

  it('loads org details and renders org name and members', async () => {
    render(<OrgPage />);
    await waitFor(() => expect(mockGetOrg).toHaveBeenCalledWith('org1'));
    expect(await screen.findByText(/Acme Org/)).toBeInTheDocument();
    expect(screen.getByText('owner@example.com')).toBeInTheDocument();
    expect(screen.getByText('member@example.com')).toBeInTheDocument();
  });

  it('shows the Add Member form and calls addOrgMember on submit', async () => {
    mockAddOrgMember.mockResolvedValue({ success: true });
    render(<OrgPage />);
    await waitFor(() => expect(screen.getByText('owner@example.com')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('teammate@example.com'), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => expect(mockAddOrgMember).toHaveBeenCalledWith('org1', 'new@example.com', 'member'));
    expect(mockGetOrg).toHaveBeenCalledTimes(2);
  });

  it('shows an error message when addOrgMember rejects', async () => {
    mockAddOrgMember.mockRejectedValue(new Error('No user with that email'));
    render(<OrgPage />);
    await waitFor(() => expect(screen.getByText('owner@example.com')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('teammate@example.com'), { target: { value: 'ghost@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => expect(screen.getByText(/no user with that email/i)).toBeInTheDocument());
  });

  it('allows changing a member role and removing a member', async () => {
    mockUpdateOrgMemberRole.mockResolvedValue({ success: true });
    mockRemoveOrgMember.mockResolvedValue({ success: true });
    render(<OrgPage />);
    await waitFor(() => expect(screen.getByText('member@example.com')).toBeInTheDocument());

    const selects = screen.getAllByRole('combobox');
    // selects[0] = "add member" role select, selects[1] = owner row, selects[2] = member row
    fireEvent.change(selects[2], { target: { value: 'admin' } });
    await waitFor(() => expect(mockUpdateOrgMemberRole).toHaveBeenCalledWith('org1', 'u2', 'admin'));

    const removeButtons = screen.getAllByRole('button', { name: /remove/i });
    fireEvent.click(removeButtons[1]);
    await waitFor(() => expect(mockRemoveOrgMember).toHaveBeenCalledWith('org1', 'u2'));
  });

  it('lists teams with quota/usage summary and allows creating a new team', async () => {
    mockCreateOrgTeam.mockResolvedValue({ id: 't2', name: 'team-beta', role: 'admin' });
    render(<OrgPage />);
    await waitFor(() => expect(screen.getByText('Teams')).toBeInTheDocument());

    expect(screen.getByText('team-alpha')).toBeInTheDocument();
    expect(screen.getByText(/1\/5 running/)).toBeInTheDocument();
    expect(screen.getByText(/2\/10 schedules/)).toBeInTheDocument();
    expect(screen.getByText(/3\/100 AI calls today/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('New team name'), { target: { value: 'team-beta' } });
    fireEvent.click(screen.getByRole('button', { name: /new team/i }));

    await waitFor(() => expect(mockCreateOrgTeam).toHaveBeenCalledWith('org1', 'team-beta'));
    expect(mockGetOrg).toHaveBeenCalledTimes(2);
  });
});

describe('OrgPage — non-admin member', () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({ user: memberUser });
    mockGetOrg.mockResolvedValue(memberDetail);
  });

  it('does not show the Add Member form', async () => {
    render(<OrgPage />);
    await waitFor(() => expect(screen.getByText('owner@example.com')).toBeInTheDocument());
    expect(screen.queryByPlaceholderText('teammate@example.com')).not.toBeInTheDocument();
  });

  it('shows read-only role labels instead of selects', async () => {
    render(<OrgPage />);
    await waitFor(() => expect(screen.getByText('owner@example.com')).toBeInTheDocument());
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.getByText('owner')).toBeInTheDocument();
    expect(screen.getByText('member')).toBeInTheDocument();
  });

  it('does not show the new team form', async () => {
    render(<OrgPage />);
    await waitFor(() => expect(screen.getByText('Teams')).toBeInTheDocument());
    expect(screen.queryByPlaceholderText('New team name')).not.toBeInTheDocument();
  });
});
