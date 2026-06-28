// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup, waitFor } from '@testing-library/react';
import { useWorkspace, WorkspaceProvider } from '../lib/WorkspaceContext';
import type { Workspace } from '../lib/api';

const mockGetWorkspaces = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  getWorkspaces: mockGetWorkspaces,
}));

let mockCurrentTeamId: string | null = 'team-1';

vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({
    user: mockCurrentTeamId ? { currentTeamId: mockCurrentTeamId } : null,
    loading: false,
  }),
}));

const makeWorkspace = (id: string, name: string): Workspace => ({
  id, teamId: 'team-1', name, description: null, createdAt: '2024-01-01T00:00:00.000Z',
});

function Consumer() {
  const { workspaces, activeWorkspaceId, setActiveWorkspaceId } = useWorkspace();
  return (
    <div>
      <span data-testid="count">{workspaces.length}</span>
      <span data-testid="active">{activeWorkspaceId ?? 'none'}</span>
      <button onClick={() => setActiveWorkspaceId('ws-1')}>select ws-1</button>
      <button onClick={() => setActiveWorkspaceId(null)}>clear</button>
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCurrentTeamId = 'team-1';
  localStorage.clear();
  mockGetWorkspaces.mockResolvedValue({ workspaces: [] });
});
afterEach(() => cleanup());

// ─── Initial load ─────────────────────────────────────────────────────────────

describe('WorkspaceContext — initial load', () => {
  it('calls getWorkspaces on mount when user has a team', async () => {
    render(<WorkspaceProvider><Consumer /></WorkspaceProvider>);
    await waitFor(() => expect(mockGetWorkspaces).toHaveBeenCalledTimes(1));
  });

  it('renders workspaces returned by getWorkspaces', async () => {
    mockGetWorkspaces.mockResolvedValue({ workspaces: [makeWorkspace('ws-1', 'Alpha'), makeWorkspace('ws-2', 'Beta')] });
    render(<WorkspaceProvider><Consumer /></WorkspaceProvider>);
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('2'));
  });

  it('does not call getWorkspaces when user has no team', async () => {
    mockCurrentTeamId = null;
    render(<WorkspaceProvider><Consumer /></WorkspaceProvider>);
    await act(async () => { /* flush */ });
    expect(mockGetWorkspaces).not.toHaveBeenCalled();
    expect(screen.getByTestId('count').textContent).toBe('0');
  });

  it('shows empty list and no active workspace when getWorkspaces fails', async () => {
    mockGetWorkspaces.mockRejectedValue(new Error('network error'));
    render(<WorkspaceProvider><Consumer /></WorkspaceProvider>);
    await act(async () => { /* flush */ });
    expect(screen.getByTestId('count').textContent).toBe('0');
    expect(screen.getByTestId('active').textContent).toBe('none');
  });
});

// ─── localStorage persistence ─────────────────────────────────────────────────

describe('WorkspaceContext — localStorage persistence', () => {
  it('persists activeWorkspaceId to localStorage on selection', async () => {
    render(<WorkspaceProvider><Consumer /></WorkspaceProvider>);
    await waitFor(() => expect(mockGetWorkspaces).toHaveBeenCalled());

    act(() => {
      screen.getByText('select ws-1').click();
    });

    expect(localStorage.getItem('activeWorkspace_team-1')).toBe('ws-1');
    expect(screen.getByTestId('active').textContent).toBe('ws-1');
  });

  it('removes localStorage key when selection is cleared', async () => {
    localStorage.setItem('activeWorkspace_team-1', 'ws-1');
    render(<WorkspaceProvider><Consumer /></WorkspaceProvider>);
    await waitFor(() => expect(mockGetWorkspaces).toHaveBeenCalled());

    act(() => {
      screen.getByText('clear').click();
    });

    expect(localStorage.getItem('activeWorkspace_team-1')).toBeNull();
    expect(screen.getByTestId('active').textContent).toBe('none');
  });

  it('restores persisted selection on mount', async () => {
    localStorage.setItem('activeWorkspace_team-1', 'ws-stored');
    mockGetWorkspaces.mockResolvedValue({ workspaces: [makeWorkspace('ws-stored', 'Stored')] });
    render(<WorkspaceProvider><Consumer /></WorkspaceProvider>);
    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('ws-stored'));
  });

  it('clears stale selection when the workspace no longer exists', async () => {
    localStorage.setItem('activeWorkspace_team-1', 'ws-deleted');
    // getWorkspaces returns a different workspace — the stored one is gone
    mockGetWorkspaces.mockResolvedValue({ workspaces: [makeWorkspace('ws-other', 'Other')] });
    render(<WorkspaceProvider><Consumer /></WorkspaceProvider>);
    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('none'));
  });
});
