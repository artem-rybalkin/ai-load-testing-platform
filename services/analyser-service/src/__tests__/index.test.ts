import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { BackendMetrics } from '@alt/shared';

// ── Mock the shared AI provider abstraction before importing the module under test ──

vi.mock('@alt/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alt/shared')>();
  const mockFn = vi.fn();
  return { ...actual, generateAIText: mockFn };
});

// Mock global fetch so getProviderSetting() (results-service lookup) never makes a real network call
vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch disabled in tests')));

const getMockGenerateAIText = async (): Promise<ReturnType<typeof vi.fn>> => {
  const shared = await import('@alt/shared');
  return (shared as unknown as { generateAIText: ReturnType<typeof vi.fn> }).generateAIText;
};

import { buildApp } from '../index';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const baseMetrics: BackendMetrics = {
  type: 'backend',
  requestsTotal: 1000,
  requestsFailed: 10,
  avgResponseTime: 250,
  p50ResponseTime: 200,
  p95ResponseTime: 800,
  p99ResponseTime: 1200,
  rps: 50,
};

const validInsightsPayload = {
  narrative: 'The API handles load well but tail latency is elevated under stress.',
  anomalies: ['p99 is 50% higher than p95, suggesting occasional slow outliers'],
  rootCauses: ['Possible GC pauses or connection pool exhaustion under load'],
  recommendations: ['Profile slow requests above 800ms', 'Increase connection pool size'],
  severity: 'warning' as const,
};

const analysePayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  testId: 'test-123',
  targetUrl: 'https://api.example.com',
  type: 'backend',
  metrics: baseMetrics,
  previousMetrics: null,
  ...overrides,
});

let app: FastifyInstance;
let originalApiKey: string | undefined;
let originalInternalApiKey: string | undefined;

// POST /analyse now requires this header (regression #1, Critical — see the
// "security regression" describe block below). Every legitimate call in this
// file uses it; the one test proving the guard omits it on purpose.
const TEST_INTERNAL_API_KEY = 'test-internal-key';
const internalKeyHeaders = { 'x-internal-key': TEST_INTERNAL_API_KEY };

beforeEach(async () => {
  const mock = await getMockGenerateAIText();
  mock.mockReset();
  originalApiKey = process.env.GEMINI_API_KEY;
  originalInternalApiKey = process.env.INTERNAL_API_KEY;
  process.env.INTERNAL_API_KEY = TEST_INTERNAL_API_KEY;
  app = buildApp();
});

afterEach(async () => {
  if (originalApiKey === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = originalApiKey;
  }
  if (originalInternalApiKey === undefined) {
    delete process.env.INTERNAL_API_KEY;
  } else {
    process.env.INTERNAL_API_KEY = originalInternalApiKey;
  }
  await app.close();
});

// ─── POST /analyse ─────────────────────────────────────────────────────────────

describe('POST /analyse', () => {
  it('returns combined analyzeResult + aiInsights when Gemini succeeds', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const mock = await getMockGenerateAIText();
    mock.mockResolvedValue(JSON.stringify(validInsightsPayload));

    const response = await app.inject({
      method: 'POST',
      url: '/analyse',
      headers: internalKeyHeaders,
      payload: analysePayload(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // Base analyzeResult fields
    expect(body.perfStatus).toBeDefined();
    expect(body.summary).toBeDefined();
    expect(body.thresholdViolations).toBeDefined();
    expect(body.diffs).toBeDefined();

    // AI insights present
    expect(body.geminiRateLimited).toBe(false);
    expect(body.aiInsights).toEqual(validInsightsPayload);
  });

  it('omits aiInsights and sets geminiRateLimited=true when Gemini is rate limited', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const mock = await getMockGenerateAIText();
    const err = Object.assign(new Error('429 quota exceeded'), { status: 429 });
    mock.mockRejectedValue(err);

    const response = await app.inject({
      method: 'POST',
      url: '/analyse',
      headers: internalKeyHeaders,
      payload: analysePayload(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.aiInsights).toBeUndefined();
    expect(body.geminiRateLimited).toBe(true);

    // Deterministic analysis still present
    expect(body.perfStatus).toBeDefined();
    expect(body.summary).toBeDefined();
  });

  it('returns analyzeResult-only response when GEMINI_API_KEY is not set', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const mock = await getMockGenerateAIText();

    const response = await app.inject({
      method: 'POST',
      url: '/analyse',
      headers: internalKeyHeaders,
      payload: analysePayload(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.aiInsights).toBeUndefined();
    expect(body.geminiRateLimited).toBe(false);
    expect(body.perfStatus).toBeDefined();
    expect(body.summary).toBeDefined();
    expect(mock).not.toHaveBeenCalled();
  });

  it('passes externalMetrics through to generateAiInsights / Gemini prompt', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const mock = await getMockGenerateAIText();
    mock.mockResolvedValue(JSON.stringify(validInsightsPayload));

    const response = await app.inject({
      method: 'POST',
      url: '/analyse',
      headers: internalKeyHeaders,
      payload: analysePayload({
        externalMetrics: [
          { sourceName: 'Grafana Loki', platform: 'Loki', data: 'error rate spike at 12:05 UTC' },
        ],
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(mock).toHaveBeenCalledTimes(1);
    const prompt = mock.mock.calls[0]![0] as string;
    expect(prompt).toContain('Grafana Loki');
    expect(prompt).toContain('error rate spike at 12:05 UTC');
  });

  it('passes teamId through to the provider-setting lookup', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const mock = await getMockGenerateAIText();
    mock.mockResolvedValue(JSON.stringify(validInsightsPayload));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'gemini', fallbacks: [], available: {}, isOverride: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.inject({
      method: 'POST',
      url: '/analyse',
      headers: internalKeyHeaders,
      payload: analysePayload({ teamId: 'team-analyse-1' }),
    });

    expect(response.statusCode).toBe(200);
    const url = String(fetchMock.mock.calls.find(([u]) => String(u).includes('/system/ai-provider'))?.[0]);
    expect(url).toContain(`teamId=${encodeURIComponent('team-analyse-1')}`);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch disabled in tests')));
  });
});

// ─── GET /health ─────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('reports gemini: configured when GEMINI_API_KEY is set', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('analyser-service');
    expect(body.checks.gemini).toBe('configured');
  });

  it('reports gemini: missing_key when GEMINI_API_KEY is not set', async () => {
    delete process.env.GEMINI_API_KEY;

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.checks.gemini).toBe('missing_key');
  });
});

// ─── Regression: unauthenticated POST /analyse (TODO finding #1 — Critical) ──
// Fixed 2026-07-06: buildApp() now registers an onRequest hook requiring
// X-Internal-Key to match INTERNAL_API_KEY on every route except /health —
// unconditionally, even when INTERNAL_API_KEY is unset (see index.ts's
// comment on why this differs from the rest of the codebase's internal-key
// convention). results-service's consumer.ts now sends that header via
// internalHeaders() on its call to this endpoint.

describe('POST /analyse — security regression (finding #1)', () => {
  it(
    'rejects unauthenticated requests with 401 or 403',
    async () => {
      // No Authorization header, no X-API-Key, no session cookie, no
      // X-Internal-Key — a fully anonymous call.
      const response = await app.inject({
        method: 'POST',
        url: '/analyse',
        payload: analysePayload(),
      });

      expect([401, 403]).toContain(response.statusCode);
    },
  );
});
