// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
afterEach(() => cleanup());

// Recharts uses ResizeObserver and SVG which are unavailable in jsdom.
vi.mock('recharts', () => ({
  RadarChart:          () => null,
  Radar:               () => null,
  PolarGrid:           () => null,
  PolarAngleAxis:      () => null,
  ResponsiveContainer: () => null,
  Tooltip:             () => null,
}));

import ClientChart, { getVitalStatus, lhColor, lhCls } from '../app/components/ClientChart';

// ─── getVitalStatus ────────────────────────────────────────────────────────────

describe('getVitalStatus', () => {
  describe('LCP (good <= 2500, poor > 4000)', () => {
    it('returns good at and below the good threshold', () => {
      expect(getVitalStatus('lcp', 2500)).toBe('good');
      expect(getVitalStatus('lcp', 1000)).toBe('good');
    });
    it('returns needs-improvement between good and poor', () => {
      expect(getVitalStatus('lcp', 2501)).toBe('needs-improvement');
      expect(getVitalStatus('lcp', 4000)).toBe('needs-improvement');
    });
    it('returns poor above the poor threshold', () => {
      expect(getVitalStatus('lcp', 4001)).toBe('poor');
    });
  });

  describe('FCP (good <= 1800, poor > 3000)', () => {
    it('returns good at the good threshold', () => {
      expect(getVitalStatus('fcp', 1800)).toBe('good');
    });
    it('returns needs-improvement between thresholds', () => {
      expect(getVitalStatus('fcp', 1801)).toBe('needs-improvement');
      expect(getVitalStatus('fcp', 3000)).toBe('needs-improvement');
    });
    it('returns poor above the poor threshold', () => {
      expect(getVitalStatus('fcp', 3001)).toBe('poor');
    });
  });

  describe('TTFB (good <= 800, poor > 1800)', () => {
    it('returns good at the good threshold', () => {
      expect(getVitalStatus('ttfb', 800)).toBe('good');
    });
    it('returns needs-improvement between thresholds', () => {
      expect(getVitalStatus('ttfb', 801)).toBe('needs-improvement');
      expect(getVitalStatus('ttfb', 1800)).toBe('needs-improvement');
    });
    it('returns poor above the poor threshold', () => {
      expect(getVitalStatus('ttfb', 1801)).toBe('poor');
    });
  });

  describe('INP (good <= 200, poor > 500)', () => {
    it('returns good at the good threshold', () => {
      expect(getVitalStatus('inp', 200)).toBe('good');
    });
    it('returns needs-improvement between thresholds', () => {
      expect(getVitalStatus('inp', 201)).toBe('needs-improvement');
      expect(getVitalStatus('inp', 500)).toBe('needs-improvement');
    });
    it('returns poor above the poor threshold', () => {
      expect(getVitalStatus('inp', 501)).toBe('poor');
    });
  });

  describe('TBT (good <= 200, poor > 600)', () => {
    it('returns good at the good threshold', () => {
      expect(getVitalStatus('tbt', 200)).toBe('good');
    });
    it('returns needs-improvement between thresholds', () => {
      expect(getVitalStatus('tbt', 201)).toBe('needs-improvement');
      expect(getVitalStatus('tbt', 600)).toBe('needs-improvement');
    });
    it('returns poor above the poor threshold', () => {
      expect(getVitalStatus('tbt', 601)).toBe('poor');
    });
  });

  describe('CLS (unitless: good <= 0.1, poor > 0.25)', () => {
    it('returns good at and below 0.1', () => {
      expect(getVitalStatus('cls', 0.1)).toBe('good');
      expect(getVitalStatus('cls', 0)).toBe('good');
    });
    it('returns needs-improvement between 0.1 and 0.25', () => {
      expect(getVitalStatus('cls', 0.11)).toBe('needs-improvement');
      expect(getVitalStatus('cls', 0.25)).toBe('needs-improvement');
    });
    it('returns poor above 0.25', () => {
      expect(getVitalStatus('cls', 0.26)).toBe('poor');
    });
  });

  describe('FID (good <= 100, poor > 300) — legacy metric, uses default branch keys', () => {
    it('returns good at the good threshold', () => {
      expect(getVitalStatus('fid', 100)).toBe('good');
    });
    it('returns needs-improvement between thresholds', () => {
      expect(getVitalStatus('fid', 101)).toBe('needs-improvement');
      expect(getVitalStatus('fid', 300)).toBe('needs-improvement');
    });
    it('returns poor above the poor threshold', () => {
      expect(getVitalStatus('fid', 301)).toBe('poor');
    });
  });

  describe('unknown metric key falls back to CLS-like unitless thresholds', () => {
    it('returns good for value <= 0.1', () => {
      expect(getVitalStatus('unknown', 0.1)).toBe('good');
    });
    it('returns needs-improvement for value between 0.1 and 0.25', () => {
      expect(getVitalStatus('unknown', 0.2)).toBe('needs-improvement');
    });
    it('returns poor for value above 0.25', () => {
      expect(getVitalStatus('unknown', 0.5)).toBe('poor');
    });
  });
});

