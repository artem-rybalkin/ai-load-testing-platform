/**
 * Contract tests for the message shapes that cross an AMQP queue boundary.
 * Each schema is checked against a realistic message matching what its real
 * producer actually sends (both a minimal required-fields-only example and
 * a fully-populated one), plus rejection of a missing/mistyped required
 * field. These are the tests referenced by docs/TEST-COVERAGE-GAPS.md 1.3.
 */
import { describe, it, expect } from 'vitest';
import {
  TestRequestSchema, EnrichedTestRequestSchema, TestResultSchema, CancelMessageSchema,
  BackendMetricsSchema, ClientMetricsSchema, FlowStepSchema,
} from '../contracts';

// ── TestRequestSchema (api-service -> ai-service, minus the enrichment fields) ─

describe('TestRequestSchema', () => {
  it('accepts a minimal backend test request (only required fields)', () => {
    const msg = {
      id: 't1', type: 'backend', targetUrl: 'https://example.com', description: 'load test',
      options: { vus: 10, duration: '1m' },
      createdAt: '2026-01-01T00:00:00Z',
    };
    expect(TestRequestSchema.safeParse(msg).success).toBe(true);
  });

  it('accepts a fully-populated backend test request', () => {
    const msg = {
      id: 't1', type: 'backend', targetUrl: 'https://example.com', description: 'load test',
      options: { vus: 10, duration: '1m', rampUp: '10s', profile: 'spike', peakVus: 50, httpOptions: { keepAlive: true, timeout: '30s', discardResponseBodies: true }, headers: { 'X-Test': '1' } },
      thresholds: { p95: 1000, errorRate: 1 },
      envVars: { API_KEY: 'x' },
      testData: [{ user: 'a' }],
      csvData: 'YQ==',
      csvFilename: 'data.csv',
      customScript: 'export default function() {}',
      projectId: 'p1',
      workspaceId: 'w1',
      createdAt: '2026-01-01T00:00:00Z',
    };
    expect(TestRequestSchema.safeParse(msg).success).toBe(true);
  });

  it('accepts a client-side test request (the other half of the options union)', () => {
    const msg = {
      id: 't2', type: 'client-side', targetUrl: 'https://example.com', description: 'browser test',
      options: { sessions: 1, duration: '1m', collectWebVitals: true },
      createdAt: '2026-01-01T00:00:00Z',
    };
    expect(TestRequestSchema.safeParse(msg).success).toBe(true);
  });

  it('accepts a flow test request with steps', () => {
    const msg = {
      id: 't3', type: 'flow', targetUrl: 'https://example.com', description: 'flow test',
      options: { vus: 5, duration: '1m' },
      steps: [{ name: 'login', url: 'https://example.com/login', method: 'POST', extract: { token: { source: 'jsonpath', expression: '$.token' } } }],
      createdAt: '2026-01-01T00:00:00Z',
    };
    expect(TestRequestSchema.safeParse(msg).success).toBe(true);
  });

  it('rejects a message missing a required field', () => {
    const msg = { type: 'backend', targetUrl: 'https://example.com', description: 'x', options: { vus: 1, duration: '1m' }, createdAt: '2026-01-01T00:00:00Z' };
    expect(TestRequestSchema.safeParse(msg).success).toBe(false);
  });

  it('rejects an invalid test type', () => {
    const msg = { id: 't1', type: 'not-a-real-type', targetUrl: 'https://example.com', description: 'x', options: { vus: 1, duration: '1m' }, createdAt: '2026-01-01T00:00:00Z' };
    expect(TestRequestSchema.safeParse(msg).success).toBe(false);
  });

  it('rejects options with a wrong field type (vus as a string)', () => {
    const msg = { id: 't1', type: 'backend', targetUrl: 'https://example.com', description: 'x', options: { vus: '10', duration: '1m' }, createdAt: '2026-01-01T00:00:00Z' };
    expect(TestRequestSchema.safeParse(msg).success).toBe(false);
  });

  it('does not reject a message with an unrecognized extra field (forward-compat)', () => {
    const msg = {
      id: 't1', type: 'backend', targetUrl: 'https://example.com', description: 'x',
      options: { vus: 1, duration: '1m' }, createdAt: '2026-01-01T00:00:00Z',
      someFieldAddedByAFutureProducer: 'ignored',
    };
    expect(TestRequestSchema.safeParse(msg).success).toBe(true);
  });
});

