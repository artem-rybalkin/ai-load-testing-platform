// @vitest-environment jsdom
/**
 * Regression test for TODO finding #4 (Low):
 * "UI: /results list page can get stuck on 'Loading…' forever"
 *
 * Root cause (original): `refresh()` in app/results/page.tsx was an async
 * function with no try/catch, called from a mount-time useEffect with no
 * .catch() chained. When getResults rejected, setLoading(false) was never
 * reached, so the spinner stayed on screen forever.
 *
 * The page has since been migrated to a route loader (2026-07-10 router
 * migration) — there is no more mount-time fetch or "Loading…" state to get
 * stuck on; the router itself blocks the transition until the loader
 * settles. The equivalent invariant to guard now is: a rejected getResults()
 * inside the loader must not throw (which would land the route in its
 * errorElement) — it must resolve to an error state the page can render.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { createRoutesStub } from 'react-router';
import ResultsPage, { loader } from '../app/results/page';

// ---------------------------------------------------------------------------
// Module mocks — mirrors results.test.tsx so the component renders without a
// real workspace context or WebSocket connection.
// ---------------------------------------------------------------------------

const mockGetMe = vi.hoisted(() => vi.fn());
const mockGetResults = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  getMe: mockGetMe,
  getResults: mockGetResults,
}));

vi.mock('@/lib/WorkspaceContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/WorkspaceContext')>();
  return {
    ...actual,
    useWorkspace: () => ({ workspaces: [], activeWorkspaceId: null, setActiveWorkspaceId: vi.fn(), refetch: vi.fn() }),
  };
});

// useResultsSocket internally calls useSocketContext() which returns null when
// no ResultsSocketProvider wraps the tree — the hook's `if (!ctx) return` guard
// makes it a no-op.  No explicit mock is needed.

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMe.mockResolvedValue({ id: 'u1', email: 'a@example.com', role: 'member', teams: [], currentTeamId: 'team1', orgs: [] });
});

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Finding #4 regression
// ---------------------------------------------------------------------------

describe('Finding #4 — ResultsPage does not get stuck when getResults rejects', () => {
  it('loader resolves to an error state instead of throwing when getResults rejects', async () => {
    mockGetResults.mockRejectedValue(new Error('network error'));

    const data = await loader();

    expect(data).toEqual({ results: [], nextBefore: null, loadError: 'Failed to load results' });
  });

  it('renders the error message instead of hanging when getResults rejects', async () => {
    mockGetResults.mockRejectedValue(new Error('network error'));
    const Stub = createRoutesStub([{ path: '/results', Component: ResultsPage, loader, HydrateFallback: () => null }]);

    render(<Stub initialEntries={['/results']} />);

    await waitFor(() => expect(screen.getByText('Failed to load results')).toBeInTheDocument());
  });
});
