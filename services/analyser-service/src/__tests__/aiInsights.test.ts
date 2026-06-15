import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the shared AI provider abstraction — factory must be self-contained (vi.mock is hoisted)
vi.mock('@alt/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alt/shared')>();
  const mockFn = vi.fn();
  return { ...actual, generateAIText: mockFn };
});

// Mock global fetch so getProviderSetting() (results-service lookup) never makes a real network call
vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch disabled in tests')));

// Accessor for the shared mock function
const getMockFn = async (): Promise<ReturnType<typeof vi.fn>> => {
  const shared = await import('@alt/shared');
  return (shared as unknown as { generateAIText: ReturnType<typeof vi.fn> }).generateAIText;
};

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

const makeCtx = (overrides: Partial<Parameters<typeof generateAiInsights>[0]> = {}): Parameters<typeof generateAiInsights>[0] => ({
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

beforeEach(async () => {
  const mock = await getMockFn();
  mock.mockReset();
  process.env.GEMINI_API_KEY = 'test-key';
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('generateAiInsights — happy path', () => {
  it('returns AiInsights when the AI provider returns valid JSON', async () => {
    const mock = await getMockFn();
    mock.mockResolvedValue(JSON.stringify(validInsightsPayload));

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
    const mock = await getMockFn();
    const wrapped = `\`\`\`json\n${JSON.stringify(validInsightsPayload)}\n\`\`\``;
    mock.mockResolvedValue(wrapped);

    const { insights } = await generateAiInsights(makeCtx());

    expect(insights).not.toBeNull();
    expect(insights!.severity).toBe('warning');
  });

  it('accepts severity "critical"', async () => {
    const mock = await getMockFn();
    mock.mockResolvedValue(JSON.stringify({ ...validInsightsPayload, severity: 'critical' }));

    const { insights } = await generateAiInsights(makeCtx());

    expect(insights!.severity).toBe('critical');
  });

  it('accepts severity "info"', async () => {
    const mock = await getMockFn();
    mock.mockResolvedValue(JSON.stringify({ ...validInsightsPayload, severity: 'info' }));

    const { insights } = await generateAiInsights(makeCtx());

    expect(insights!.severity).toBe('info');
  });

  it('accepts empty anomalies and rootCauses arrays', async () => {
    const mock = await getMockFn();
    mock.mockResolvedValue(JSON.stringify({ ...validInsightsPayload, anomalies: [], rootCauses: [] }));

    const { insights } = await generateAiInsights(makeCtx());

    expect(insights!.anomalies).toEqual([]);
    expect(insights!.rootCauses).toEqual([]);
  });
});

// ─── No AI provider configured ─────────────────────────────────────────────────

describe('generateAiInsights — no provider configured', () => {
  it('returns null insights immediately when no AI provider API key is set', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const mock = await getMockFn();
    const { insights, rateLimited } = await generateAiInsights(makeCtx());

    expect(insights).toBeNull();
    expect(rateLimited).toBe(false);
    expect(mock).not.toHaveBeenCalled();
  });
});

// ─── Error cases ──────────────────────────────────────────────────────────────

describe('generateAiInsights — error cases', () => {
  it('returns null insights when the AI provider returns invalid JSON', async () => {
    const mock = await getMockFn();
    mock.mockResolvedValue('not json at all');

    const { insights, rateLimited } = await generateAiInsights(makeCtx());

    expect(insights).toBeNull();
    expect(rateLimited).toBe(false);
  });

  it('returns null insights when response is missing required fields', async () => {
    const mock = await getMockFn();
    mock.mockResolvedValue(JSON.stringify({ narrative: 'ok' }));

    const { insights } = await generateAiInsights(makeCtx());

    expect(insights).toBeNull();
  });

  it('returns null insights when severity is not one of the allowed values', async () => {
    const mock = await getMockFn();
    mock.mockResolvedValue(JSON.stringify({ ...validInsightsPayload, severity: 'unknown' }));

    const { insights } = await generateAiInsights(makeCtx());

    expect(insights).toBeNull();
  });

  it('returns rateLimited=true on rate limit error (429)', async () => {
    const mock = await getMockFn();
    const err = Object.assign(new Error('429 quota exceeded'), { status: 429 });
    mock.mockRejectedValue(err);

    const { insights, rateLimited } = await generateAiInsights(makeCtx());

    expect(insights).toBeNull();
    expect(rateLimited).toBe(true);
    // Should not retry on rate limit
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('returns null insights after exhausting retries on generic API error', async () => {
    const mock = await getMockFn();
    mock.mockRejectedValue(new Error('service unavailable'));

    const { insights, rateLimited } = await generateAiInsights(makeCtx());

    expect(insights).toBeNull();
    expect(rateLimited).toBe(false);
    // Should try twice (1 attempt + 1 retry)
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('succeeds on second attempt after transient error', async () => {
    const mock = await getMockFn();
    mock
      .mockRejectedValueOnce(new Error('transient error'))
      .mockResolvedValueOnce(JSON.stringify(validInsightsPayload));

    const { insights, rateLimited } = await generateAiInsights(makeCtx());

    expect(insights).not.toBeNull();
    expect(rateLimited).toBe(false);
    expect(insights!.severity).toBe('warning');
    expect(mock).toHaveBeenCalledTimes(2);
  });
});

// ─── Context formatting ───────────────────────────────────────────────────────

describe('generateAiInsights — prompt includes key context', () => {
  it('includes targetUrl in the prompt', async () => {
    const mock = await getMockFn();
    mock.mockResolvedValue(JSON.stringify(validInsightsPayload));

    await generateAiInsights(makeCtx({ targetUrl: 'https://checkout.example.com/api/pay' }));

    const prompt = mock.mock.calls[0][0] as string;
    expect(prompt).toContain('https://checkout.example.com/api/pay');
  });

  it('includes threshold violations in the prompt when present', async () => {
    const mock = await getMockFn();
    mock.mockResolvedValue(JSON.stringify(validInsightsPayload));

    await generateAiInsights(makeCtx({
      thresholdViolations: ['p95 response time 1500ms exceeds threshold 1000ms'],
    }));

    const prompt = mock.mock.calls[0][0] as string;
    expect(prompt).toContain('p95 response time 1500ms exceeds threshold 1000ms');
  });

  it('shows "None" when there are no threshold violations', async () => {
    const mock = await getMockFn();
    mock.mockResolvedValue(JSON.stringify(validInsightsPayload));

    await generateAiInsights(makeCtx({ thresholdViolations: [] }));

    const prompt = mock.mock.calls[0][0] as string;
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
    const mock = await getMockFn();
    mock.mockResolvedValue(JSON.stringify(validInsightsPayload));

    const start = performance.now();
    await generateAiInsights(makeCtx({ metrics: manyStepsMetrics }));
    const elapsed = performance.now() - start;

    // Prompt construction (buildPayload + formatMetrics + buildPrompt) is pure
    // synchronous string work; even with 50 steps this should be near-instant.
    expect(elapsed).toBeLessThan(100);
  });

  it('caps stepMetrics in the prompt to the top 5 by p95ResponseTime', async () => {
    const mock = await getMockFn();
    mock.mockResolvedValue(JSON.stringify(validInsightsPayload));

    await generateAiInsights(makeCtx({ metrics: manyStepsMetrics }));

    const prompt = mock.mock.calls[0][0] as string;

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
    const mock = await getMockFn();
    mock.mockResolvedValue(JSON.stringify(validInsightsPayload));

    const metricsWithErrors: BackendMetrics = {
      ...manyStepsMetrics,
      errorBreakdown: { success: 900, clientError: 50, serverError: 30, timeout: 15, networkError: 5 },
    };

    await generateAiInsights(makeCtx({ metrics: metricsWithErrors }));

    const prompt = mock.mock.calls[0][0] as string;
    expect(prompt).toContain('Error breakdown: 30 server (5xx), 50 client (4xx), 15 timeouts, 5 network');

    // Even with 50 steps + error breakdown, the prompt stays well within a
    // reasonable token budget (~4 chars/token; 20000 chars ≈ 5000 tokens).
    expect(prompt.length).toBeLessThan(20000);
  });
});

// ─── Per-team AI provider resolution (AI-15 Phase C) ──────────────────────────

describe('generateAiInsights — per-team provider resolution', () => {
  it('passes ctx.teamId as ?teamId= when fetching the provider setting', async () => {
    const mock = await getMockFn();
    mock.mockResolvedValue(JSON.stringify(validInsightsPayload));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'gemini', fallbacks: [], available: {}, isOverride: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await generateAiInsights(makeCtx({ teamId: 'team-alpha' }));

    const url = String(fetchMock.mock.calls.find(([u]) => String(u).includes('/system/ai-provider'))?.[0]);
    expect(url).toContain(`teamId=${encodeURIComponent('team-alpha')}`);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch disabled in tests')));
  });

  it('omits ?teamId= when ctx.teamId is not set', async () => {
    const mock = await getMockFn();
    mock.mockResolvedValue(JSON.stringify(validInsightsPayload));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'gemini', fallbacks: [], available: {} }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await generateAiInsights(makeCtx({ teamId: null }));

    const url = String(fetchMock.mock.calls.find(([u]) => String(u).includes('/system/ai-provider'))?.[0]);
    expect(url).not.toContain('teamId=');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch disabled in tests')));
  });

  it('caches provider settings independently per team', async () => {
    const mock = await getMockFn();
    mock.mockResolvedValue(JSON.stringify(validInsightsPayload));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'openai', fallbacks: [], available: {}, isOverride: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await generateAiInsights(makeCtx({ teamId: 'team-cache-a' }));
    await generateAiInsights(makeCtx({ teamId: 'team-cache-b' }));
    await generateAiInsights(makeCtx({ teamId: 'team-cache-a' })); // should hit the per-team cache, not refetch

    const aiProviderCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/system/ai-provider'));
    expect(aiProviderCalls.length).toBe(2); // one fetch per distinct teamId

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch disabled in tests')));
  });
});
