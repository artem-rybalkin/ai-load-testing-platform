// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { createRoutesStub } from 'react-router';
import ScriptsPage, { loader } from '../app/scripts/page';
import { storageKey } from '../lib/WorkspaceContext';
import type { SavedScript } from '../lib/api';

const mockGetMe               = vi.hoisted(() => vi.fn());
const mockGetScripts          = vi.hoisted(() => vi.fn());
const mockGetScript           = vi.hoisted(() => vi.fn());
const mockGetScriptVersions   = vi.hoisted(() => vi.fn());
const mockRestoreScriptVersion = vi.hoisted(() => vi.fn());
const mockNavigate            = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  getMe: mockGetMe,
  getScripts: mockGetScripts,
  getScript: mockGetScript,
  getScriptVersions: mockGetScriptVersions,
  restoreScriptVersion: mockRestoreScriptVersion,
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const TEAM_ID = 'team1';

function renderScriptsPage() {
  const Stub = createRoutesStub([{ path: '/scripts', Component: ScriptsPage, loader, HydrateFallback: () => null }]);
  return render(<Stub initialEntries={['/scripts']} />);
}

const makeScript = (overrides: Partial<SavedScript> = {}): SavedScript => ({
  id: 's1',
  targetUrl: 'https://api.example.com/checkout',
  testType: 'backend',
  usedCount: 4,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-02T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  mockGetMe.mockResolvedValue({ id: 'u1', email: 'a@example.com', role: 'member', teams: [], currentTeamId: TEAM_ID, orgs: [] });
  mockGetScripts.mockResolvedValue({ scripts: [] });
});
afterEach(() => cleanup());

describe('ScriptsPage — loading and empty state', () => {
  it('shows the empty state once loaded', async () => {
    renderScriptsPage();
    await waitFor(() => expect(screen.getByText(/No saved scripts yet/)).toBeInTheDocument());
  });

  it('shows an error message when getScripts rejects', async () => {
    mockGetScripts.mockRejectedValue(new Error('network error'));
    renderScriptsPage();
    await waitFor(() => expect(screen.getByText(/Could not reach results-service/)).toBeInTheDocument());
  });
});

