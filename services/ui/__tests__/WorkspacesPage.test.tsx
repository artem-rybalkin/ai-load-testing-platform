// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { createRoutesStub } from 'react-router';
import WorkspacesPage, { loader } from '../app/workspaces/page';
import type { Workspace } from '../lib/api';

// WorkspacesPage now fetches its project list via a route loader instead of
// WorkspaceContext — render it through a routes stub so useLoaderData()/
// useRevalidator() have the router context they need.
function renderWorkspacesPage() {
  const Stub = createRoutesStub([{ path: '/workspaces', Component: WorkspacesPage, loader, HydrateFallback: () => null }]);
  return render(<Stub initialEntries={['/workspaces']} />);
}

const mockCreateWorkspace = vi.hoisted(() => vi.fn());
const mockUpdateWorkspace = vi.hoisted(() => vi.fn());
const mockDeleteWorkspace = vi.hoisted(() => vi.fn());
const mockGetWorkspaces = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  createWorkspace: mockCreateWorkspace,
  updateWorkspace: mockUpdateWorkspace,
  deleteWorkspace: mockDeleteWorkspace,
  getWorkspaces: mockGetWorkspaces,
}));

const mockSetActiveWorkspaceId = vi.hoisted(() => vi.fn());
const mockRefetch = vi.hoisted(() => vi.fn());
let mockWorkspaces: Workspace[] = [];
let mockActiveWorkspaceId: string | null = null;

vi.mock('@/lib/WorkspaceContext', () => ({
  useWorkspace: () => ({
    workspaces: mockWorkspaces,
    activeWorkspaceId: mockActiveWorkspaceId,
    setActiveWorkspaceId: mockSetActiveWorkspaceId,
    refetch: mockRefetch,
  }),
}));

const mockUser = vi.hoisted(() => vi.fn());
vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({ user: mockUser() }),
}));

const makeWorkspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  id: 'ws-1',
  teamId: 'team-1',
  name: 'My Project',
  description: 'Test project',
  createdAt: '2024-01-15T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockWorkspaces = [];
  mockActiveWorkspaceId = null;
  mockUser.mockReturnValue({ role: 'admin' });
  mockRefetch.mockResolvedValue(undefined);
  mockGetWorkspaces.mockImplementation(() => Promise.resolve({ workspaces: mockWorkspaces }));
  mockCreateWorkspace.mockResolvedValue({ workspace: makeWorkspace() });
  mockUpdateWorkspace.mockResolvedValue({ workspace: makeWorkspace({ name: 'Updated' }) });
  mockDeleteWorkspace.mockResolvedValue(undefined);
});
afterEach(() => cleanup());

// ─── Empty state ──────────────────────────────────────────────────────────────

