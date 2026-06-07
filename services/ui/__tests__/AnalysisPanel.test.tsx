// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
afterEach(() => cleanup());
import AnalysisPanel from '../app/components/AnalysisPanel';

const passed = {
  perfStatus: 'passed',
  summary: 'Performance is within acceptable thresholds',
  diffs: [],
  thresholdViolations: [],
};

const failed = {
  perfStatus: 'failed',
  summary: 'Performance issues detected: p95 response time 1500ms exceeds threshold 1000ms',
  diffs: [],
  thresholdViolations: ['p95 response time 1500ms exceeds threshold 1000ms'],
};

const degraded = {
  perfStatus: 'degraded',
  summary: 'Performance has degraded compared to previous run',
  diffs: [
    {
      metric: 'Avg response time',
      current: 300,
      previous: 200,
      diffPercent: 50,
      status: 'worse' as const,
    },
  ],
  thresholdViolations: [],
};

const withInsights = {
  perfStatus: 'degraded',
  summary: 'Performance has degraded compared to previous run',
  diffs: [],
  thresholdViolations: [],
  aiInsights: {
    narrative: 'The API response times have increased due to elevated DB query latency.',
    anomalies: ['p99 spike at the 60s mark'],
    rootCauses: ['Unindexed query in orders table'],
    recommendations: ['Add index on orders.created_at', 'Enable query result caching'],
    severity: 'warning' as const,
  },
};

describe('AnalysisPanel', () => {
  it('renders Passed badge and summary for passing analysis', () => {
    render(<AnalysisPanel analysis={passed} />);
    expect(screen.getByText('Passed')).toBeInTheDocument();
    expect(screen.getByText('Performance is within acceptable thresholds')).toBeInTheDocument();
  });

  it('renders Failed badge for failed analysis', () => {
    render(<AnalysisPanel analysis={failed} />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('renders Degraded badge for degraded analysis', () => {
    render(<AnalysisPanel analysis={degraded} />);
    expect(screen.getByText('Degraded')).toBeInTheDocument();
  });

  it('lists each threshold violation', () => {
    render(<AnalysisPanel analysis={failed} />);
    // Text appears in both the summary and the violation list; check the list header too
    expect(screen.getByText('Threshold violations:')).toBeInTheDocument();
    const matches = screen.getAllByText(/p95 response time 1500ms exceeds threshold 1000ms/);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('shows no threshold violations section when violations list is empty', () => {
    render(<AnalysisPanel analysis={passed} />);
    expect(screen.queryByText('Threshold violations:')).not.toBeInTheDocument();
  });

  it('renders diff rows with metric name and current value', () => {
    render(<AnalysisPanel analysis={degraded} />);
    expect(screen.getByText('Avg response time')).toBeInTheDocument();
    expect(screen.getByText('300')).toBeInTheDocument();
    expect(screen.getByText('200')).toBeInTheDocument();
  });

  it('shows "no previous run" message when diffs are empty', () => {
    render(<AnalysisPanel analysis={passed} />);
    expect(screen.getByText('No previous run found for comparison')).toBeInTheDocument();
  });

  it('hides "no previous run" message when diffs are present', () => {
    render(<AnalysisPanel analysis={degraded} />);
    expect(screen.queryByText('No previous run found for comparison')).not.toBeInTheDocument();
  });

  it('shows "Compared to previous run" section header when diffs are present', () => {
    render(<AnalysisPanel analysis={degraded} />);
    expect(screen.getByText('Compared to previous run:')).toBeInTheDocument();
  });
});

describe('AnalysisPanel — AI Insights section', () => {
  it('renders AI Insights toggle when aiInsights is present', () => {
    render(<AnalysisPanel analysis={withInsights} />);
    expect(screen.getByText('AI Insights')).toBeInTheDocument();
  });

  it('does not render AI Insights section when aiInsights is absent', () => {
    render(<AnalysisPanel analysis={passed} />);
    expect(screen.queryByText('AI Insights')).not.toBeInTheDocument();
  });

  it('narrative is not visible before expanding the panel', () => {
    render(<AnalysisPanel analysis={withInsights} />);
    expect(screen.queryByText(withInsights.aiInsights.narrative)).not.toBeInTheDocument();
  });

  it('expanding the panel reveals the narrative', async () => {
    const { getByText } = render(<AnalysisPanel analysis={withInsights} />);
    const toggle = getByText('AI Insights').closest('button')!;
    fireEvent.click(toggle);
    expect(screen.getByText(withInsights.aiInsights.narrative)).toBeInTheDocument();
  });

  it('expanding shows anomalies', async () => {
    render(<AnalysisPanel analysis={withInsights} />);
    fireEvent.click(screen.getByText('AI Insights').closest('button')!);
    expect(screen.getByText('p99 spike at the 60s mark')).toBeInTheDocument();
  });

  it('expanding shows root causes', async () => {
    render(<AnalysisPanel analysis={withInsights} />);
    fireEvent.click(screen.getByText('AI Insights').closest('button')!);
    expect(screen.getByText('Unindexed query in orders table')).toBeInTheDocument();
  });

  it('expanding shows recommendations', async () => {
    render(<AnalysisPanel analysis={withInsights} />);
    fireEvent.click(screen.getByText('AI Insights').closest('button')!);
    expect(screen.getByText('Add index on orders.created_at')).toBeInTheDocument();
    expect(screen.getByText('Enable query result caching')).toBeInTheDocument();
  });

  it('collapses again when toggle is clicked a second time', async () => {
    render(<AnalysisPanel analysis={withInsights} />);
    const btn = screen.getByText('AI Insights').closest('button')!;
    fireEvent.click(btn); // expand
    expect(screen.getByText(withInsights.aiInsights.narrative)).toBeInTheDocument();
    fireEvent.click(btn); // collapse
    expect(screen.queryByText(withInsights.aiInsights.narrative)).not.toBeInTheDocument();
  });

  it('shows a preview snippet of the narrative in the collapsed header', () => {
    render(<AnalysisPanel analysis={withInsights} />);
    // The collapsed header truncates to 60 chars — the first 60 chars of the narrative should appear
    const preview = withInsights.aiInsights.narrative.slice(0, 60);
    expect(screen.getByText(new RegExp(preview.slice(0, 30)))).toBeInTheDocument();
  });

  it('does not show anomalies section when anomalies array is empty', () => {
    const noAnomalies = {
      ...withInsights,
      aiInsights: { ...withInsights.aiInsights, anomalies: [] },
    };
    render(<AnalysisPanel analysis={noAnomalies} />);
    fireEvent.click(screen.getByText('AI Insights').closest('button')!);
    expect(screen.queryByText('Anomalies detected')).not.toBeInTheDocument();
  });
});
