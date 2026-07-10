// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { createRoutesStub, useRouteError } from 'react-router';
import ComparePage, { loader } from '../app/results/compare/page';
import type { TestResult } from '../lib/api';

const mockCompareResults = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  compareResults: mockCompareResults,
}));

// A minimal error-boundary stand-in for the real app's RouteErrorBoundary
// (services/ui/app/components/ErrorBoundary.tsx), which also just renders
// useRouteError()'s message — the loader throws for missing params or a
// failed fetch, so these tests need a router-level error boundary to observe
// that message, same as production.
function TestErrorBoundary() {
  const error = useRouteError();
  return <div>{error instanceof Error ? error.message : String(error)}</div>;
}

function renderAt(path: string) {
  const Stub = createRoutesStub([
    { path: '/results/compare', Component: ComparePage, loader, HydrateFallback: () => null, ErrorBoundary: TestErrorBoundary },
  ]);
  return render(<Stub initialEntries={[path]} />);
}

const makeResult = (overrides: Partial<TestResult> = {}): TestResult => ({
  id: 'r1',
  test_id: 't1',
  type: 'backend',
  target_url: 'https://example.com',
  status: 'completed',
  metrics: {
    type: 'backend' as const,
    avgResponseTime: 100,
    p50ResponseTime: 90,
    p95ResponseTime: 200,
    p99ResponseTime: 250,
    rps: 50,
    requestsTotal: 1000,
    requestsFailed: 10,
  },
  script: null,
  script_description: null,
  reused_script: false,
  is_baseline: false,
  duration_seconds: 30,
  started_at: '2024-01-01T00:00:00.000Z',
  completed_at: '2024-01-01T00:01:00.000Z',
  created_at: '2024-01-01T00:00:00.000Z',
  perf_status: 'passed',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('ComparePage — missing params', () => {
  it('shows an error when a/b params are missing', async () => {
    renderAt('/results/compare');
    await waitFor(() => expect(screen.getByText('Provide ?a=<id>&b=<id> in the URL')).toBeInTheDocument());
    expect(mockCompareResults).not.toHaveBeenCalled();
  });

  it('shows an error when only one param is present', async () => {
    renderAt('/results/compare?a=t1');
    await waitFor(() => expect(screen.getByText('Provide ?a=<id>&b=<id> in the URL')).toBeInTheDocument());
    expect(mockCompareResults).not.toHaveBeenCalled();
  });
});

describe('ComparePage — successful comparison', () => {
  it('renders backend metrics table with perf badges and result links', async () => {
    mockCompareResults.mockResolvedValue({
      resultA: makeResult({ test_id: 't1', perf_status: 'passed' }),
      resultB: makeResult({ test_id: 't2', perf_status: 'degraded', metrics: {
        type: 'backend' as const,
        avgResponseTime: 150, p50ResponseTime: 130, p95ResponseTime: 300, p99ResponseTime: 400,
        rps: 40, requestsTotal: 900, requestsFailed: 30,
      } }),
    });
    renderAt('/results/compare?a=t1&b=t2');

    await waitFor(() => expect(screen.getByText('Compare Runs')).toBeInTheDocument());
    expect(mockCompareResults).toHaveBeenCalledWith('t1', 't2');

    expect(screen.getByText('Avg response time')).toBeInTheDocument();
    expect(screen.getByText('Requests/sec')).toBeInTheDocument();
    expect(screen.getByText('passed')).toBeInTheDocument();
    expect(screen.getByText('degraded')).toBeInTheDocument();

    expect(screen.getByText('View result A →').closest('a')).toHaveAttribute('href', '/results/t1');
    expect(screen.getByText('View result B →').closest('a')).toHaveAttribute('href', '/results/t2');
  });

  it('renders client metrics table for client-side results', async () => {
    mockCompareResults.mockResolvedValue({
      resultA: makeResult({ type: 'client-side', metrics: { type: 'client' as const, lcp: 2000, fcp: 1000, ttfb: 500, fid: 50, cls: 0.05 } }),
      resultB: makeResult({ type: 'client-side', metrics: { type: 'client' as const, lcp: 2500, fcp: 1200, ttfb: 600, fid: 80, cls: 0.08 } }),
    });
    renderAt('/results/compare?a=t1&b=t2');

    await waitFor(() => expect(screen.getByText('LCP')).toBeInTheDocument());
    expect(screen.getByText('FCP')).toBeInTheDocument();
    expect(screen.getByText('CLS')).toBeInTheDocument();
    expect(screen.queryByText('Avg response time')).not.toBeInTheDocument();
  });
});

describe('ComparePage — error state', () => {
  it('shows an error when compareResults rejects', async () => {
    mockCompareResults.mockRejectedValue(new Error('boom'));
    renderAt('/results/compare?a=t1&b=t2');
    await waitFor(() => expect(screen.getByText('Failed to load results')).toBeInTheDocument());
  });
});
