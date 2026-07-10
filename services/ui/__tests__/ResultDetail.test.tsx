// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import ResultPage from '../app/results/testId/page';
import type { TestResult } from '@/lib/api';

const stableParams = vi.hoisted(() => ({ testId: 'test-123' }));

vi.mock('react-router-dom', () => ({
  useParams: () => stableParams,
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={String(to)} {...(props as React.HTMLAttributes<HTMLAnchorElement>)}>{children}</a>
  ),
}));

vi.mock('@/lib/useResultsSocket', () => ({ useResultsSocket: vi.fn() }));

// Lazy-loaded chart/panel components — irrelevant to status-display logic
vi.mock('@/app/components/BackendChart',  () => ({ default: () => null }));
vi.mock('@/app/components/ClientChart',   () => ({ default: () => null }));
vi.mock('@/app/components/FlowStepChart', () => ({ default: () => null }));
vi.mock('@/app/components/AnalysisPanel', () => ({ default: () => null }));
vi.mock('@/app/components/RealtimeChart', () => ({ default: () => null }));
vi.mock('@/app/components/TrendChart',    () => ({ default: () => null }));

vi.mock('@/lib/api', () => ({
  getResult: vi.fn(),
  getLiveMetrics: vi.fn(),
  getTrend: vi.fn(),
  getLogSources: vi.fn(),
  setBaseline: vi.fn(),
  clearBaseline: vi.fn(),
  cancelTest: vi.fn(),
  diagnoseErrors: vi.fn(),
  getTrendNarrative: vi.fn(),
  interpolateLogSourceUrl: vi.fn(),
}));

import { getResult, getLiveMetrics, getTrend, getLogSources } from '@/lib/api';
const mockGetResult = vi.mocked(getResult);

const makeResult = (overrides: Partial<TestResult> = {}): TestResult => ({
  id: 'row-1',
  test_id: 'test-123',
  type: 'backend',
  target_url: 'http://localhost:8081',
  status: 'pending',
  metrics: null as TestResult['metrics'],
  script: null,
  script_description: null,
  reused_script: false,
  is_baseline: false,
  duration_seconds: 300,
  started_at: null,
  completed_at: null,
  created_at: new Date().toISOString(),
  status_message: 'Script ready — starting test…',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetResult.mockResolvedValue({ result: makeResult() });
  // These previously had default resolved values baked into the vi.mock(...)
  // factory itself, which only runs once — the project's global mockReset: true
  // clears that implementation before every test, so it's re-established here.
  vi.mocked(getLiveMetrics).mockResolvedValue({ points: [] });
  vi.mocked(getTrend).mockResolvedValue({ trend: [] } as never);
  vi.mocked(getLogSources).mockResolvedValue({ logSources: [] });
});

afterEach(() => cleanup());

describe('Result detail — stale status_message visibility', () => {
  it('shows the in-flight status_message while the test is still pending', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult({ status: 'pending' }) });
    render(<ResultPage />);
    await waitFor(() => expect(screen.getByText('Script ready — starting test…')).toBeInTheDocument());
  });

  it('hides a stale status_message once the test has reached a terminal "failed" state', async () => {
    mockGetResult.mockResolvedValue({
      result: makeResult({ status: 'failed', status_message: 'Script ready — starting test…' }),
    });
    render(<ResultPage />);
    await waitFor(() => expect(screen.getByText(/test failed — no metrics collected/i)).toBeInTheDocument());
    expect(screen.queryByText('Script ready — starting test…')).not.toBeInTheDocument();
  });

  it('hides a stale status_message once the test has been cancelled', async () => {
    mockGetResult.mockResolvedValue({
      result: makeResult({ status: 'cancelled', status_message: 'Script ready — starting test…' }),
    });
    render(<ResultPage />);
    await waitFor(() => expect(screen.getByText(/test cancelled — no metrics collected/i)).toBeInTheDocument());
    expect(screen.queryByText('Script ready — starting test…')).not.toBeInTheDocument();
  });
});

describe('Result detail — self-healing poll for in-flight tests', () => {
  it('periodically re-fetches the result while status is pending, to recover from missed WebSocket events', async () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    mockGetResult.mockResolvedValue({ result: makeResult({ status: 'pending' }) });

    render(<ResultPage />);
    await waitFor(() => expect(screen.getByText(/waiting in queue/i)).toBeInTheDocument());

    const pollRegistration = setIntervalSpy.mock.calls.find(([, ms]) => ms === 20_000);
    expect(pollRegistration).toBeDefined();

    mockGetResult.mockClear();
    mockGetResult.mockResolvedValueOnce({
      result: makeResult({ status: 'failed', status_message: null }),
    });

    // Fire the captured interval callback directly — simulates the 20s tick
    // without depending on fake-timer/RTL interplay.
    await act(async () => { (pollRegistration![0] as () => void)(); });

    await waitFor(() => expect(mockGetResult).toHaveBeenCalledWith('test-123'));
    await waitFor(() => expect(screen.getByText(/test failed — no metrics collected/i)).toBeInTheDocument());

    setIntervalSpy.mockRestore();
  });

  it('does not register a self-healing poll once the test is already in a terminal state', async () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    mockGetResult.mockResolvedValue({
      result: makeResult({ status: 'failed', status_message: null }),
    });

    render(<ResultPage />);
    await waitFor(() => expect(screen.getByText(/test failed — no metrics collected/i)).toBeInTheDocument());

    expect(setIntervalSpy.mock.calls.find(([, ms]) => ms === 20_000)).toBeUndefined();
    setIntervalSpy.mockRestore();
  });
});