// ── EnrichedTestRequestSchema (api-service|ai-service -> both workers) ────────

describe('EnrichedTestRequestSchema', () => {
  const base = {
    id: 't1', type: 'backend', targetUrl: 'https://example.com', description: 'load test',
    options: { vus: 10, duration: '1m' },
    createdAt: '2026-01-01T00:00:00Z',
  };

  it('accepts a TestRequest with none of the enrichment fields (all optional)', () => {
    expect(EnrichedTestRequestSchema.safeParse(base).success).toBe(true);
  });

  it('accepts every enrichment field populated, including a null cachedScriptDescription', () => {
    const msg = {
      ...base,
      generatedScript: 'export default function() {}',
      scriptId: 'script-1',
      reusedScript: true,
      scriptCacheKey: 'cache-key-1',
      cachedScript: 'export default function() {}',
      cachedScriptDescription: null,
    };
    expect(EnrichedTestRequestSchema.safeParse(msg).success).toBe(true);
  });

  it('rejects when the base TestRequest shape is invalid (missing targetUrl)', () => {
    const { targetUrl: _targetUrl, ...msg } = base;
    expect(EnrichedTestRequestSchema.safeParse(msg).success).toBe(false);
  });

  it('rejects reusedScript with the wrong type', () => {
    const msg = { ...base, reusedScript: 'yes' };
    expect(EnrichedTestRequestSchema.safeParse(msg).success).toBe(false);
  });
});

// ── TestResultSchema (both workers -> results-service) ───────────────────────

describe('TestResultSchema', () => {
  it('accepts a minimal backend result', () => {
    const msg = {
      testId: 't1', targetUrl: 'https://example.com', status: 'completed',
      metrics: { type: 'backend', requestsTotal: 100, requestsFailed: 2, avgResponseTime: 120, p50ResponseTime: 100, p95ResponseTime: 200, p99ResponseTime: 300, rps: 10 },
      startedAt: '2026-01-01T00:00:00Z',
    };
    expect(TestResultSchema.safeParse(msg).success).toBe(true);
  });

  it('accepts a fully-populated backend result with errorBreakdown and stepMetrics', () => {
    const msg = {
      testId: 't1', targetUrl: 'https://example.com', status: 'completed',
      metrics: {
        type: 'backend', requestsTotal: 100, requestsFailed: 2, avgResponseTime: 120, p50ResponseTime: 100, p95ResponseTime: 200, p99ResponseTime: 300, rps: 10,
        statusCodes: { '200': 98, '500': 2 },
        errorBreakdown: { success: 98, clientError: 0, serverError: 2, timeout: 0, networkError: 0 },
        stepMetrics: [{ name: 'login', avgResponseTime: 100, p95ResponseTime: 150, requestsTotal: 10, requestsFailed: 0 }],
      },
      thresholds: { p95: 1000 },
      scriptId: 'script-1',
      reusedScript: false,
      projectId: 'p1',
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:01:00Z',
      perfStatus: 'passed',
      executionLog: 'line 1\nline 2',
    };
    expect(TestResultSchema.safeParse(msg).success).toBe(true);
  });

  it('accepts a client-side result with resourceBreakdown and lighthouseScore', () => {
    const msg = {
      testId: 't2', targetUrl: 'https://example.com', status: 'completed',
      metrics: {
        type: 'client', lcp: 2000, fid: 10, cls: 0.05, ttfb: 500, fcp: 1200,
        inp: 150, tbt: 100, tti: 3000, jsErrors: 0, longTaskCount: 1, domNodeCount: 500, pageLoadCount: 1,
        resourceBreakdown: { jsSize: 100, cssSize: 20, imageSize: 200, fontSize: 10, xhrSize: 5, totalSize: 335, requestCount: 20 },
        lighthouseScore: { performance: 90, accessibility: 95, bestPractices: 92, seo: 100 },
      },
      startedAt: '2026-01-01T00:00:00Z',
    };
    expect(TestResultSchema.safeParse(msg).success).toBe(true);
  });

  it('rejects a result missing testId', () => {
    const msg = {
      targetUrl: 'https://example.com', status: 'completed',
      metrics: { type: 'backend', requestsTotal: 1, requestsFailed: 0, avgResponseTime: 1, p50ResponseTime: 1, p95ResponseTime: 1, p99ResponseTime: 1, rps: 1 },
      startedAt: '2026-01-01T00:00:00Z',
    };
    expect(TestResultSchema.safeParse(msg).success).toBe(false);
  });

  it('rejects an invalid status value', () => {
    const msg = {
      testId: 't1', targetUrl: 'https://example.com', status: 'not-a-real-status',
      metrics: { type: 'backend', requestsTotal: 1, requestsFailed: 0, avgResponseTime: 1, p50ResponseTime: 1, p95ResponseTime: 1, p99ResponseTime: 1, rps: 1 },
      startedAt: '2026-01-01T00:00:00Z',
    };
    expect(TestResultSchema.safeParse(msg).success).toBe(false);
  });

  it('rejects metrics that match neither the backend nor client shape', () => {
    const msg = {
      testId: 't1', targetUrl: 'https://example.com', status: 'completed',
      metrics: { type: 'neither-backend-nor-client', someField: 1 },
      startedAt: '2026-01-01T00:00:00Z',
    };
    expect(TestResultSchema.safeParse(msg).success).toBe(false);
  });
});

