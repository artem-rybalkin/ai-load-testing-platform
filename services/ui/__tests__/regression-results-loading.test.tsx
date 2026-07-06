// @vitest-environment jsdom
/**
 * Regression test for TODO finding #4 (Low):
 * "UI: /results list page can get stuck on 'Loading…' forever"
 *
 * Root cause: `refresh()` in app/results/page.tsx:97-102 is an async function
 * with no try/catch.  It is called from a useEffect with no .catch() chained:
 *
 *   useEffect(() => { ...; refresh(); }, [activeWorkspaceId]);
 *
 * When getResults rejects (network error, 5xx, etc.) the awaited Promise
 * inside refresh() rejects and propagates out of refresh() uncaught.
 * `setLoading(false)` is never reached, so the spinner stays on screen forever.
 *
 * --- Why the mock uses a pending-forever promise, not mockRejectedValue ---
 * Both a rejection AND an eternal pending demonstrate the same defect:
 * `setLoading(false)` is placed after `await getResults(...)` with no
 * try/catch/finally, so any non-resolving getResults keeps loading=true.
 *
 * Using mockRejectedValue causes refresh() to create an unhandled rejection at
 * the Node.js process level (because useEffect calls refresh() without .catch()).
 * Vitest captures process-level unhandledRejection events independently of
 * jsdom's window event, so window.addEventListener('unhandledrejection', ...)
 * cannot suppress it.  A pending-forever promise avoids the noise completely
 * while proving the same root cause.
 *
 * --- it.fails semantics ---
 *   - Bug PRESENT  → loading stays true, waitFor times out, assertion throws
 *                    → it.fails reports PASS (CI green).
 *   - Bug FIXED    → setLoading(false) called in a catch/finally, loading clears,
 *                    assertion passes → it.fails flips to red (remove wrapper).
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

describe('Finding #4 — ResultsPage stuck on Loading… when getResults never resolves', () => {
  it.fails(
    'loading spinner clears when getResults hangs (never resolves — missing try/catch/finally)',
    async () => {
      // A pending-forever promise simulates getResults hanging (network stall,
      // slow response, or — identically from refresh()'s perspective — a
      // rejection that propagates uncaught through the missing try/catch.
      // In both cases setLoading(false) is never reached.
      mockGetResults.mockReturnValue(new Promise(() => {}));

      render(<ResultsPage />);

      // Desired behaviour: the component detects that getResults did not resolve
      // within a reasonable time (or rejected) and clears the loading state so
      // the user is not permanently stuck on the spinner.
      //
      // Bug behaviour: refresh() has no try/catch/finally, so setLoading(false)
      // is only reachable on the happy path.  The "Loading…" text stays on
      // screen forever; this waitFor times out → assertion throws → it.fails = PASS.
      await waitFor(
        () => expect(screen.queryByText('Loading…')).not.toBeInTheDocument(),
        { timeout: 500 },
      );
    },
  );
});
