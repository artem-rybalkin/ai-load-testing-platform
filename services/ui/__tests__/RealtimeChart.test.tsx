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

import RealtimeChart from '../app/components/RealtimeChart';
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
});