describe('ScriptsPage — list rendering', () => {
  it('renders a backend script by its target URL', async () => {
    mockGetScripts.mockResolvedValue({ scripts: [makeScript()] });
    renderScriptsPage();
    await waitFor(() => expect(screen.getByText('https://api.example.com/checkout')).toBeInTheDocument());
    expect(screen.getByText('backend')).toBeInTheDocument();
    expect(screen.getByText(/used 4×/)).toBeInTheDocument();
  });

  it('labels a flow script by its opaque hash instead of a raw URL', async () => {
    mockGetScripts.mockResolvedValue({ scripts: [makeScript({ targetUrl: 'flow:d6234134a8196e83', testType: 'backend' })] });
    renderScriptsPage();
    await waitFor(() => expect(screen.getByText(/Flow script #/)).toBeInTheDocument());
    expect(screen.queryByText('flow:d6234134a8196e83')).not.toBeInTheDocument();
  });
});

describe('ScriptsPage — preview', () => {
  it('fetches and shows the script text when View script is clicked', async () => {
    mockGetScripts.mockResolvedValue({ scripts: [makeScript()] });
    mockGetScript.mockResolvedValue({ script: { ...makeScript(), script: 'export default function() {}' } });
    renderScriptsPage();
    await waitFor(() => expect(screen.getByText('https://api.example.com/checkout')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /view script/i }));
    await waitFor(() => expect(mockGetScript).toHaveBeenCalledWith('s1'));
    await waitFor(() => expect(screen.getByText('export default function() {}')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /hide script/i }));
    expect(screen.queryByText('export default function() {}')).not.toBeInTheDocument();
  });
});

describe('ScriptsPage — version history', () => {
  it('shows a no-history message when there are no saved versions', async () => {
    mockGetScripts.mockResolvedValue({ scripts: [makeScript()] });
    mockGetScriptVersions.mockResolvedValue({ versions: [] });
    renderScriptsPage();
    await waitFor(() => expect(screen.getByText('https://api.example.com/checkout')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /version history/i }));
    await waitFor(() => expect(screen.getByText(/hasn't been edited/)).toBeInTheDocument());
  });

  it('lists versions and restores one when clicked', async () => {
    mockGetScripts.mockResolvedValue({ scripts: [makeScript()] });
    mockGetScriptVersions.mockResolvedValue({
      versions: [{ id: 'v1', script: 'old code', createdAt: '2024-01-01T00:00:00.000Z' }],
    });
    mockRestoreScriptVersion.mockResolvedValue(undefined);
    renderScriptsPage();
    await waitFor(() => expect(screen.getByText('https://api.example.com/checkout')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /version history/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /restore/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /restore/i }));
    await waitFor(() => expect(mockRestoreScriptVersion).toHaveBeenCalledWith('s1', 'v1'));
  });

  it('refreshes the open history and preview panels after a restore instead of leaving them on the stale pre-restore content', async () => {
    mockGetScripts.mockResolvedValue({ scripts: [makeScript()] });
    mockGetScript
      .mockResolvedValueOnce({ script: { ...makeScript(), script: 'current code' } })
      .mockResolvedValueOnce({ script: { ...makeScript(), script: 'restored code' } });
    mockGetScriptVersions
      .mockResolvedValueOnce({ versions: [{ id: 'v1', script: 'old code', createdAt: '2024-01-01T00:00:00.000Z' }] })
      .mockResolvedValueOnce({ versions: [{ id: 'v2', script: 'current code', createdAt: '2024-01-02T00:00:00.000Z' }] });
    mockRestoreScriptVersion.mockResolvedValue(undefined);
    renderScriptsPage();
    await waitFor(() => expect(screen.getByText('https://api.example.com/checkout')).toBeInTheDocument());

    // Open both the preview and the history panels — the state a user must be in to click Restore at all.
    fireEvent.click(screen.getByRole('button', { name: /view script/i }));
    await waitFor(() => expect(screen.getByText('current code')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /version history/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /restore/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /restore/i }));
    await waitFor(() => expect(mockRestoreScriptVersion).toHaveBeenCalledWith('s1', 'v1'));

    // Both panels are still open (no manual collapse/re-expand) and must show the post-restore content on their own.
    await waitFor(() => expect(screen.getByText('restored code')).toBeInTheDocument());
    expect(screen.queryByText('current code')).not.toBeInTheDocument();
    expect(mockGetScript).toHaveBeenCalledTimes(2);
    expect(mockGetScriptVersions).toHaveBeenCalledTimes(2);
  });

  it('shows an error message when restore fails', async () => {
    mockGetScripts.mockResolvedValue({ scripts: [makeScript()] });
    mockGetScriptVersions.mockResolvedValue({
      versions: [{ id: 'v1', script: 'old code', createdAt: '2024-01-01T00:00:00.000Z' }],
    });
    mockRestoreScriptVersion.mockRejectedValue(new Error('restore failed'));
    renderScriptsPage();
    await waitFor(() => expect(screen.getByText('https://api.example.com/checkout')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /version history/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /restore/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /restore/i }));

    await waitFor(() => expect(screen.getByText('restore failed')).toBeInTheDocument());
  });
});

describe('ScriptsPage — Edit via Chat navigation', () => {
  it('stores the scriptId in sessionStorage and navigates to /chat', async () => {
    mockGetScripts.mockResolvedValue({ scripts: [makeScript()] });
    renderScriptsPage();
    await waitFor(() => expect(screen.getByText('https://api.example.com/checkout')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /edit via chat/i }));

    expect(sessionStorage.getItem('chatEditScriptId')).toBe('s1');
    expect(mockNavigate).toHaveBeenCalledWith('/chat');
  });
});

describe('ScriptsPage — workspace filter', () => {
  it('calls getScripts with null when no workspace is active', async () => {
    renderScriptsPage();
    await waitFor(() => expect(mockGetScripts).toHaveBeenCalled());
    expect(mockGetScripts).toHaveBeenCalledWith(null);
  });

  it('calls getScripts with the active workspaceId when one is selected', async () => {
    localStorage.setItem(storageKey(TEAM_ID), 'ws-xyz');
    renderScriptsPage();
    await waitFor(() => expect(mockGetScripts).toHaveBeenCalled());
    expect(mockGetScripts).toHaveBeenCalledWith('ws-xyz');
  });
});