describe('BackendMetricsSchema / ClientMetricsSchema (standalone)', () => {
  it('rejects backend metrics missing a required numeric field', () => {
    const msg = { type: 'backend', requestsTotal: 1, requestsFailed: 0, avgResponseTime: 1, p50ResponseTime: 1, p95ResponseTime: 1 }; // missing p99ResponseTime, rps
    expect(BackendMetricsSchema.safeParse(msg).success).toBe(false);
  });

  it('rejects client metrics missing a required field', () => {
    const msg = { type: 'client', lcp: 1, cls: 0.1, ttfb: 1, fcp: 1 }; // missing fid (required)
    expect(ClientMetricsSchema.safeParse(msg).success).toBe(false);
  });
});

// ── CancelMessageSchema (api-service -> both workers, cancel-fanout) ──────────

describe('CancelMessageSchema', () => {
  it('accepts a valid cancel message', () => {
    expect(CancelMessageSchema.safeParse({ testId: 't1' }).success).toBe(true);
  });

  it('rejects a message missing testId', () => {
    expect(CancelMessageSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a non-string testId', () => {
    expect(CancelMessageSchema.safeParse({ testId: 123 }).success).toBe(false);
  });
});

// ── FlowStepSchema (nested in TestRequest.steps) ──────────────────────────────

describe('FlowStepSchema', () => {
  it('accepts a step with an extract rule for every source type', () => {
    const msg = {
      name: 'step', url: 'https://example.com', method: 'GET',
      extract: {
        a: { source: 'jsonpath', expression: '$.a' },
        b: { source: 'header', expression: 'X-Token' },
        c: { source: 'cookie', expression: 'session' },
        d: { source: 'regex', expression: '\\d+' },
      },
    };
    expect(FlowStepSchema.safeParse(msg).success).toBe(true);
  });

  it('rejects an unrecognized HTTP method', () => {
    const msg = { name: 'step', url: 'https://example.com', method: 'TRACE' };
    expect(FlowStepSchema.safeParse(msg).success).toBe(false);
  });
});
