// @vitest-environment jsdom
/**
 * Regression test for TODO finding #4 (Low):
 * "UI: /results list page can get stuck on 'Loading…' forever"
 *
 * Root cause: `refresh()` in app/results/page.tsx was an async function
 * with no try/catch.  It was called from a useEffect with no .catch() chained:
 *
 *   useEffect(() => { ...; refresh(); }, [activeWorkspaceId]);
 *
 * When getResults rejects (network error, 5xx, etc.) the awaited Promise
 * inside refresh() rejected and propagated out of refresh() uncaught.
 * `setLoading(false)` was never reached, so the spinner stayed on screen forever.
 *
 * Fix: refresh() now wraps the fetch in try/catch/finally — setLoading(false)
 * is called unconditionally in the finally block, and a minimal error state
 * is set in the catch block so the user sees a message instead of a spinner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import ResultsPage from '../app/results/page';

// ---------------------------------------------------------------------------
// Module mocks — mirrors results.test.tsx so the component renders without a
// real router, workspace context, or WebSocket connection.
// ---------------------------------------------------------------------------

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={String(to)} {...(props as React.HTMLAttributes<HTMLAnchorElement>)}>
      {children}
    </a>
  ),
}));

const mockGetResults = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  getResults: mockGetResults,
}));

vi.mock('@/lib/WorkspaceContext', () => ({
  useWorkspace: () => ({
    workspaces: [],
    activeWorkspaceId: null,
    setActiveWorkspaceId: vi.fn(),
    refetch: vi.fn(),
  }),
}));

// useResultsSocket internally calls useSocketContext() which returns null when
// no ResultsSocketProvider wraps the tree — the hook's `if (!ctx) return` guard
// makes it a no-op.  No explicit mock is needed.

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Finding #4 regression
// ---------------------------------------------------------------------------

describe('Finding #4 — ResultsPage stuck on Loading… when getResults rejects', () => {
  it(
    'loading spinner clears when getResults rejects (try/catch/finally present)',
    async () => {
      // A rejected promise simulates a network error or non-2xx response.
      // refresh() now catches the rejection in a try/catch/finally and calls
      // setLoading(false) unconditionally — the spinner must disappear.
      mockGetResults.mockRejectedValue(new Error('network error'));

      render(<ResultsPage />);

      // Desired behaviour: the component transitions out of the loading state
      // and shows an error message instead of the infinite spinner.
      await waitFor(
        () => expect(screen.queryByText('Loading…')).not.toBeInTheDocument(),
        { timeout: 500 },
      );
    },
  );
});
