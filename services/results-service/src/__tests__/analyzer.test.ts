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

// ─── Backend — checks (content/body assertions), separate from HTTP status ──

describe('analyzeResult — backend checks threshold', () => {
  it('fails when more than 10% of k6 check() assertions fail, even with zero requestsFailed', () => {
    // requestsFailed: 0 — every response returned a 2xx status. Only the
    // checks metric (body/content assertions) reveals the test actually failed.
    const result = analyzeResult(
      backend({ requestsTotal: 100, requestsFailed: 0, checksTotal: 100, checksFailed: 20 }),
      null
    );

    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations[0]).toMatch(/checks failed/i);
    expect(result.thresholdViolations[0]).toMatch(/20\.00%/);
  });

  it('passes when checks fail rate is within the 10% default threshold', () => {
    const result = analyzeResult(
      backend({ checksTotal: 100, checksFailed: 5 }),
      null
    );

    expect(result.perfStatus).toBe('passed');
    expect(result.thresholdViolations).toHaveLength(0);
  });

  it('does not evaluate a checks violation when checksTotal is absent (historical results)', () => {
    const result = analyzeResult(backend(), null);

    expect(result.perfStatus).toBe('passed');
    expect(result.thresholdViolations).toHaveLength(0);
  });

  it('honors a custom checksFailRate threshold', () => {
    const result = analyzeResult(
      backend({ checksTotal: 100, checksFailed: 3 }),
      null,
      { checksFailRate: 2 }
    );

    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations[0]).toMatch(/3\.00%/);
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

// ─── Error breakdown thresholds ───────────────────────────────────────────────

describe('analyzeResult — error breakdown thresholds', () => {
  it('fails when server error rate exceeds threshold', () => {
    const curr = backend({
      requestsTotal: 100,
      requestsFailed: 5,
      errorBreakdown: { success: 90, clientError: 5, serverError: 5, timeout: 0, networkError: 0 },
    });

    const result = analyzeResult(curr, null, { serverErrorRate: 3 });

    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations.some(v => /server error/i.test(v) && /5xx/.test(v))).toBe(true);
  });

  it('fails when timeout rate exceeds threshold', () => {
    const curr = backend({
      requestsTotal: 100,
      requestsFailed: 4,
      errorBreakdown: { success: 96, clientError: 0, serverError: 0, timeout: 4, networkError: 0 },
    });

    const result = analyzeResult(curr, null, { timeoutRate: 2 });

    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations.some(v => /timeout/i.test(v))).toBe(true);
  });

  it('passes when error breakdown is within thresholds', () => {
    const curr = backend({
      requestsTotal: 100,
      errorBreakdown: { success: 98, clientError: 1, serverError: 1, timeout: 0, networkError: 0 },
    });

    const result = analyzeResult(curr, null, { serverErrorRate: 3, timeoutRate: 2 });

    expect(result.thresholdViolations.filter(v => /server error|timeout/i.test(v))).toHaveLength(0);
  });

  it('ignores error breakdown checks when errorBreakdown is absent', () => {
    const curr = backend({ requestsTotal: 100 }); // no errorBreakdown field

    const result = analyzeResult(curr, null, { serverErrorRate: 0.1 });

    // Should not throw or produce breakdown violations when field is absent
    expect(result.thresholdViolations.every(v => !/server error|timeout/i.test(v))).toBe(true);
  });
});

// ─── Client-side — INP & TBT thresholds ──────────────────────────────────────

