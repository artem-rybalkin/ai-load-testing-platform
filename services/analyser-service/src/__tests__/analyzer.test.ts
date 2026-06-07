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
    const result = analyzeResult(backend({ requestsTotal: 100, requestsFailed: 2 }), null);
    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations[0]).toMatch(/error rate/i);
  });

  it('collects multiple threshold violations', () => {
    const result = analyzeResult(
      backend({ p95ResponseTime: 1500, avgResponseTime: 700, requestsTotal: 100, requestsFailed: 5 }),
      null
    );
    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations.length).toBeGreaterThanOrEqual(3);
  });

  it('passes when all metrics are within thresholds', () => {
    const result = analyzeResult(backend(), null);
    expect(result.perfStatus).toBe('passed');
    expect(result.thresholdViolations).toHaveLength(0);
  });

  it('does not include aiInsights (that field is added by the caller)', () => {
    const result = analyzeResult(backend(), null);
    expect((result as unknown as Record<string, unknown>).aiInsights).toBeUndefined();
  });
});

// ─── Backend — regression comparison ─────────────────────────────────────────

describe('analyzeResult — backend regression', () => {
  it('marks degraded when avg response time is 25% worse', () => {
    const result = analyzeResult(backend({ avgResponseTime: 250 }), backend({ avgResponseTime: 200 }));
    expect(result.perfStatus).toBe('degraded');
    const d = result.diffs.find(d => d.metric === 'Avg response time');
    expect(d?.status).toBe('worse');
    expect(d?.diffPercent).toBeCloseTo(25, 0);
  });

  it('passes when avg response time is only 15% worse (below 20% degradation threshold)', () => {
    const result = analyzeResult(backend({ avgResponseTime: 230 }), backend({ avgResponseTime: 200 }));
    expect(result.perfStatus).toBe('passed');
  });

  it('marks better when avg response time improves by more than 10%', () => {
    const result = analyzeResult(backend({ avgResponseTime: 160 }), backend({ avgResponseTime: 200 }));
    const d = result.diffs.find(d => d.metric === 'Avg response time');
    expect(d?.status).toBe('better');
  });

  it('produces no diffs when there is no previous result', () => {
    const result = analyzeResult(backend(), null);
    expect(result.diffs).toHaveLength(0);
  });

  it('produces diffs for avg, p95, p99, rps when previous exists', () => {
    const result = analyzeResult(backend(), backend());
    const names = result.diffs.map(d => d.metric);
    expect(names).toContain('Avg response time');
    expect(names).toContain('p95 response time');
    expect(names).toContain('p99 response time');
    expect(names).toContain('Requests/sec');
  });

  it('treats rps drop as worse (higher rps is better)', () => {
    const result = analyzeResult(backend({ rps: 60 }), backend({ rps: 100 }));
    const d = result.diffs.find(d => d.metric === 'Requests/sec');
    expect(d?.status).toBe('worse');
  });

  it('threshold failure takes priority over regression status', () => {
    const result = analyzeResult(
      backend({ avgResponseTime: 260, p95ResponseTime: 1100 }),
      backend({ avgResponseTime: 200 })
    );
    expect(result.perfStatus).toBe('failed');
  });
});

// ─── Client-side — threshold violations ──────────────────────────────────────

describe('analyzeResult — client-side thresholds', () => {
  it('fails when LCP exceeds 2500ms', () => {
    const result = analyzeResult(client({ lcp: 3000 }), null);
    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations[0]).toMatch(/LCP/);
  });

  it('fails when CLS exceeds 0.1', () => {
    const result = analyzeResult(client({ cls: 0.25 }), null);
    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations[0]).toMatch(/CLS/);
  });

  it('fails when TTFB exceeds 800ms', () => {
    const result = analyzeResult(client({ ttfb: 1000 }), null);
    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations[0]).toMatch(/TTFB/);
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
    const result = analyzeResult(client({ lcp: 1250 }), client({ lcp: 1000 }));
    expect(result.perfStatus).toBe('degraded');
  });

  it('includes FID in client metric diffs', () => {
    const result = analyzeResult(client({ fid: 200 }), client({ fid: 100 }));
    const d = result.diffs.find(d => d.metric === 'FID');
    expect(d?.status).toBe('worse');
  });
});