// ─── lhColor / lhCls (Lighthouse score buckets) ────────────────────────────────

describe('lhColor', () => {
  it('returns green for scores >= 90', () => {
    expect(lhColor(90)).toBe('#1f883d');
    expect(lhColor(100)).toBe('#1f883d');
  });
  it('returns amber for scores between 50 and 89', () => {
    expect(lhColor(89)).toBe('#9a6700');
    expect(lhColor(50)).toBe('#9a6700');
  });
  it('returns red for scores below 50', () => {
    expect(lhColor(49)).toBe('#cf222e');
    expect(lhColor(0)).toBe('#cf222e');
  });
});

describe('lhCls', () => {
  it('returns the green classes for scores >= 90', () => {
    expect(lhCls(90)).toBe('text-[#1a7f37] bg-[#dafbe1]');
  });
  it('returns the amber classes for scores between 50 and 89', () => {
    expect(lhCls(50)).toBe('text-[#9a6700] bg-[#fff8c5]');
    expect(lhCls(89)).toBe('text-[#9a6700] bg-[#fff8c5]');
  });
  it('returns the red classes for scores below 50', () => {
    expect(lhCls(49)).toBe('text-[#cf222e] bg-[#ffebe9]');
  });
});

// ─── Render smoke test ──────────────────────────────────────────────────────────

describe('ClientChart — render smoke test', () => {
  const sampleMetrics = {
    lcp: 2000,
    fcp: 1500,
    ttfb: 600,
    fid: 0,
    cls: 0.05,
    inp: 150,
    tbt: 100,
    tti: 2500,
    jsErrors: 0,
    longTaskCount: 2,
    domNodeCount: 1200,
    resourceBreakdown: {
      jsSize: 100, cssSize: 20, imageSize: 200, fontSize: 10,
      xhrSize: 5, totalSize: 335, requestCount: 30,
    },
    lighthouseScore: { performance: 85, accessibility: 95, bestPractices: 92, seo: 100 },
  };

  it('renders without throwing and shows core sections', () => {
    render(<ClientChart metrics={sampleMetrics} />);
    expect(screen.getByText('Web Vitals Score')).toBeInTheDocument();
    expect(screen.getByText('Core Web Vitals')).toBeInTheDocument();
    expect(screen.getByText('LCP')).toBeInTheDocument();
    expect(screen.getByText('Resource Breakdown')).toBeInTheDocument();
    expect(screen.getByText('Lighthouse Audit')).toBeInTheDocument();
  });

  it('renders minimal metrics without optional fields', () => {
    const minimal = { lcp: 1000, fcp: 800, ttfb: 200, fid: 0, cls: 0.01 };
    render(<ClientChart metrics={minimal} />);
    expect(screen.getByText('Web Vitals Score')).toBeInTheDocument();
    expect(screen.queryByText('Resource Breakdown')).not.toBeInTheDocument();
    expect(screen.queryByText('Lighthouse Audit')).not.toBeInTheDocument();
  });
});