describe('WorkspacesPage — empty state', () => {
  it('shows empty state message when no workspaces', async () => {
    renderWorkspacesPage();
    expect(await screen.findByText(/No projects yet/)).toBeInTheDocument();
  });

  it('shows the create form for admin role', async () => {
    renderWorkspacesPage();
    expect(await screen.findByPlaceholderText('Project name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create/i })).toBeInTheDocument();
  });

  it('shows the create form for member role', async () => {
    mockUser.mockReturnValue({ role: 'member' });
    renderWorkspacesPage();
    expect(await screen.findByPlaceholderText('Project name')).toBeInTheDocument();
  });

  it('hides create form for viewer role', async () => {
    mockUser.mockReturnValue({ role: 'viewer' });
    renderWorkspacesPage();
    expect(await screen.findByText(/No projects yet/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Project name')).not.toBeInTheDocument();
  });
});

// ─── List rendering ───────────────────────────────────────────────────────────

describe('WorkspacesPage — list rendering', () => {
  it('renders workspace name and description', async () => {
    mockWorkspaces = [makeWorkspace()];
    renderWorkspacesPage();
    expect(await screen.findByText('My Project')).toBeInTheDocument();
    expect(screen.getByText('Test project')).toBeInTheDocument();
  });

  it('renders creation date', async () => {
    mockWorkspaces = [makeWorkspace()];
    renderWorkspacesPage();
    expect(await screen.findByText('2024-01-15')).toBeInTheDocument();
  });

  it('shows "Active" badge for the active workspace', async () => {
    mockWorkspaces = [makeWorkspace({ id: 'ws-active' })];
    mockActiveWorkspaceId = 'ws-active';
    renderWorkspacesPage();
    expect(await screen.findByText('Active')).toBeInTheDocument();
  });

  it('does not show "Active" badge when workspace is not selected', async () => {
    mockWorkspaces = [makeWorkspace({ id: 'ws-1' })];
    mockActiveWorkspaceId = 'ws-other';
    renderWorkspacesPage();
    expect(await screen.findByText('My Project')).toBeInTheDocument();
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });

  it('shows Edit button for admin', async () => {
    mockWorkspaces = [makeWorkspace()];
    renderWorkspacesPage();
    expect(await screen.findByRole('button', { name: /Edit/i })).toBeInTheDocument();
  });

  it('hides Delete button for member role', async () => {
    mockUser.mockReturnValue({ role: 'member' });
    mockWorkspaces = [makeWorkspace()];
    renderWorkspacesPage();
    expect(await screen.findByText('My Project')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete/i })).not.toBeInTheDocument();
  });

  it('shows Delete button for admin', async () => {
    mockWorkspaces = [makeWorkspace()];
    renderWorkspacesPage();
    expect(await screen.findByRole('button', { name: /Delete/i })).toBeInTheDocument();
  });
});

// ─── Active selection ─────────────────────────────────────────────────────────

describe('WorkspacesPage — active selection', () => {
  it('clicking the radio button selects the workspace', async () => {
    mockWorkspaces = [makeWorkspace({ id: 'ws-click' })];
    renderWorkspacesPage();
    const radio = await screen.findByTitle('Set as active project');
    fireEvent.click(radio);
    expect(mockSetActiveWorkspaceId).toHaveBeenCalledWith('ws-click');
  });

  it('clicking the active workspace radio deselects it', async () => {
    mockWorkspaces = [makeWorkspace({ id: 'ws-deselect' })];
    mockActiveWorkspaceId = 'ws-deselect';
    renderWorkspacesPage();
    const radio = await screen.findByTitle('Deselect project');
    fireEvent.click(radio);
    expect(mockSetActiveWorkspaceId).toHaveBeenCalledWith(null);
  });
});

// ─── Create flow ──────────────────────────────────────────────────────────────

describe('WorkspacesPage — create flow', () => {
  it('calls createWorkspace with name and description on submit', async () => {
    renderWorkspacesPage();
    fireEvent.change(await screen.findByPlaceholderText('Project name'), { target: { value: 'New WS' } });
    fireEvent.change(screen.getByPlaceholderText('Description (optional)'), { target: { value: 'A description' } });
    fireEvent.click(screen.getByRole('button', { name: /Create/i }));
    await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalledWith({ name: 'New WS', description: 'A description' }));
    expect(mockRefetch).toHaveBeenCalled();
  });

  it('clears the form after successful creation', async () => {
    renderWorkspacesPage();
    const nameInput = await screen.findByPlaceholderText('Project name') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Temporary' } });
    fireEvent.click(screen.getByRole('button', { name: /Create/i }));
    await waitFor(() => expect(nameInput.value).toBe(''));
  });

  it('shows error message when createWorkspace fails', async () => {
    mockCreateWorkspace.mockRejectedValue(new Error('Name already taken'));
    renderWorkspacesPage();
    fireEvent.change(await screen.findByPlaceholderText('Project name'), { target: { value: 'Dupe' } });
    fireEvent.click(screen.getByRole('button', { name: /Create/i }));
    await waitFor(() => expect(screen.getByText('Name already taken')).toBeInTheDocument());
  });

  it('does not call createWorkspace when name is empty', async () => {
    renderWorkspacesPage();
    fireEvent.click(await screen.findByRole('button', { name: /Create/i }));
    expect(mockCreateWorkspace).not.toHaveBeenCalled();
  });
});

// ─── Edit flow ────────────────────────────────────────────────────────────────

describe('WorkspacesPage — edit flow', () => {
  it('opens inline editor when Edit is clicked', async () => {
    mockWorkspaces = [makeWorkspace()];
    renderWorkspacesPage();
    fireEvent.click(await screen.findByRole('button', { name: /Edit/i }));
    expect(screen.getByDisplayValue('My Project')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Test project')).toBeInTheDocument();
  });

  it('saves changes and calls updateWorkspace', async () => {
    mockWorkspaces = [makeWorkspace()];
    renderWorkspacesPage();
    fireEvent.click(await screen.findByRole('button', { name: /Edit/i }));
    fireEvent.change(screen.getByDisplayValue('My Project'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/i }));
    await waitFor(() => expect(mockUpdateWorkspace).toHaveBeenCalledWith('ws-1', { name: 'Renamed', description: 'Test project' }));
    expect(mockRefetch).toHaveBeenCalled();
  });

  it('cancels edit without saving', async () => {
    mockWorkspaces = [makeWorkspace()];
    renderWorkspacesPage();
    fireEvent.click(await screen.findByRole('button', { name: /Edit/i }));
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(mockUpdateWorkspace).not.toHaveBeenCalled();
    expect(screen.getByText('My Project')).toBeInTheDocument();
  });

  it('shows error when updateWorkspace fails', async () => {
    mockWorkspaces = [makeWorkspace()];
    mockUpdateWorkspace.mockRejectedValue(new Error('Name collision'));
    renderWorkspacesPage();
    fireEvent.click(await screen.findByRole('button', { name: /Edit/i }));
    fireEvent.click(screen.getByRole('button', { name: /Save/i }));
    await waitFor(() => expect(screen.getByText('Name collision')).toBeInTheDocument());
  });
});

// ─── Delete flow ──────────────────────────────────────────────────────────────

describe('WorkspacesPage — delete flow', () => {
  it('calls deleteWorkspace after confirm dialog', async () => {
    mockWorkspaces = [makeWorkspace()];
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWorkspacesPage();
    fireEvent.click(await screen.findByRole('button', { name: /Delete/i }));
    await waitFor(() => expect(mockDeleteWorkspace).toHaveBeenCalledWith('ws-1'));
    expect(mockRefetch).toHaveBeenCalled();
  });

  it('does not call deleteWorkspace when confirm is cancelled', async () => {
    mockWorkspaces = [makeWorkspace()];
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderWorkspacesPage();
    fireEvent.click(await screen.findByRole('button', { name: /Delete/i }));
    expect(mockDeleteWorkspace).not.toHaveBeenCalled();
  });

  it('clears activeWorkspaceId when deleting the active workspace', async () => {
    mockWorkspaces = [makeWorkspace({ id: 'ws-del' })];
    mockActiveWorkspaceId = 'ws-del';
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWorkspacesPage();
    fireEvent.click(await screen.findByRole('button', { name: /Delete/i }));
    await waitFor(() => expect(mockSetActiveWorkspaceId).toHaveBeenCalledWith(null));
  });

  it('does not clear activeWorkspaceId when deleting a different workspace', async () => {
    mockWorkspaces = [makeWorkspace({ id: 'ws-other-del' })];
    mockActiveWorkspaceId = 'ws-different';
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWorkspacesPage();
    fireEvent.click(await screen.findByRole('button', { name: /Delete/i }));
    await waitFor(() => expect(mockDeleteWorkspace).toHaveBeenCalled());
    expect(mockSetActiveWorkspaceId).not.toHaveBeenCalled();
  });
});
