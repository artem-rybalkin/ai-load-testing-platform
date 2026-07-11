// @vitest-environment jsdom
/**
 * Unit tests for the ResultDetail page (M11).
 * Covers: metric cells, status badge, baseline toggle, Re-run link,
 *         PDF/CSV links, cancel button, execution log panel, client metrics,
 *         and pending/running state placeholders.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { createRoutesStub } from 'react-router';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockGetResult       = vi.hoisted(() => vi.fn());
const mockGetLiveMetrics  = vi.hoisted(() => vi.fn());
const mockGetTrend        = vi.hoisted(() => vi.fn());
const mockSetBaseline     = vi.hoisted(() => vi.fn());
const mockClearBaseline   = vi.hoisted(() => vi.fn());
const mockCancelTest      = vi.hoisted(() => vi.fn());
const mockGetLogSources   = vi.hoisted(() => vi.fn());
const mockGetExecutionLog = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  getResult:      mockGetResult,
  getLiveMetrics: mockGetLiveMetrics,
  getTrend:       mockGetTrend,
  setBaseline:    mockSetBaseline,
  clearBaseline:  mockClearBaseline,
  cancelTest:     mockCancelTest,
  getLogSources:  mockGetLogSources,
  diagnoseErrors:    vi.fn(),
  getTrendNarrative: vi.fn(),
  getExecutionLog:   mockGetExecutionLog,
  interpolateLogSourceUrl: vi.fn().mockReturnValue('http://grafana.example.com/'),
}));

// Mock the WebSocket hook — expose a setter so tests can simulate WS events
const mockUseResultsSocket = vi.hoisted(() => vi.fn());
vi.mock('@/lib/useResultsSocket', () => ({ useResultsSocket: mockUseResultsSocket }));

const TEST_ID = 'test-uuid-abc123';

// Lazy chart components — stub them out so Suspense resolves immediately
vi.mock('@/app/components/BackendChart',  () => ({ default: () => <div data-testid="backend-chart" /> }));
vi.mock('@/app/components/ClientChart',   () => ({ default: () => <div data-testid="client-chart" /> }));
vi.mock('@/app/components/FlowStepChart', () => ({ default: () => <div data-testid="flow-step-chart" /> }));
vi.mock('@/app/components/AnalysisPanel', () => ({ default: ({ analysis }: { analysis: unknown }) => <div data-testid="analysis-panel">{JSON.stringify(analysis)}</div> }));
vi.mock('@/app/components/RealtimeChart', () => ({ default: () => <div data-testid="realtime-chart" /> }));
vi.mock('@/app/components/TrendChart',    () => ({ default: () => <div data-testid="trend-chart" /> }));

// import.meta.env
vi.stubGlobal('import', { meta: { env: { VITE_RESULTS_URL: 'http://localhost:3004' } } });

import ResultPage, { loader } from '../app/results/testId/page';

// ResultPage now fetches its initial data via a route loader instead of a
// mount-time useEffect — render it through a routes stub (real react-router)
// so useLoaderData()/useParams() have the router context they need.
function renderResultPage() {
  const Stub = createRoutesStub([{ path: '/results/:testId', Component: ResultPage, loader, HydrateFallback: () => null }]);
  return render(<Stub initialEntries={[`/results/${TEST_ID}`]} />);
}

// ─── Test data builders ───────────────────────────────────────────────────────

const makeBackendMetrics = (overrides = {}) => ({
  type: 'backend' as const,
  requestsTotal:    1000,
  requestsFailed:   10,
  avgResponseTime:  250,
  p50ResponseTime:  200,
  p95ResponseTime:  480,
  p99ResponseTime:  900,
  rps:              33.3,
  ...overrides,
});

const makeClientMetrics = (overrides = {}) => ({
  type: 'client' as const,
  lcp:  1800,
  fid:  12,
  cls:  0.05,
  ttfb: 200,
  fcp:  900,
  ...overrides,
});

const makeResult = (overrides: Record<string, unknown> = {}) => ({
  id: TEST_ID,
  test_id: TEST_ID,
  type: 'backend',
  target_url: 'http://example.com',
  status: 'completed',
  metrics: makeBackendMetrics(),
  script: null,
  script_description: null,
  reused_script: false,
  is_baseline: false,
  duration_seconds: 30,
  started_at: new Date('2024-01-01T10:00:00Z').toISOString(),
  completed_at: new Date('2024-01-01T10:00:30Z').toISOString(),
  created_at: new Date('2024-01-01T10:00:00Z').toISOString(),
  perf_status: 'passed',
  analysis: null,
  status_message: null,
  ...overrides,
});

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockUseResultsSocket.mockImplementation(() => {});
  mockGetLiveMetrics.mockResolvedValue({ points: [] });
  mockGetLogSources.mockResolvedValue({ logSources: [] });
  mockGetTrend.mockResolvedValue({ trend: [] });
  mockGetExecutionLog.mockResolvedValue({ log: null });
});

afterEach(() => cleanup());

// ─── Loading state ────────────────────────────────────────────────────────────

describe('ResultDetailPage — loading state', () => {
  // The page-local "Loading…" spinner this used to assert on was a mount-time-
  // useEffect artifact — now that the fetch runs in a route loader, the router
  // itself blocks the transition until it resolves (same as every other
  // loader-converted page in this app, none of which show a local spinner).

  it('shows a "Generating test script" message when result is not found', async () => {
    mockGetResult.mockResolvedValue({ result: null });
    renderResultPage();
    await waitFor(() => expect(screen.getByText(/Generating test script/i)).toBeInTheDocument());
  });
});

// ─── Completed backend test ───────────────────────────────────────────────────

describe('ResultDetailPage — completed backend test', () => {
  it('renders the target URL as the page title', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult() });
    renderResultPage();
    await waitFor(() => expect(screen.getByText('http://example.com')).toBeInTheDocument());
  });

  it('shows the completed status badge', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult({ status: 'completed' }) });
    renderResultPage();
    await waitFor(() => expect(screen.getByText('completed')).toBeInTheDocument());
  });

  it('renders key metric cells with correct values', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult() });
    renderResultPage();
    await waitFor(() => {
      // Total Requests
      expect(screen.getByText('1000')).toBeInTheDocument();
      // p95 Response = 480 ms
      expect(screen.getByText('480')).toBeInTheDocument();
      // Avg Response = 250 ms
      expect(screen.getByText('250')).toBeInTheDocument();
      // RPS = 33.3
      expect(screen.getByText('33.3')).toBeInTheDocument();
    });
  });

  it('does not render a Checks Failed cell when checksTotal is absent (historical results)', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult() });
    renderResultPage();
    await waitFor(() => expect(screen.getByText('1000')).toBeInTheDocument());
    expect(screen.queryByText('Checks Failed')).not.toBeInTheDocument();
  });

  it('renders a Checks Failed cell when checksTotal is present', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult({ metrics: makeBackendMetrics({ checksTotal: 200, checksFailed: 20 }) }) });
    renderResultPage();
    await waitFor(() => {
      expect(screen.getByText('Checks Failed')).toBeInTheDocument();
      expect(screen.getByText('20')).toBeInTheDocument();
      expect(screen.getByText('/ 10.0%')).toBeInTheDocument();
    });
  });

  it('shows the BackendChart component', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult() });
    renderResultPage();
    await waitFor(() => expect(screen.getByTestId('backend-chart')).toBeInTheDocument());
  });

  it('shows "Set baseline" button for a completed result that is not a baseline', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult({ is_baseline: false }) });
    renderResultPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /set baseline/i })).toBeInTheDocument());
  });

  it('shows "Clear baseline" button when is_baseline is true', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult({ is_baseline: true }) });
    renderResultPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /clear baseline/i })).toBeInTheDocument());
  });

  it('shows "baseline" badge when is_baseline is true', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult({ is_baseline: true }) });
    renderResultPage();
    await waitFor(() => expect(screen.getByText('baseline')).toBeInTheDocument());
  });

  it('calls setBaseline and refetches when "Set baseline" is clicked', async () => {
    const updated = makeResult({ is_baseline: true });
    mockGetResult
      .mockResolvedValueOnce({ result: makeResult({ is_baseline: false }) })
      .mockResolvedValueOnce({ result: updated });
    mockSetBaseline.mockResolvedValue({});
    renderResultPage();
    await waitFor(() => screen.getByRole('button', { name: /set baseline/i }));
    fireEvent.click(screen.getByRole('button', { name: /set baseline/i }));
    await waitFor(() => {
      expect(mockSetBaseline).toHaveBeenCalledWith(TEST_ID);
      expect(screen.getByText('baseline')).toBeInTheDocument();
    });
  });

  it('calls clearBaseline and refetches when "Clear baseline" is clicked', async () => {
    const updated = makeResult({ is_baseline: false });
    mockGetResult
      .mockResolvedValueOnce({ result: makeResult({ is_baseline: true }) })
      .mockResolvedValueOnce({ result: updated });
    mockClearBaseline.mockResolvedValue({});
    renderResultPage();
    await waitFor(() => screen.getByRole('button', { name: /clear baseline/i }));
    fireEvent.click(screen.getByRole('button', { name: /clear baseline/i }));
    await waitFor(() => {
      expect(mockClearBaseline).toHaveBeenCalledWith(TEST_ID);
      expect(screen.queryByText('baseline')).not.toBeInTheDocument();
    });
  });

  it('shows PDF and CSV download links for a completed test', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult() });
    renderResultPage();
    await waitFor(() => {
      const pdfLink = screen.getByRole('link', { name: /pdf/i });
      const csvLink = screen.getByRole('link', { name: /csv/i });
      expect(pdfLink).toHaveAttribute('href', expect.stringContaining(`/results/${TEST_ID}/report.pdf`));
      expect(csvLink).toHaveAttribute('href', expect.stringContaining(`/results/${TEST_ID}/report.csv`));
    });
  });

  it('shows Re-run link pointing to home with rerun param', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult() });
    renderResultPage();
    await waitFor(() => {
      const rerunLink = screen.getByRole('link', { name: /re-run/i });
      expect(rerunLink).toHaveAttribute('href', `/?rerun=${TEST_ID}`);
    });
  });

  it('shows "script reused" badge when reused_script is true', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult({ reused_script: true }) });
    renderResultPage();
    await waitFor(() => expect(screen.getByText('script reused')).toBeInTheDocument());
  });
});

// ─── Running / pending state ──────────────────────────────────────────────────

describe('ResultDetailPage — running / pending state', () => {
  it('shows Stop button for a running test', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult({ status: 'running', metrics: null }) });
    renderResultPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /^stop$/i })).toBeInTheDocument());
  });

  it('shows Stop button for a pending test', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult({ status: 'pending', metrics: null }) });
    renderResultPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /^stop$/i })).toBeInTheDocument());
  });

  it('does not show Set baseline button for a running test', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult({ status: 'running', metrics: null }) });
    renderResultPage();
    await waitFor(() => screen.getByRole('button', { name: /^stop$/i }));
    expect(screen.queryByRole('button', { name: /baseline/i })).not.toBeInTheDocument();
  });

  it('calls cancelTest when Stop is clicked', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult({ status: 'running', metrics: null }) });
    mockCancelTest.mockResolvedValue({});
    renderResultPage();
    await waitFor(() => screen.getByRole('button', { name: /^stop$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^stop$/i }));
    await waitFor(() => expect(mockCancelTest).toHaveBeenCalledWith(TEST_ID));
  });

  it('shows "Waiting in queue…" for a pending test', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult({ status: 'pending', metrics: null }) });
    renderResultPage();
    await waitFor(() => expect(screen.getByText(/Waiting in queue/i)).toBeInTheDocument());
  });

  it('shows the Live Metrics card for a running backend test even before any live point has arrived', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult({ status: 'running', type: 'backend', metrics: null }) });
    mockGetLiveMetrics.mockResolvedValue({ points: [] });
    renderResultPage();
    await waitFor(() => expect(screen.getByText('Live Metrics')).toBeInTheDocument());
    expect(screen.getByTestId('realtime-chart')).toBeInTheDocument();
  });

  it('does not show the Live Metrics card for a pending test with no live points yet', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult({ status: 'pending', type: 'backend', metrics: null }) });
    mockGetLiveMetrics.mockResolvedValue({ points: [] });
    renderResultPage();
    await waitFor(() => screen.getByText(/Waiting in queue/i));
    expect(screen.queryByText('Live Metrics')).not.toBeInTheDocument();
  });

  it('shows status_message when present on a pending test', async () => {
    mockGetResult.mockResolvedValue({
      result: makeResult({ status: 'pending', metrics: null, status_message: 'Generating test script with AI…' }),
    });
    renderResultPage();
    await waitFor(() => expect(screen.getByText('Generating test script with AI…')).toBeInTheDocument());
  });
});

// ─── Failed / cancelled state ─────────────────────────────────────────────────

describe('ResultDetailPage — failed / cancelled state', () => {
  it('shows "Test failed" message when there are no metrics on a failed test', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult({ status: 'failed', metrics: null }) });
    renderResultPage();
    await waitFor(() => expect(screen.getByText(/no metrics collected/i)).toBeInTheDocument());
  });

  it('shows cancelled status badge', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult({ status: 'cancelled', metrics: null }) });
    renderResultPage();
    await waitFor(() => expect(screen.getByText('cancelled')).toBeInTheDocument());
  });
});

// ─── Client-side test ────────────────────────────────────────────────────────

describe('ResultDetailPage — client-side test', () => {
  it('shows LCP, FCP, TTFB, CLS metric cells for a client-side test', async () => {
    mockGetResult.mockResolvedValue({
      result: makeResult({ type: 'client-side', metrics: makeClientMetrics() }),
    });
    renderResultPage();
    await waitFor(() => {
      expect(screen.getByText('1800')).toBeInTheDocument(); // LCP
      expect(screen.getByText('900')).toBeInTheDocument();  // FCP
      expect(screen.getByText('200')).toBeInTheDocument();  // TTFB
      expect(screen.getByText('0.050')).toBeInTheDocument(); // CLS
    });
  });

  it('renders the ClientChart component for a client-side result', async () => {
    mockGetResult.mockResolvedValue({
      result: makeResult({ type: 'client-side', metrics: makeClientMetrics() }),
    });
    renderResultPage();
    await waitFor(() => expect(screen.getByTestId('client-chart')).toBeInTheDocument());
  });
});

// ─── Analysis panel ───────────────────────────────────────────────────────────

describe('ResultDetailPage — analysis panel', () => {
  it('renders the AnalysisPanel when result has analysis data', async () => {
    const analysis = { perfStatus: 'passed', violations: [], diffs: [] };
    mockGetResult.mockResolvedValue({ result: makeResult({ analysis }) });
    renderResultPage();
    await waitFor(() => expect(screen.getByTestId('analysis-panel')).toBeInTheDocument());
  });

  it('does not render AnalysisPanel when analysis is null', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult({ analysis: null }) });
    renderResultPage();
    await waitFor(() => screen.getByText('http://example.com'));
    expect(screen.queryByTestId('analysis-panel')).not.toBeInTheDocument();
  });
});

// ─── Execution log panel ─────────────────────────────────────────────────────

describe('ResultDetailPage — Execution Log panel', () => {
  it('renders collapsed by default (no log content visible)', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult() });
    renderResultPage();
    await waitFor(() => screen.getByText('http://example.com'));
    // Panel header should be visible
    expect(screen.getByText('Execution Log')).toBeInTheDocument();
    // Log content should not be visible yet (panel is collapsed)
    expect(screen.queryByRole('button', { name: /copy/i })).not.toBeInTheDocument();
  });

  it('fetches and displays the log when the panel is opened', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult() });
    mockGetExecutionLog.mockResolvedValue({ log: '[INFO] Starting browser test\n[INFO] Complete' });
    renderResultPage();
    await waitFor(() => screen.getByText('Execution Log'));
    fireEvent.click(screen.getByText('Execution Log'));
    await waitFor(() => {
      expect(mockGetExecutionLog).toHaveBeenCalledWith(TEST_ID);
      expect(screen.getByText(/Starting browser test/)).toBeInTheDocument();
    });
  });

  it('shows "No execution log recorded" when log is null', async () => {
    mockGetResult.mockResolvedValue({ result: makeResult() });
    mockGetExecutionLog.mockResolvedValue({ log: null });
    renderResultPage();
    await waitFor(() => screen.getByText('Execution Log'));
    fireEvent.click(screen.getByText('Execution Log'));
    await waitFor(() => expect(screen.getByText(/No execution log recorded/i)).toBeInTheDocument());
  });
});
