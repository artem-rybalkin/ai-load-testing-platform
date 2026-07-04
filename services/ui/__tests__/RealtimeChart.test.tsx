// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
afterEach(() => cleanup());

// Recharts uses ResizeObserver and SVG which are unavailable in jsdom.
// The chart titles we assert on are plain <span> elements outside the chart
// primitives, so it's safe to stub the entire library to null renderers.
vi.mock('recharts', () => ({
  LineChart:           () => null,
  Line:                () => null,
  XAxis:               () => null,
  YAxis:               () => null,
  CartesianGrid:       () => null,
  Tooltip:             () => null,
  ResponsiveContainer: () => null,
}));

import RealtimeChart, { toKey, labelFor, fmtElapsed } from '../app/components/RealtimeChart';
import type { LiveMetricPoint } from '@/lib/api';

const basePoint = (overrides?: Partial<LiveMetricPoint>): LiveMetricPoint => ({
  timestamp:       '2024-01-01T00:00:05.000Z',
  vus:             10,
  rps:             5,
  avgResponseTime: 120,
  errorRate:       0,
  ...overrides,
});

const steps = (rt: number, rps: number, err: number) => [
  { name: 'Step 1: Login',  avgResponseTime: rt,  rps, errorRate: err },
  { name: 'Step 2: Browse', avgResponseTime: rt,  rps, errorRate: err },
];

describe('RealtimeChart — chart titles with step metrics', () => {
  // ── Per-step titles always shown when steps exist ─────────────────────────

  it('shows "Response Time per Step" when steps have non-zero avgResponseTime', () => {
    render(<RealtimeChart points={[basePoint({ stepMetrics: steps(150, 5, 0) })]} />);
    expect(screen.getByText('Response Time per Step')).toBeInTheDocument();
  });

  it('shows "Response Time per Step" even when all step avgResponseTime values are 0', () => {
    render(<RealtimeChart points={[basePoint({ stepMetrics: steps(0, 5, 0) })]} />);
    expect(screen.getByText('Response Time per Step')).toBeInTheDocument();
    expect(screen.queryByText(/^Response Time$/)).not.toBeInTheDocument();
  });

  it('shows "Error Rate per Step" when steps have non-zero error rates', () => {
    render(<RealtimeChart points={[basePoint({ stepMetrics: steps(150, 5, 3.5) })]} />);
    expect(screen.getByText('Error Rate per Step')).toBeInTheDocument();
  });

  it('shows "Error Rate per Step" even when all step error rates are 0 (happy path)', () => {
    // All three charts must be consistent — no chart falls back to aggregate
    // just because values happen to be zero on a happy-path run.
    render(<RealtimeChart points={[basePoint({ stepMetrics: steps(150, 5, 0) })]} />);
    expect(screen.getByText('Error Rate per Step')).toBeInTheDocument();
    expect(screen.queryByText('VUs & Error Rate')).not.toBeInTheDocument();
  });

  it('shows "Throughput per Step" when steps have non-zero rps', () => {
    render(<RealtimeChart points={[basePoint({ stepMetrics: steps(150, 5, 0) })]} />);
    expect(screen.getByText('Throughput per Step')).toBeInTheDocument();
  });

  it('shows "Throughput per Step" even when all step rps values are 0', () => {
    render(<RealtimeChart points={[basePoint({ stepMetrics: steps(150, 0, 0) })]} />);
    expect(screen.getByText('Throughput per Step')).toBeInTheDocument();
    expect(screen.queryByText(/^Throughput$/)).not.toBeInTheDocument();
  });

  // ── Aggregate titles shown when there are no step metrics ─────────────────

  it('shows all aggregate titles when there are no step metrics', () => {
    render(<RealtimeChart points={[basePoint()]} />);
    expect(screen.getByText('Response Time')).toBeInTheDocument();
    expect(screen.getByText('VUs & Error Rate')).toBeInTheDocument();
    expect(screen.getByText('Throughput')).toBeInTheDocument();
  });

  // ── Aggregate error-rate legend (VUs, total/4xx/5xx are otherwise indistinguishable
  // when errors are all one status class, since the lines then overlap exactly) ──

  it('shows a legend identifying VUs, total, 4xx and 5xx lines in the aggregate view', () => {
    render(<RealtimeChart points={[basePoint({ errorRate: 20, clientErrorRate: 20, serverErrorRate: 0 })]} />);
    expect(screen.getByText('VUs')).toBeInTheDocument();
    expect(screen.getByText('Client error (4xx)')).toBeInTheDocument();
    expect(screen.getByText('Server error (5xx)')).toBeInTheDocument();
    expect(screen.getByText('Error rate (total)')).toBeInTheDocument();
  });

  it('does not show the aggregate error-rate legend when steps are present', () => {
    render(<RealtimeChart points={[basePoint({ stepMetrics: steps(150, 5, 3.5) })]} />);
    expect(screen.queryByText('Error rate (total)')).not.toBeInTheDocument();
  });
});

