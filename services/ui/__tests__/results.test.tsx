// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { createRoutesStub } from 'react-router';
import ResultsPage, { loader } from '../app/results/page';
import { storageKey } from '../lib/WorkspaceContext';

const mockPush = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockPush };
});

vi.mock('@/lib/api', () => ({
  getMe: vi.fn(),
  getResults: vi.fn(),
}));

const mockActiveWorkspaceId = vi.hoisted(() => ({ current: null as string | null }));

// Only useWorkspace() is mocked (still used by the component for refresh()/
// loadMore(), unrelated to routing) — storageKey stays the real implementation
// so the loader (which reads localStorage directly, no context access) works as-is.
vi.mock('@/lib/WorkspaceContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/WorkspaceContext')>();
  return { ...actual, useWorkspace: () => ({ workspaces: [], activeWorkspaceId: mockActiveWorkspaceId.current, setActiveWorkspaceId: vi.fn(), refetch: vi.fn() }) };
});

import { getMe, getResults } from '@/lib/api';
const mockGetMe = vi.mocked(getMe);
const mockGetResults = vi.mocked(getResults);

const TEAM_ID = 'team1';

// ResultsPage now fetches its initial data via a route loader instead of a
// mount-time useEffect — render it through a routes stub so useLoaderData()
// has the router context it needs.
function renderResultsPage() {
  const Stub = createRoutesStub([{ path: '/results', Component: ResultsPage, loader, HydrateFallback: () => null }]);
  return render(<Stub initialEntries={['/results']} />);
}

const makeResult = (id: string, status = 'completed') => ({
  id: `row-${id}`,
  test_id: id,
  type: 'backend',
  target_url: `http://example-${id}.com`,
  status,
  metrics: { type: 'backend' as const, rps: 10, p95ResponseTime: 400, avgResponseTime: 200, p50ResponseTime: 300, p99ResponseTime: 500, requestsTotal: 100, requestsFailed: 0 },
  script: null,
  script_description: null,
  reused_script: false,
  is_baseline: false,
  duration_seconds: 30,
  started_at: new Date().toISOString(),
  completed_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  perf_status: 'passed',
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockPush.mockReset();
  mockActiveWorkspaceId.current = null;
  mockGetMe.mockResolvedValue({ id: 'u1', email: 'a@example.com', role: 'member', teams: [], currentTeamId: TEAM_ID, orgs: [] });
});

afterEach(() => cleanup());

describe('Results page', () => {
  it('shows "No results yet" when the results list is empty', async () => {
    mockGetResults.mockResolvedValue({ results: [], nextBefore: null });
    renderResultsPage();
    await waitFor(() => expect(screen.getByText('No results yet')).toBeInTheDocument());
  });

  it('renders a row for each result', async () => {
    mockGetResults.mockResolvedValue({
      results: [makeResult('aaa'), makeResult('bbb')],
      nextBefore: null,
    });
    renderResultsPage();
    await waitFor(() => {
      expect(screen.getByText('http://example-aaa.com')).toBeInTheDocument();
      expect(screen.getByText('http://example-bbb.com')).toBeInTheDocument();
    });
  });

  it('compare button does not appear when fewer than 2 items are selected', async () => {
    mockGetResults.mockResolvedValue({ results: [makeResult('aaa')], nextBefore: null });
    renderResultsPage();
    await waitFor(() => screen.getByText('http://example-aaa.com'));
    const [checkbox] = screen.getAllByRole('checkbox');
    fireEvent.click(checkbox);
    expect(screen.queryByRole('button', { name: /compare selected/i })).not.toBeInTheDocument();
    expect(screen.getByText(/select one more to compare/i)).toBeInTheDocument();
  });

  it('shows compare button and navigates when 2 results are selected', async () => {
    mockGetResults.mockResolvedValue({
      results: [makeResult('aaa'), makeResult('bbb')],
      nextBefore: null,
    });
    renderResultsPage();
    await waitFor(() => screen.getAllByRole('checkbox'));
    const [cb1, cb2] = screen.getAllByRole('checkbox');
    fireEvent.click(cb1);
    fireEvent.click(cb2);
    const compareBtn = await screen.findByRole('button', { name: /compare selected/i });
    fireEvent.click(compareBtn);
    expect(mockPush).toHaveBeenCalledWith(
      expect.stringContaining('/results/compare?a=')
    );
  });

  it('does not show checkbox for non-completed results', async () => {
    mockGetResults.mockResolvedValue({
      results: [makeResult('aaa', 'running')],
      nextBefore: null,
    });
    renderResultsPage();
    await waitFor(() => screen.getByText('http://example-aaa.com'));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('shows a link to the individual result detail page', async () => {
    mockGetResults.mockResolvedValue({ results: [makeResult('test-id-xyz')], nextBefore: null });
    renderResultsPage();
    await waitFor(() => {
      const link = screen.getByRole('link', { name: /view/i });
      expect(link).toHaveAttribute('href', '/results/test-id-xyz');
    });
  });

  it('shows Re-run buttons for completed results (desktop + mobile)', async () => {
    mockGetResults.mockResolvedValue({ results: [makeResult('aaa', 'completed')], nextBefore: null });
    renderResultsPage();
    await waitFor(() => expect(screen.getByText('http://example-aaa.com')).toBeInTheDocument());
    // jsdom renders both the hidden-md desktop table and the md:hidden mobile cards,
    // so we expect at least one Re-run button (could be two — one per layout).
    expect(screen.getAllByRole('button', { name: /re-run/i }).length).toBeGreaterThan(0);
  });

  it('Re-run button navigates to home with the rerun query param', async () => {
    mockGetResults.mockResolvedValue({ results: [makeResult('aaa', 'completed')], nextBefore: null });
    renderResultsPage();
    await waitFor(() => expect(screen.getAllByRole('button', { name: /re-run/i }).length).toBeGreaterThan(0));
    // Click the first Re-run button (desktop table version)
    fireEvent.click(screen.getAllByRole('button', { name: /re-run/i })[0]);
    expect(mockPush).toHaveBeenCalledWith('/?rerun=aaa');
  });

  it('does not show a Re-run button for non-completed results', async () => {
    mockGetResults.mockResolvedValue({ results: [makeResult('aaa', 'running')], nextBefore: null });
    renderResultsPage();
    await waitFor(() => expect(screen.getByText('http://example-aaa.com')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /re-run/i })).not.toBeInTheDocument();
  });
});

// ─── Workspace filter ─────────────────────────────────────────────────────────
// The loader reads the active workspace straight from localStorage (the same
// place WorkspaceContext persists it) since loaders have no React context access.

describe('Results page — workspace filter', () => {
  it('calls getResults with null workspaceId when no workspace is active', async () => {
    mockGetResults.mockResolvedValue({ results: [], nextBefore: null });
    renderResultsPage();
    await waitFor(() => expect(mockGetResults).toHaveBeenCalled());
    expect(mockGetResults).toHaveBeenCalledWith(undefined, 50, null);
  });

  it('calls getResults with the active workspaceId when a workspace is selected', async () => {
    localStorage.setItem(storageKey(TEAM_ID), 'ws-abc');
    mockGetResults.mockResolvedValue({ results: [], nextBefore: null });
    renderResultsPage();
    await waitFor(() => expect(mockGetResults).toHaveBeenCalled());
    expect(mockGetResults).toHaveBeenCalledWith(undefined, 50, 'ws-abc');
  });
});
