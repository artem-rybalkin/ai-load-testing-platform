// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