describe('analyzeResult — INP and TBT thresholds', () => {
  it('fails when INP exceeds default 200ms', () => {
    const result = analyzeResult(client({ inp: 350 }), null);

    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations.some(v => /INP/.test(v) && /350ms/.test(v))).toBe(true);
  });

  it('fails when TBT exceeds default 200ms', () => {
    const result = analyzeResult(client({ tbt: 500 }), null);

    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations.some(v => /TBT/.test(v) && /500ms/.test(v))).toBe(true);
  });

  it('passes when INP is within default threshold', () => {
    const result = analyzeResult(client({ inp: 180 }), null);

    expect(result.perfStatus).toBe('passed');
    expect(result.thresholdViolations.some(v => /INP/.test(v))).toBe(false);
  });

  it('does not violate INP threshold when inp is undefined', () => {
    const result = analyzeResult(client({ inp: undefined }), null);

    expect(result.thresholdViolations.some(v => /INP/.test(v))).toBe(false);
  });

  it('does not violate TBT threshold when tbt is undefined', () => {
    const result = analyzeResult(client({ tbt: undefined }), null);

    expect(result.thresholdViolations.some(v => /TBT/.test(v))).toBe(false);
  });

  it('uses custom INP threshold', () => {
    const result = analyzeResult(client({ inp: 150 }), null, { inp: 100 });

    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations.some(v => /INP/.test(v) && /100ms/.test(v))).toBe(true);
  });

  it('uses custom TBT threshold', () => {
    const result = analyzeResult(client({ tbt: 80 }), null, { tbt: 50 });

    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations.some(v => /TBT/.test(v) && /50ms/.test(v))).toBe(true);
  });

  it('includes INP in regression diffs when previous result has INP', () => {
    const prev = client({ inp: 100 });
    const curr = client({ inp: 300 }); // +200%

    const result = analyzeResult(curr, prev);

    const diff = result.diffs.find(d => d.metric === 'INP');
    expect(diff).toBeDefined();
    expect(diff!.status).toBe('worse');
    expect(diff!.diffPercent).toBeCloseTo(200, 0);
  });

  it('includes TBT in regression diffs when previous result has TBT', () => {
    const prev = client({ tbt: 100 });
    const curr = client({ tbt: 130 }); // +30%

    const result = analyzeResult(curr, prev);

    const diff = result.diffs.find(d => d.metric === 'TBT');
    expect(diff).toBeDefined();
    expect(diff!.status).toBe('worse');
  });

  it('skips INP diff when previous result has no INP', () => {
    const prev = client({ inp: undefined });
    const curr = client({ inp: 250 });

    const result = analyzeResult(curr, prev);

    expect(result.diffs.find(d => d.metric === 'INP')).toBeUndefined();
  });
});

// ─── Performance ──────────────────────────────────────────────────────────

describe('performance', () => {
  // CLAUDE.md caps flow tests at 20 steps; build a synthetic 20-step flow
  // BackendMetrics for the current run and a matching previous/baseline run.
  const buildFlowMetrics = (avgBase: number): BackendMetrics => ({
    ...backend({
      requestsTotal: 20000,
      requestsFailed: 0,
      avgResponseTime: avgBase,
      p50ResponseTime: avgBase * 0.9,
      p95ResponseTime: avgBase * 2,
      p99ResponseTime: avgBase * 3,
      rps: 100,
    }),
    stepMetrics: Array.from({ length: 20 }, (_, i) => ({
      name: `Step ${i + 1}: action-${i + 1}`,
      avgResponseTime: avgBase + i * 5,
      p95ResponseTime: avgBase * 2 + i * 10,
      requestsTotal: 1000,
      requestsFailed: 0,
    })),
  });

  it('analyzeResult completes within budget for a 20-step flow with a previous run', () => {
    const previous = buildFlowMetrics(180);
    const current = buildFlowMetrics(200);

    const start = performance.now();
    const result = analyzeResult(current, previous);
    const elapsedMs = performance.now() - start;

    expect(result).toBeDefined();
    expect(result.diffs.length).toBeGreaterThan(0);
    // analyzeResult runs synchronously in the consumer's hot path before the DB write —
    // generous budget to catch any accidental O(n^2) blowup on stepMetrics diffing.
    expect(elapsedMs).toBeLessThan(50);
  });
});
