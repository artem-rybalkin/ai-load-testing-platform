// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
afterEach(() => cleanup());

// Recharts uses ResizeObserver and SVG which are unavailable in jsdom.
// The headings/labels we assert on are plain elements outside the chart
// primitives, so it's safe to stub the entire library to null renderers.
vi.mock('recharts', () => ({
  BarChart:            () => null,
  Bar:                 () => null,
  XAxis:               () => null,
  YAxis:               () => null,
  CartesianGrid:       () => null,
  Tooltip:             () => null,
  ResponsiveContainer: () => null,
  Cell:                () => null,
}));

import BackendChart from '../app/components/BackendChart';

const baseMetrics = {
  requestsTotal:   1000,
  requestsFailed:  20,
  avgResponseTime: 150.4,
  p95ResponseTime: 380.6,
  p99ResponseTime: 600.2,
  rps:             42.3,
};

describe('BackendChart — section headings', () => {
  it('renders all three section headings', () => {
    render(<BackendChart metrics={baseMetrics} />);
    expect(screen.getByText('Response Time')).toBeInTheDocument();
    expect(screen.getByText('Request breakdown')).toBeInTheDocument();
    expect(screen.getByText('Throughput')).toBeInTheDocument();
  });
});

describe('BackendChart — error rate', () => {
  it('computes and displays the error rate percentage to 2 decimal places', () => {
    render(<BackendChart metrics={baseMetrics} />);
    expect(screen.getByText('Error rate: 2.00%')).toBeInTheDocument();
  });

  it('shows 0% error rate when requestsFailed is 0', () => {
    render(<BackendChart metrics={{ ...baseMetrics, requestsFailed: 0 }} />);
    expect(screen.getByText('Error rate: 0.00%')).toBeInTheDocument();
  });

  it('falls back to "0" (not NaN/Infinity) when requestsTotal is 0', () => {
    render(<BackendChart metrics={{ ...baseMetrics, requestsTotal: 0, requestsFailed: 0 }} />);
    expect(screen.getByText('Error rate: 0%')).toBeInTheDocument();
  });

  it('shows 100% error rate when every request failed', () => {
    render(<BackendChart metrics={{ ...baseMetrics, requestsTotal: 10, requestsFailed: 10 }} />);
    expect(screen.getByText('Error rate: 100.00%')).toBeInTheDocument();
  });
});

describe('BackendChart — throughput', () => {
  it('displays rps rounded to 1 decimal place', () => {
    render(<BackendChart metrics={baseMetrics} />);
    expect(screen.getByText('42.3')).toBeInTheDocument();
    expect(screen.getByText('req/sec')).toBeInTheDocument();
  });

  it('renders the 100-rps baseline caption', () => {
    render(<BackendChart metrics={baseMetrics} />);
    expect(screen.getByText('relative to 100 rps baseline')).toBeInTheDocument();
  });
});

describe('BackendChart — render safety', () => {
  it('renders without throwing when all metrics are zero', () => {
    const zero = { requestsTotal: 0, requestsFailed: 0, avgResponseTime: 0, p95ResponseTime: 0, p99ResponseTime: 0, rps: 0 };
    expect(() => render(<BackendChart metrics={zero} />)).not.toThrow();
  });
});
