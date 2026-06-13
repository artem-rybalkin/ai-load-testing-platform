import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { BackendMetrics } from '@alt/shared';

// ── Mock @google/generative-ai before importing the module under test ─────────

const mockGenerateContent = vi.fn();

vi.mock('@google/generative-ai', () => {
  class FakeGAI {
    getGenerativeModel() {
      return { generateContent: mockGenerateContent };
    }
  }
  return { GoogleGenerativeAI: FakeGAI };
});

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

const mockResponse = (text: string) => ({
  response: { text: () => text },
});

const analysePayload = (overrides: Record<string, unknown> = {}) => ({
  testId: 'test-123',
  targetUrl: 'https://api.example.com',
  type: 'backend',
  metrics: baseMetrics,
  previousMetrics: null,
  ...overrides,
});

let app: FastifyInstance;
let originalApiKey: string | undefined;

beforeEach(() => {
  mockGenerateContent.mockReset();
  originalApiKey = process.env.GEMINI_API_KEY;
  app = buildApp();
});

afterEach(async () => {
  if (originalApiKey === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = originalApiKey;
  }
  await app.close();
});

// ─── POST /analyse ─────────────────────────────────────────────────────────────

describe('POST /analyse', () => {
  it('returns combined analyzeResult + aiInsights when Gemini succeeds', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    mockGenerateContent.mockResolvedValue(mockResponse(JSON.stringify(validInsightsPayload)));

    const response = await app.inject({
      method: 'POST',
      url: '/analyse',
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
    const err = Object.assign(new Error('429 quota exceeded'), { status: 429 });
    mockGenerateContent.mockRejectedValue(err);

    const response = await app.inject({
      method: 'POST',
      url: '/analyse',
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

    const response = await app.inject({
      method: 'POST',
      url: '/analyse',
      payload: analysePayload(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.aiInsights).toBeUndefined();
    expect(body.geminiRateLimited).toBe(false);
    expect(body.perfStatus).toBeDefined();
    expect(body.summary).toBeDefined();
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('passes externalMetrics through to generateAiInsights / Gemini prompt', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    mockGenerateContent.mockResolvedValue(mockResponse(JSON.stringify(validInsightsPayload)));

    const response = await app.inject({
      method: 'POST',
      url: '/analyse',
      payload: analysePayload({
        externalMetrics: [
          { sourceName: 'Grafana Loki', platform: 'Loki', data: 'error rate spike at 12:05 UTC' },
        ],
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    const prompt = mockGenerateContent.mock.calls[0][0] as string;
    expect(prompt).toContain('Grafana Loki');
    expect(prompt).toContain('error rate spike at 12:05 UTC');
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
