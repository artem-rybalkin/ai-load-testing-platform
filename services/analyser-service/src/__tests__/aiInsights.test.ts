import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock @google/generative-ai before importing the module under test ─────────

const mockGenerateContent = vi.fn();

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: vi.fn().mockReturnValue({
      generateContent: mockGenerateContent,
    }),
  })),
}));

// Import after mock is registered
import { generateAiInsights } from '../aiInsights';
import type { BackendMetrics } from '@alt/shared';

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

const makeCtx = (overrides: Partial<Parameters<typeof generateAiInsights>[0]> = {}) => ({
  targetUrl: 'https://api.example.com',
  type: 'backend',
  metrics: baseMetrics,
  previousMetrics: null,
  perfStatus: 'passed' as const,
  summary: 'Performance is within acceptable thresholds',
  thresholdViolations: [],
  diffs: [],
  ...overrides,
});

const mockResponse = (text: string) => ({
  response: { text: () => text },
});

beforeEach(() => {
  mockGenerateContent.mockReset();
  process.env.GEMINI_API_KEY = 'test-key';
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('generateAiInsights — happy path', () => {
  it('returns AiInsights when Gemini returns valid JSON', async () => {
    mockGenerateContent.mockResolvedValue(mockResponse(JSON.stringify(validInsightsPayload)));

    const { insights, rateLimited } = await generateAiInsights(makeCtx());

    expect(insights).not.toBeNull();
    expect(rateLimited).toBe(false);
    expect(insights!.narrative).toBe(validInsightsPayload.narrative);
    expect(insights!.anomalies).toEqual(validInsightsPayload.anomalies);
    expect(insights!.rootCauses).toEqual(validInsightsPayload.rootCauses);
    expect(insights!.recommendations).toEqual(validInsightsPayload.recommendations);
    expect(insights!.severity).toBe('warning');
  });

  it('strips markdown fences from the response before parsing', async () => {
    const wrapped = `\`\`\`json\n${JSON.stringify(validInsightsPayload)}\n\`\`\``;
    mockGenerateContent.mockResolvedValue(mockResponse(wrapped));

    const { insights } = await generateAiInsights(makeCtx());

    expect(insights).not.toBeNull();
    expect(insights!.severity).toBe('warning');
  });

  it('accepts severity "critical"', async () => {
    mockGenerateContent.mockResolvedValue(
      mockResponse(JSON.stringify({ ...validInsightsPayload, severity: 'critical' }))
    );

    const { insights } = await generateAiInsights(makeCtx());

    expect(insights!.severity).toBe('critical');
  });

  it('accepts severity "info"', async () => {
    mockGenerateContent.mockResolvedValue(
      mockResponse(JSON.stringify({ ...validInsightsPayload, severity: 'info' }))
    );

    const { insights } = await generateAiInsights(makeCtx());

    expect(insights!.severity).toBe('info');
  });

  it('accepts empty anomalies and rootCauses arrays', async () => {
    mockGenerateContent.mockResolvedValue(
      mockResponse(JSON.stringify({ ...validInsightsPayload, anomalies: [], rootCauses: [] }))
    );

    const { insights } = await generateAiInsights(makeCtx());

    expect(insights!.anomalies).toEqual([]);
    expect(insights!.rootCauses).toEqual([]);
  });
});

// ─── Missing/invalid API key ──────────────────────────────────────────────────

describe('generateAiInsights — missing API key', () => {
  it('returns null insights immediately when GEMINI_API_KEY is not set', async () => {
    delete process.env.GEMINI_API_KEY;

    const { insights, rateLimited } = await generateAiInsights(makeCtx());

    expect(insights).toBeNull();
    expect(rateLimited).toBe(false);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });
});

// ─── Error cases ──────────────────────────────────────────────────────────────

describe('generateAiInsights — error cases', () => {
  it('returns null insights when Gemini returns invalid JSON', async () => {
    mockGenerateContent.mockResolvedValue(mockResponse('not json at all'));

    const { insights, rateLimited } = await generateAiInsights(makeCtx());

    expect(insights).toBeNull();
    expect(rateLimited).toBe(false);
  });

  it('returns null insights when response is missing required fields', async () => {
    mockGenerateContent.mockResolvedValue(
      mockResponse(JSON.stringify({ narrative: 'ok' }))
    );

    const { insights } = await generateAiInsights(makeCtx());

    expect(insights).toBeNull();
  });

  it('returns null insights when severity is not one of the allowed values', async () => {
    mockGenerateContent.mockResolvedValue(
      mockResponse(JSON.stringify({ ...validInsightsPayload, severity: 'unknown' }))
    );

    const { insights } = await generateAiInsights(makeCtx());

    expect(insights).toBeNull();
  });

  it('returns rateLimited=true on rate limit error (429)', async () => {
    const err = Object.assign(new Error('429 quota exceeded'), { status: 429 });
    mockGenerateContent.mockRejectedValue(err);

    const { insights, rateLimited } = await generateAiInsights(makeCtx());

    expect(insights).toBeNull();
    expect(rateLimited).toBe(true);
    // Should not retry on rate limit
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  it('returns null insights after exhausting retries on generic API error', async () => {
    mockGenerateContent.mockRejectedValue(new Error('service unavailable'));

    const { insights, rateLimited } = await generateAiInsights(makeCtx());

    expect(insights).toBeNull();
    expect(rateLimited).toBe(false);
    // Should try twice (1 attempt + 1 retry)
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });

  it('succeeds on second attempt after transient error', async () => {
    mockGenerateContent
      .mockRejectedValueOnce(new Error('transient error'))
      .mockResolvedValueOnce(mockResponse(JSON.stringify(validInsightsPayload)));

    const { insights, rateLimited } = await generateAiInsights(makeCtx());

    expect(insights).not.toBeNull();
    expect(rateLimited).toBe(false);
    expect(insights!.severity).toBe('warning');
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });
});

// ─── Context formatting ───────────────────────────────────────────────────────

describe('generateAiInsights — prompt includes key context', () => {
  it('includes targetUrl in the prompt', async () => {
    mockGenerateContent.mockResolvedValue(mockResponse(JSON.stringify(validInsightsPayload)));

    await generateAiInsights(makeCtx({ targetUrl: 'https://checkout.example.com/api/pay' }));

    const prompt = mockGenerateContent.mock.calls[0][0] as string;
    expect(prompt).toContain('https://checkout.example.com/api/pay');
  });

  it('includes threshold violations in the prompt when present', async () => {
    mockGenerateContent.mockResolvedValue(mockResponse(JSON.stringify(validInsightsPayload)));

    await generateAiInsights(makeCtx({
      thresholdViolations: ['p95 response time 1500ms exceeds threshold 1000ms'],
    }));

    const prompt = mockGenerateContent.mock.calls[0][0] as string;
    expect(prompt).toContain('p95 response time 1500ms exceeds threshold 1000ms');
  });

  it('shows "None" when there are no threshold violations', async () => {
    mockGenerateContent.mockResolvedValue(mockResponse(JSON.stringify(validInsightsPayload)));

    await generateAiInsights(makeCtx({ thresholdViolations: [] }));

    const prompt = mockGenerateContent.mock.calls[0][0] as string;
    expect(prompt).toContain('None');
  });
});
