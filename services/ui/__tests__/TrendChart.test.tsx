// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
afterEach(() => cleanup());

// Recharts uses ResizeObserver and SVG which are unavailable in jsdom.
// TrendChart has no plain-text output of its own outside the chart, so
// LineChart is mocked to dump its `data` prop into the DOM as JSON, and Line
// is mocked to invoke its `dot` render-prop for each point and expose the
// resulting fill color — this lets us assert on the run-numbering/rounding/
// date-formatting transform and the perf_status → dot-color mapping in
// TrendChart.tsx without needing a real chart renderer.
vi.mock('recharts', () => ({
  LineChart: ({ data, children }: { data: unknown; children?: ReactNode }) => (
    <div data-testid="chart-data">{JSON.stringify(data)}{children}</div>
  ),
  Line: ({ dataKey, dot, name }: {
    dataKey: string;
    name: string;
    dot: (props: { cx: number; cy: number; payload: unknown }) => ReactNode;
  }) => (
    <div data-testid="line" data-key={dataKey} data-name={name}>
      {/* Invoke the dot render-prop for a couple of fixed points so tests can
          inspect the resulting element's fill color per perf_status. */}
      <div data-testid="dot-passed">{dot({ cx: 0, cy: 0, payload: { perf_status: 'passed' } })}</div>
      <div data-testid="dot-degraded">{dot({ cx: 0, cy: 0, payload: { perf_status: 'degraded' } })}</div>
      <div data-testid="dot-failed">{dot({ cx: 0, cy: 0, payload: { perf_status: 'failed' } })}</div>
      <div data-testid="dot-unknown">{dot({ cx: 0, cy: 0, payload: {} })}</div>
    </div>
  ),
  XAxis:               () => null,
  YAxis:               () => null,
  CartesianGrid:       () => null,
  Tooltip:             () => null,
  ResponsiveContainer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import TrendChart from '../app/components/TrendChart';
import type { TrendPoint } from '@/lib/api';

// LineChart's children (including <Line>'s dot circles) render no text nodes
// of their own, so chart-data's textContent is exactly the JSON.stringify(data) call.
const getChartData = (): Array<{ run: string; value: number; perf_status?: string; date: string }> =>
  JSON.parse(screen.getByTestId('chart-data').textContent || '[]');

const makePoint = (overrides: Partial<TrendPoint> = {}): TrendPoint => ({
  test_id: 'test-id',
  type: 'backend',
  created_at: '2024-03-01T12:00:00.000Z',
  perf_status: 'passed',
  metrics: { p95ResponseTime: 400.6 },
  ...overrides,
});

describe('TrendChart — data transform', () => {
  it('labels runs sequentially starting at #1', () => {
    render(<TrendChart trend={[makePoint(), makePoint(), makePoint()]} />);
    const data = getChartData();
    expect(data.map(d => d.run)).toEqual(['#1', '#2', '#3']);
  });

  it('rounds the metric value', () => {
    render(<TrendChart trend={[makePoint({ metrics: { p95ResponseTime: 123.6 } })]} />);
    expect(getChartData()[0].value).toBe(124);
  });

  it('defaults to p95ResponseTime when no metricKey is given', () => {
    render(<TrendChart trend={[makePoint({ metrics: { p95ResponseTime: 500, avgResponseTime: 100 } })]} />);
    expect(getChartData()[0].value).toBe(500);
  });

  it('reads the given metricKey instead of the default', () => {
    render(<TrendChart trend={[makePoint({ metrics: { p95ResponseTime: 500, lcp: 2200.4 } })]} metricKey="lcp" />);
    expect(getChartData()[0].value).toBe(2200);
  });

  it('defaults missing metric values to 0', () => {
    render(<TrendChart trend={[makePoint({ metrics: {} })]} />);
    expect(getChartData()[0].value).toBe(0);
  });

  it('formats created_at as a locale date string', () => {
    render(<TrendChart trend={[makePoint({ created_at: '2024-03-01T12:00:00.000Z' })]} />);
    expect(getChartData()[0].date).toBe(new Date('2024-03-01T12:00:00.000Z').toLocaleDateString());
  });

  it('renders an empty chart without throwing for an empty trend', () => {
    expect(() => render(<TrendChart trend={[]} />)).not.toThrow();
    expect(getChartData()).toEqual([]);
  });
});

describe('TrendChart — Line props', () => {
  it('uses the custom label as the series name when provided', () => {
    render(<TrendChart trend={[makePoint()]} label="LCP (ms)" />);
    expect(screen.getByTestId('line')).toHaveAttribute('data-name', 'LCP (ms)');
  });

  it('defaults the label to "p95 (ms)"', () => {
    render(<TrendChart trend={[makePoint()]} />);
    expect(screen.getByTestId('line')).toHaveAttribute('data-name', 'p95 (ms)');
  });
});

describe('TrendChart — dot color by perf_status', () => {
  it('colors a passed point green', () => {
    render(<TrendChart trend={[makePoint()]} />);
    const circle = screen.getByTestId('dot-passed').querySelector('circle');
    expect(circle).toHaveAttribute('fill', '#16a34a');
  });

  it('colors a degraded point amber', () => {
    render(<TrendChart trend={[makePoint()]} />);
    const circle = screen.getByTestId('dot-degraded').querySelector('circle');
    expect(circle).toHaveAttribute('fill', '#ca8a04');
  });

  it('colors a failed point red', () => {
    render(<TrendChart trend={[makePoint()]} />);
    const circle = screen.getByTestId('dot-failed').querySelector('circle');
    expect(circle).toHaveAttribute('fill', '#dc2626');
  });

  it('defaults an unknown/missing perf_status to green', () => {
    render(<TrendChart trend={[makePoint()]} />);
    const circle = screen.getByTestId('dot-unknown').querySelector('circle');
    expect(circle).toHaveAttribute('fill', '#16a34a');
  });
});
