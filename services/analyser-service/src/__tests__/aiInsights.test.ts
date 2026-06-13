import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// ─── Performance — large flow payloads ────────────────────────────────────────

describe('performance', () => {
  // Build a synthetic flow result with a large stepMetrics[] array and a large
  // statusCodes map, simulating a worst-case multi-step flow test.
  const manyStepsMetrics: BackendMetrics = {
    ...baseMetrics,
    statusCodes: Array.from({ length: 50 }, (_, i) => [String(200 + i), 100 - i] as const)
      .reduce((acc, [code, count]) => ({ ...acc, [code]: count }), {} as Record<string, number>),
    stepMetrics: Array.from({ length: 50 }, (_, i) => ({
      name: `Step ${i + 1}: action-${i}`,
      avgResponseTime: 100 + i * 7,
      p95ResponseTime: 200 + ((i * 37) % 1000), // varied, non-monotonic p95 for sort verification
      requestsTotal: 1000 - i,
      requestsFailed: i,
    })),
  };

  it('builds the prompt for a 50-step flow within a generous time budget', async () => {
    mockGenerateContent.mockResolvedValue(mockResponse(JSON.stringify(validInsightsPayload)));

    const start = performance.now();
    await generateAiInsights(makeCtx({ metrics: manyStepsMetrics }));
    const elapsed = performance.now() - start;

    // Prompt construction (buildPayload + formatMetrics + buildPrompt) is pure
    // synchronous string work; even with 50 steps this should be near-instant.
    expect(elapsed).toBeLessThan(100);
  });

  it('caps stepMetrics in the prompt to the top 5 by p95ResponseTime', async () => {
    mockGenerateContent.mockResolvedValue(mockResponse(JSON.stringify(validInsightsPayload)));

    await generateAiInsights(makeCtx({ metrics: manyStepsMetrics }));

    const prompt = mockGenerateContent.mock.calls[0][0] as string;

    // Compute expected top-5 steps by p95ResponseTime (descending), matching
    // the sort+slice(0, 5) implemented in buildPayload's topStepsByP95.
    const top5 = [...manyStepsMetrics.stepMetrics!]
      .sort((a, b) => b.p95ResponseTime - a.p95ResponseTime)
      .slice(0, 5);

    const stepsLine = prompt.split('\n').find(line => line.startsWith('Top steps by p95:'));
    expect(stepsLine).toBeDefined();

    for (const step of top5) {
      expect(stepsLine).toContain(step.name);
    }

    // A step that should NOT be in the top 5 must not appear in the steps line
    const bottomStep = [...manyStepsMetrics.stepMetrics!]
      .sort((a, b) => a.p95ResponseTime - b.p95ResponseTime)[0];
    if (!top5.includes(bottomStep)) {
      expect(stepsLine).not.toContain(bottomStep.name);
    }

    // Exactly 5 steps are listed (each step entry is comma-separated)
    const entryCount = stepsLine!.replace('Top steps by p95: ', '').split(', ').length;
    expect(entryCount).toBe(5);
  });

  it('includes the error breakdown line for a large statusCodes/error map without ballooning prompt size', async () => {
    mockGenerateContent.mockResolvedValue(mockResponse(JSON.stringify(validInsightsPayload)));

    const metricsWithErrors: BackendMetrics = {
      ...manyStepsMetrics,
      errorBreakdown: { success: 900, clientError: 50, serverError: 30, timeout: 15, networkError: 5 },
    };

    await generateAiInsights(makeCtx({ metrics: metricsWithErrors }));

    const prompt = mockGenerateContent.mock.calls[0][0] as string;
    expect(prompt).toContain('Error breakdown: 30 server (5xx), 50 client (4xx), 15 timeouts, 5 network');

    // Even with 50 steps + error breakdown, the prompt stays well within a
    // reasonable token budget (~4 chars/token; 20000 chars ≈ 5000 tokens).
    expect(prompt.length).toBeLessThan(20000);
  });
});
