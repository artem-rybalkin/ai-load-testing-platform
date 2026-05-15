import { describe, it, expect } from 'vitest';
import { analyzeResult } from '../analyzer';
import type { BackendMetrics, ClientMetrics } from '@alt/shared';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const backend = (overrides: Partial<BackendMetrics> = {}): BackendMetrics => ({
  type: 'backend',
  requestsTotal: 100,
  requestsFailed: 0,
  avgResponseTime: 200,
  p50ResponseTime: 180,
  p95ResponseTime: 400,
  p99ResponseTime: 500,
  rps: 10,
  ...overrides,
});

const client = (overrides: Partial<ClientMetrics> = {}): ClientMetrics => ({
  type: 'client',
  lcp: 1500,
  fcp: 1200,
  cls: 0.05,
  ttfb: 400,
  fid: 100,
  ...overrides,
});

// ─── Backend — threshold violations ──────────────────────────────────────────

describe('analyzeResult — backend thresholds', () => {
  it('fails when p95 exceeds 1000ms', () => {
    const result = analyzeResult(backend({ p95ResponseTime: 1200 }), null);

    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations).toHaveLength(1);
    expect(result.thresholdViolations[0]).toMatch(/p95/);
    expect(result.thresholdViolations[0]).toMatch(/1200ms/);
  });

  it('fails when avg response time exceeds 500ms', () => {
    const result = analyzeResult(backend({ avgResponseTime: 600 }), null);

    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations[0]).toMatch(/avg/i);
    expect(result.thresholdViolations[0]).toMatch(/600ms/);
  });

  it('fails when error rate exceeds 1%', () => {
    const result = analyzeResult(
      backend({ requestsTotal: 100, requestsFailed: 2 }),
      null
    );

    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations[0]).toMatch(/error rate/i);
    expect(result.thresholdViolations[0]).toMatch(/2.00%/);
  });

  it('collects multiple threshold violations', () => {
    const result = analyzeResult(
      backend({ p95ResponseTime: 1500, avgResponseTime: 700, requestsTotal: 100, requestsFailed: 5 }),
      null
    );

    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations).toHaveLength(3);
  });

  it('passes when all metrics are within thresholds', () => {
    const result = analyzeResult(backend(), null);

    expect(result.perfStatus).toBe('passed');
    expect(result.thresholdViolations).toHaveLength(0);
  });
});

// ─── Backend — regression comparison ─────────────────────────────────────────

describe('analyzeResult — backend regression', () => {
  it('marks degraded when avg response time is 25% worse than previous', () => {
    const prev = backend({ avgResponseTime: 200 });
    const curr = backend({ avgResponseTime: 250 }); // +25%

    const result = analyzeResult(curr, prev);

    expect(result.perfStatus).toBe('degraded');
    const avgDiff = result.diffs.find(d => d.metric === 'Avg response time');
    expect(avgDiff?.status).toBe('worse');
    expect(avgDiff?.diffPercent).toBeCloseTo(25, 0);
  });

  it('passes when avg response time is only 15% worse (below 20% degradation threshold)', () => {
    const prev = backend({ avgResponseTime: 200 });
    const curr = backend({ avgResponseTime: 230 }); // +15%

    const result = analyzeResult(curr, prev);

    expect(result.perfStatus).toBe('passed');
    const avgDiff = result.diffs.find(d => d.metric === 'Avg response time');
    expect(avgDiff?.status).toBe('worse');
  });

  it('marks better when avg response time improves by more than 10%', () => {
    const prev = backend({ avgResponseTime: 200 });
    const curr = backend({ avgResponseTime: 160 }); // -20%

    const result = analyzeResult(curr, prev);

    expect(result.perfStatus).toBe('passed');
    const avgDiff = result.diffs.find(d => d.metric === 'Avg response time');
    expect(avgDiff?.status).toBe('better');
  });

  it('produces no diffs when there is no previous result', () => {
    const result = analyzeResult(backend(), null);

    expect(result.diffs).toHaveLength(0);
  });

  it('produces diffs for avg, p95, p99, rps when previous exists', () => {
    const result = analyzeResult(backend(), backend());

    const metricNames = result.diffs.map(d => d.metric);
    expect(metricNames).toContain('Avg response time');
    expect(metricNames).toContain('p95 response time');
    expect(metricNames).toContain('p99 response time');
    expect(metricNames).toContain('Requests/sec');
  });

  it('treats rps drop as worse (higher rps is better)', () => {
    const prev = backend({ rps: 100 });
    const curr = backend({ rps: 60 }); // -40%

    const result = analyzeResult(curr, prev);

    const rpsDiff = result.diffs.find(d => d.metric === 'Requests/sec');
    expect(rpsDiff?.status).toBe('worse');
  });

  it('threshold failure takes priority over regression status', () => {
    const prev = backend({ avgResponseTime: 200 });
    const curr = backend({ avgResponseTime: 260, p95ResponseTime: 1100 }); // violation + regression

    const result = analyzeResult(curr, prev);

    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations.length).toBeGreaterThan(0);
  });
});

// ─── Client-side — threshold violations ──────────────────────────────────────

