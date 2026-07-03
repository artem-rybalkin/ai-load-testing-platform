// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
afterEach(() => cleanup());

// Recharts uses ResizeObserver and SVG which are unavailable in jsdom.
// FlowStepChart has no plain-text output of its own outside the chart, so
// BarChart is mocked to dump its `data` prop into the DOM as JSON — this lets
// us assert on the name-truncation/rounding transform in FlowStepChart.tsx
// without needing a real chart renderer.
vi.mock('recharts', () => ({
  BarChart: ({ data, children }: { data: unknown; children?: ReactNode }) => (
    <div data-testid="chart-data">{JSON.stringify(data)}{children}</div>
  ),
  Bar:                 () => null,
  XAxis:               () => null,
  YAxis:               () => null,
  CartesianGrid:       () => null,
  Tooltip:             () => null,
  Legend:              () => null,
  ResponsiveContainer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Cell:                () => null,
}));

import FlowStepChart from '../app/components/FlowStepChart';

const getChartData = (): Array<{ name: string; fullName: string; avg: number; p95: number }> =>
  JSON.parse(screen.getByTestId('chart-data').textContent || '[]');

describe('FlowStepChart — heading', () => {
  it('renders the section heading and unit label', () => {
    render(<FlowStepChart steps={[{ name: 'Login', avgResponseTime: 100, p95ResponseTime: 200, requestsTotal: 5, requestsFailed: 0 }]} />);
    expect(screen.getByText('Response Time per Step')).toBeInTheDocument();
    expect(screen.getByText('ms')).toBeInTheDocument();
  });
});

describe('FlowStepChart — data transform', () => {
  it('rounds avg and p95 response times', () => {
    render(<FlowStepChart steps={[{ name: 'Login', avgResponseTime: 150.6, p95ResponseTime: 299.4, requestsTotal: 5, requestsFailed: 0 }]} />);
    const [row] = getChartData();
    expect(row.avg).toBe(151);
    expect(row.p95).toBe(299);
  });

  it('keeps short step names unchanged', () => {
    render(<FlowStepChart steps={[{ name: 'Login', avgResponseTime: 1, p95ResponseTime: 1, requestsTotal: 1, requestsFailed: 0 }]} />);
    const [row] = getChartData();
    expect(row.name).toBe('Login');
    expect(row.fullName).toBe('Login');
  });

  it('truncates step names longer than 20 chars with an ellipsis, preserving fullName', () => {
    const longName = 'Step 3: POST /api/checkout/complete';
    render(<FlowStepChart steps={[{ name: longName, avgResponseTime: 1, p95ResponseTime: 1, requestsTotal: 1, requestsFailed: 0 }]} />);
    const [row] = getChartData();
    expect(row.name).toBe(longName.slice(0, 18) + '…');
    expect(row.name.length).toBe(19);
    expect(row.fullName).toBe(longName);
  });

  it('does not truncate a name at exactly 20 chars', () => {
    const exact20 = 'A'.repeat(20);
    render(<FlowStepChart steps={[{ name: exact20, avgResponseTime: 1, p95ResponseTime: 1, requestsTotal: 1, requestsFailed: 0 }]} />);
    const [row] = getChartData();
    expect(row.name).toBe(exact20);
  });

  it('preserves step order across multiple steps', () => {
    render(<FlowStepChart steps={[
      { name: 'Step 1', avgResponseTime: 100, p95ResponseTime: 150, requestsTotal: 1, requestsFailed: 0 },
      { name: 'Step 2', avgResponseTime: 200, p95ResponseTime: 250, requestsTotal: 1, requestsFailed: 0 },
      { name: 'Step 3', avgResponseTime: 300, p95ResponseTime: 350, requestsTotal: 1, requestsFailed: 0 },
    ]} />);
    const data = getChartData();
    expect(data.map(d => d.fullName)).toEqual(['Step 1', 'Step 2', 'Step 3']);
  });

  it('renders an empty chart without throwing when steps is empty', () => {
    expect(() => render(<FlowStepChart steps={[]} />)).not.toThrow();
    expect(getChartData()).toEqual([]);
  });
});