// ─── toKey ──────────────────────────────────────────────────────────────────────

describe('toKey', () => {
  it('leaves alphanumeric and underscore characters unchanged', () => {
    expect(toKey('Step1_Login')).toBe('Step1_Login');
  });

  it('replaces spaces and punctuation with underscores', () => {
    expect(toKey('Step 1: Login')).toBe('Step_1__Login');
  });

  it('replaces special characters like dashes and slashes', () => {
    expect(toKey('GET /api/users-list')).toBe('GET__api_users_list');
  });

  it('returns an empty string unchanged', () => {
    expect(toKey('')).toBe('');
  });
});

// ─── labelFor ───────────────────────────────────────────────────────────────────

describe('labelFor', () => {
  const names = ['Step 1: Login', 'Step 2: Browse'];

  it('strips the prefix and resolves the original step name', () => {
    const raw = `avg_${toKey('Step 1: Login')}`;
    expect(labelFor(names, 'avg', raw)).toBe('Step 1: Login');
  });

  it('resolves a different step for a different prefix', () => {
    const raw = `err_${toKey('Step 2: Browse')}`;
    expect(labelFor(names, 'err', raw)).toBe('Step 2: Browse');
  });

  it('falls back to the raw name when no step matches', () => {
    const raw = 'rps_unknown_step';
    expect(labelFor(names, 'rps', raw)).toBe(raw);
  });

  it('handles a rawName that does not start with the given prefix', () => {
    const raw = toKey('Step 1: Login'); // no "avg_" prefix
    // Regex replace of "^avg_" won't match, so key stays as the full toKey value.
    expect(labelFor(names, 'avg', raw)).toBe('Step 1: Login');
  });
});

// ─── fmtElapsed ─────────────────────────────────────────────────────────────────

describe('fmtElapsed', () => {
  it('formats elapsed seconds under a minute as "Ns"', () => {
    expect(fmtElapsed('2024-01-01T00:00:30.000Z', '2024-01-01T00:00:00.000Z')).toBe('30s');
  });

  it('formats elapsed time at exactly 60s as "1m"', () => {
    expect(fmtElapsed('2024-01-01T00:01:00.000Z', '2024-01-01T00:00:00.000Z')).toBe('1m');
  });

  it('formats elapsed time over a minute with remaining seconds as "XmYYs"', () => {
    expect(fmtElapsed('2024-01-01T00:01:05.000Z', '2024-01-01T00:00:00.000Z')).toBe('1m05s');
  });

  it('formats elapsed time with double-digit remaining seconds', () => {
    expect(fmtElapsed('2024-01-01T00:02:45.000Z', '2024-01-01T00:00:00.000Z')).toBe('2m45s');
  });

  it('falls back to wall-clock time when startedAt is not provided', () => {
    const iso = '2024-01-01T12:34:56.000Z';
    const expected = new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    expect(fmtElapsed(iso)).toBe(expected);
  });

  it('falls back to wall-clock time when startedAt is null', () => {
    const iso = '2024-01-01T12:34:56.000Z';
    const expected = new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    expect(fmtElapsed(iso, null)).toBe(expected);
  });
});

// ─── Render performance ───────────────────────────────────────────────────────

describe('RealtimeChart — render performance', () => {
  it('renders 500 points with 7-step stepMetrics within budget', () => {
    const stepNames = Array.from({ length: 7 }, (_, i) => `Step ${i + 1}: Action`);
    const points: LiveMetricPoint[] = Array.from({ length: 500 }, (_, i) => ({
      timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, i * 5)).toISOString(),
      vus: 10,
      rps: 5 + (i % 10),
      avgResponseTime: 100 + (i % 50),
      errorRate: i % 3,
      stepMetrics: stepNames.map((name, si) => ({
        name,
        avgResponseTime: 100 + si * 10 + (i % 20),
        rps: 1 + si,
        errorRate: (i + si) % 4,
      })),
    }));

    const start = performance.now();
    expect(() => render(<RealtimeChart points={points} startedAt="2024-01-01T00:00:00.000Z" />)).not.toThrow();
    const elapsed = performance.now() - start;

    expect(screen.getByText('Response Time per Step')).toBeInTheDocument();
    expect(elapsed).toBeLessThan(1000);
  });
});