describe('analyzeResult — client-side thresholds', () => {
  it('fails when LCP exceeds 2500ms', () => {
    const result = analyzeResult(client({ lcp: 3000 }), null);

    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations[0]).toMatch(/LCP/);
    expect(result.thresholdViolations[0]).toMatch(/3000ms/);
  });

  it('fails when CLS exceeds 0.1', () => {
    const result = analyzeResult(client({ cls: 0.25 }), null);

    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations[0]).toMatch(/CLS/);
    expect(result.thresholdViolations[0]).toMatch(/0.250/);
  });

  it('fails when TTFB exceeds 800ms', () => {
    const result = analyzeResult(client({ ttfb: 1000 }), null);

    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations[0]).toMatch(/TTFB/);
    expect(result.thresholdViolations[0]).toMatch(/1000ms/);
  });

  it('fails when FCP exceeds 1800ms', () => {
    const result = analyzeResult(client({ fcp: 2000 }), null);

    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations[0]).toMatch(/FCP/);
  });

  it('passes when all web vitals are within thresholds', () => {
    const result = analyzeResult(client(), null);

    expect(result.perfStatus).toBe('passed');
    expect(result.thresholdViolations).toHaveLength(0);
  });

  it('marks client degraded when LCP is 25% worse than previous', () => {
    const prev = client({ lcp: 1000 });
    const curr = client({ lcp: 1250 }); // +25%

    const result = analyzeResult(curr, prev);

    expect(result.perfStatus).toBe('degraded');
  });

  it('produces no diffs when there is no previous client result', () => {
    const result = analyzeResult(client(), null);

    expect(result.diffs).toHaveLength(0);
  });
});

// ─── Backend — boundary & edge cases ─────────────────────────────────────────

describe('analyzeResult — backend edge cases', () => {
  it('passes when regression is exactly 20% (boundary is strictly > 20%)', () => {
    const prev = backend({ avgResponseTime: 200 });
    const curr = backend({ avgResponseTime: 240 }); // exactly +20%

    const result = analyzeResult(curr, prev);

    expect(result.perfStatus).toBe('passed');
  });

  it('degrades when regression is 20.1% (just over boundary)', () => {
    const prev = backend({ avgResponseTime: 200 });
    const curr = backend({ avgResponseTime: 241 }); // +20.5%

    const result = analyzeResult(curr, prev);

    expect(result.perfStatus).toBe('degraded');
  });

  it('handles zero requestsTotal without division by zero', () => {
    const result = analyzeResult(
      backend({ requestsTotal: 0, requestsFailed: 0, avgResponseTime: 0, p95ResponseTime: 0, p99ResponseTime: 0, rps: 0, p50ResponseTime: 0 }),
      null
    );

    expect(result.perfStatus).toBe('passed');
    expect(result.thresholdViolations).toHaveLength(0);
  });
});

// ─── Client-side — Lighthouse & FID ──────────────────────────────────────────

describe('analyzeResult — Lighthouse thresholds', () => {
  it('fails when Lighthouse performance score is below 50', () => {
    const result = analyzeResult(
      client({ lighthouseScore: { performance: 45, accessibility: 90, bestPractices: 85, seo: 80 } }),
      null
    );

    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations.some(v => v.includes('Lighthouse'))).toBe(true);
  });

  it('passes when Lighthouse performance score is exactly 50', () => {
    const result = analyzeResult(
      client({ lighthouseScore: { performance: 50, accessibility: 90, bestPractices: 85, seo: 80 } }),
      null
    );

    expect(result.perfStatus).toBe('passed');
  });

  it('passes when no lighthouse score is present', () => {
    const result = analyzeResult(client({ lighthouseScore: undefined }), null);

    expect(result.perfStatus).toBe('passed');
  });

  it('includes FID in client metric diffs when previous result exists', () => {
    const prev = client({ fid: 100 });
    const curr = client({ fid: 200 }); // +100%

    const result = analyzeResult(curr, prev);

    const fidDiff = result.diffs.find(d => d.metric === 'FID');
    expect(fidDiff).toBeDefined();
    expect(fidDiff!.status).toBe('worse');
    expect(fidDiff!.diffPercent).toBeCloseTo(100, 0);
  });

  it('includes Lighthouse score diffs when both runs have scores', () => {
    const prev = client({ lighthouseScore: { performance: 80, accessibility: 90, bestPractices: 85, seo: 80 } });
    const curr = client({ lighthouseScore: { performance: 60, accessibility: 90, bestPractices: 85, seo: 80 } }); // perf dropped

    const result = analyzeResult(curr, prev);

    const lhDiff = result.diffs.find(d => d.metric === 'Lighthouse performance');
    expect(lhDiff).toBeDefined();
    expect(lhDiff!.status).toBe('worse');
  });
});

// ─── Custom SLO thresholds ────────────────────────────────────────────────────

describe('analyzeResult — custom SLO thresholds', () => {
  it('uses custom p95 threshold instead of default 1000ms', () => {
    const curr = backend({ p95ResponseTime: 600 }); // passes default (1000ms) but fails custom (500ms)

    const result = analyzeResult(curr, null, { p95: 500 });

    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations[0]).toMatch(/500ms/);
  });

  it('passes with tighter thresholds when metrics are good enough', () => {
    const curr = backend({ p95ResponseTime: 300, avgResponseTime: 150 });

    const result = analyzeResult(curr, null, { p95: 400, avg: 200 });

    expect(result.perfStatus).toBe('passed');
  });

  it('uses custom LCP threshold for client tests', () => {
    const curr = client({ lcp: 1800 }); // passes default (2500ms) but fails custom (1500ms)

    const result = analyzeResult(curr, null, { lcp: 1500 });

    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations[0]).toMatch(/LCP/);
  });
});