// ─── Backend — boundary & edge cases ─────────────────────────────────────────

describe('analyzeResult — edge cases', () => {
  it('passes when regression is exactly 20% (boundary is strictly > 20%)', () => {
    const result = analyzeResult(backend({ avgResponseTime: 240 }), backend({ avgResponseTime: 200 }));
    expect(result.perfStatus).toBe('passed');
  });

  it('degrades when regression is just over 20%', () => {
    const result = analyzeResult(backend({ avgResponseTime: 241 }), backend({ avgResponseTime: 200 }));
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

// ─── Custom SLO thresholds ────────────────────────────────────────────────────

describe('analyzeResult — custom SLO thresholds', () => {
  it('uses custom p95 threshold instead of default 1000ms', () => {
    const result = analyzeResult(backend({ p95ResponseTime: 600 }), null, { p95: 500 });
    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations[0]).toMatch(/500ms/);
  });

  it('passes with custom thresholds when metrics are within them', () => {
    const result = analyzeResult(backend({ p95ResponseTime: 300, avgResponseTime: 150 }), null, { p95: 400, avg: 200 });
    expect(result.perfStatus).toBe('passed');
  });

  it('uses custom LCP threshold for client tests', () => {
    const result = analyzeResult(client({ lcp: 1800 }), null, { lcp: 1500 });
    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations[0]).toMatch(/LCP/);
  });
});

// ─── Lighthouse threshold ─────────────────────────────────────────────────────

describe('analyzeResult — Lighthouse', () => {
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

  it('includes Lighthouse score diffs when both runs have scores', () => {
    const prev = client({ lighthouseScore: { performance: 80, accessibility: 90, bestPractices: 85, seo: 80 } });
    const curr = client({ lighthouseScore: { performance: 60, accessibility: 90, bestPractices: 85, seo: 80 } });
    const result = analyzeResult(curr, prev);
    const d = result.diffs.find(d => d.metric === 'Lighthouse performance');
    expect(d?.status).toBe('worse');
  });
});

// ─── Error breakdown thresholds ───────────────────────────────────────────────

describe('analyzeResult — error breakdown thresholds', () => {
  it('fails when server error rate exceeds threshold', () => {
    const result = analyzeResult(
      backend({
        requestsTotal: 100,
        requestsFailed: 5,
        errorBreakdown: { success: 95, clientError: 0, serverError: 5, timeout: 0, networkError: 0 },
      }),
      null,
      { serverErrorRate: 3 }
    );
    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations.some(v => /server error/i.test(v))).toBe(true);
  });

  it('fails when timeout rate exceeds threshold', () => {
    const result = analyzeResult(
      backend({
        requestsTotal: 100,
        requestsFailed: 4,
        errorBreakdown: { success: 96, clientError: 0, serverError: 0, timeout: 4, networkError: 0 },
      }),
      null,
      { timeoutRate: 2 }
    );
    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations.some(v => /timeout/i.test(v))).toBe(true);
  });

  it('passes when error breakdown is within thresholds', () => {
    const result = analyzeResult(
      backend({
        requestsTotal: 100,
        errorBreakdown: { success: 98, clientError: 1, serverError: 1, timeout: 0, networkError: 0 },
      }),
      null,
      { serverErrorRate: 3, timeoutRate: 2 }
    );
    expect(result.thresholdViolations.filter(v => /server error|timeout/i.test(v))).toHaveLength(0);
  });

  it('ignores error breakdown checks when errorBreakdown is absent', () => {
    const result = analyzeResult(backend({ requestsTotal: 100 }), null, { serverErrorRate: 0.1 });
    expect(result.thresholdViolations.every(v => !/server error|timeout/i.test(v))).toBe(true);
  });
});
