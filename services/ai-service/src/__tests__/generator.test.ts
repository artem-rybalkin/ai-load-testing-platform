import { describe, it, expect, vi } from 'vitest';
import { generateScript, compareDescriptions } from '../generator';
import type { TestRequest } from '@alt/shared';

// Mock the shared AI provider abstraction — factory must be self-contained (vi.mock is hoisted)
vi.mock('@alt/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alt/shared')>();
  const mockFn = vi.fn().mockResolvedValue("import http from 'k6/http';\nexport default function() {}");
  return { ...actual, generateAIText: mockFn };
});

// Mock global fetch so getProviderSetting() (results-service lookup) never makes a real network call
vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch disabled in tests')));

// Accessor for the shared mock function
const getMockFn = async (): Promise<ReturnType<typeof vi.fn>> => {
  const shared = await import('@alt/shared');
  return (shared as unknown as { generateAIText: ReturnType<typeof vi.fn> }).generateAIText;
};

const baseFlow = (): TestRequest => ({
  id: 'test-id',
  type: 'flow',
  targetUrl: 'https://example.com',
  description: 'test',
  options: { vus: 5, duration: '30s' } as never,
  steps: [
    { name: 'Login', url: 'https://example.com/login', method: 'POST', body: '{"u":"admin"}', headers: {}, extract: {} },
    { name: 'Dashboard', url: 'https://example.com/dash', method: 'GET', headers: {}, extract: {} },
  ],
  createdAt: new Date().toISOString(),
});

const getLastPrompt = async (): Promise<string> => {
  const fn = await getMockFn();
  return fn.mock.calls.at(-1)?.[0] as string;
};

describe('FLOW_PROMPT — extraction rules', () => {
  it('renders jsonpath extract rule in step definition', async () => {
    const test = baseFlow();
    test.steps![0].extract = { token: { source: 'jsonpath', expression: '$.access_token' } };
    await generateScript(test);
    expect(await getLastPrompt()).toContain('token ← jsonpath: $.access_token');
  });

  it('renders header extract rule in step definition', async () => {
    const test = baseFlow();
    test.steps![0].extract = { token: { source: 'header', expression: 'X-Auth-Token' } };
    await generateScript(test);
    expect(await getLastPrompt()).toContain('token ← header["X-Auth-Token"]');
  });

  it('renders cookie extract rule in step definition', async () => {
    const test = baseFlow();
    test.steps![0].extract = { sid: { source: 'cookie', expression: 'session' } };
    await generateScript(test);
    expect(await getLastPrompt()).toContain('sid ← cookie["session"]');
  });

  it('renders regex extract rule in step definition', async () => {
    const test = baseFlow();
    test.steps![0].extract = { csrf: { source: 'regex', expression: 'value="([^"]+)"' } };
    await generateScript(test);
    expect(await getLastPrompt()).toContain('csrf ← regex: value="([^"]+)"');
  });

  it('includes defensive-fallback extraction instructions (not exec.vu.abort) when any step has extractions', async () => {
    const test = baseFlow();
    test.steps![0].extract = { token: { source: 'jsonpath', expression: '$.token' } };
    await generateScript(test);
    const prompt = await getLastPrompt();
    // Must instruct AI to use a fallback value and keep running — not abort the VU
    expect(prompt).toContain('DO NOT use exec.vu.abort');
    expect(prompt).toContain('ALL remaining group()s MUST still execute');
    // Must NOT teach the old abort-on-failure pattern that hides later steps from metrics
    expect(prompt).not.toContain("import exec from 'k6/execution'");
  });

  it('does NOT include exec import when no extractions are defined', async () => {
    await generateScript(baseFlow());
    expect(await getLastPrompt()).not.toContain("import exec from 'k6/execution'");
  });
});

describe('FLOW_PROMPT — thresholds', () => {
  it('defaults to p(95)<1000 and rate<0.01 when no thresholds are set on the request', async () => {
    await generateScript(baseFlow());
    const prompt = await getLastPrompt();
    expect(prompt).toContain('p(95) < 1000');
    expect(prompt).toContain('rate < 0.01');
    expect(prompt).toContain("thresholds: { http_req_duration: ['p(95)<1000'], http_req_failed: ['rate<0.01'] }");
  });

  it('reflects a custom SLOThresholds.errorRate/p95 in the generated prompt instead of the hardcoded default', async () => {
    const test = baseFlow();
    test.thresholds = { p95: 500, errorRate: 3 };
    await generateScript(test);
    const prompt = await getLastPrompt();
    expect(prompt).toContain('p(95) < 500');
    expect(prompt).toContain('rate < 0.03');
    expect(prompt).toContain("thresholds: { http_req_duration: ['p(95)<500'], http_req_failed: ['rate<0.03'] }");
  });
});

describe('FLOW_PROMPT — {{varName}} placeholder substitution', () => {
  it('includes placeholder instructions when a step header contains {{varName}}', async () => {
    const test = baseFlow();
    test.steps![0].extract = { access_token: { source: 'jsonpath', expression: '$.access_token' } };
    test.steps![1].headers = { Authorization: 'Bearer {{access_token}}' };
    await generateScript(test);
    const prompt = await getLastPrompt();
    expect(prompt).toContain('Variable placeholders');
    expect(prompt).toContain('{{varName}}');
  });

  it('includes placeholder instructions when a step body contains {{varName}}', async () => {
    const test = baseFlow();
    test.steps![0].extract = { session_id: { source: 'jsonpath', expression: '$.session_id' } };
    test.steps![1].body = '{"sessionId":"{{session_id}}"}';
    await generateScript(test);
    expect(await getLastPrompt()).toContain('Variable placeholders');
  });

  it('does NOT include placeholder instructions when no step has a {{varName}} placeholder', async () => {
    await generateScript(baseFlow());
    expect(await getLastPrompt()).not.toContain('Variable placeholders');
  });
});

describe('FLOW_PROMPT — parameterization', () => {
  it('includes SharedArray and open(data.json) when testData is provided', async () => {
    const test = baseFlow();
    test.testData = [{ username: 'user1', password: 'pass1' }, { username: 'user2', password: 'pass2' }];
    await generateScript(test);
    const prompt = await getLastPrompt();
    expect(prompt).toContain('SharedArray');
    expect(prompt).toContain("open('./data.json')");
    expect(prompt).toContain('username');
    expect(prompt).toContain('data.length');
  });

  it('includes SharedArray and open(data.csv) when csvData is provided', async () => {
    const test = baseFlow();
    test.csvData = Buffer.from('username,password\nuser1,pass1').toString('base64');
    await generateScript(test);
    const prompt = await getLastPrompt();
    expect(prompt).toContain('SharedArray');
    expect(prompt).toContain("open('./data.csv')");
    expect(prompt).toContain('username');
  });

  it('does NOT include SharedArray when neither testData nor csvData is provided', async () => {
    await generateScript(baseFlow());
    expect(await getLastPrompt()).not.toContain('SharedArray');
  });
});

describe('FLOW_PROMPT — combined extract + placeholder + parameterization', () => {
  it('renders extract rules, {{varName}} placeholders, and SharedArray parameterization together', async () => {
    const test = baseFlow();
    test.steps![0].extract = {
      access_token: { source: 'jsonpath', expression: '$.access_token' },
      csrf: { source: 'regex', expression: 'value="([^"]+)"' },
    };
    test.steps![1].headers = { Authorization: 'Bearer {{access_token}}' };
    test.steps![1].body = '{"csrf":"{{csrf}}","username":"{{username}}"}';
    test.testData = [
      { username: 'user1', password: 'pass1' },
      { username: 'user2', password: 'pass2' },
    ];

    await generateScript(test);
    const prompt = await getLastPrompt();

    // Extract rules rendered
    expect(prompt).toContain('access_token ← jsonpath: $.access_token');
    expect(prompt).toContain('csrf ← regex: value="([^"]+)"');

    // Extraction instructions: defensive fallback pattern, no exec.vu.abort (which hides later steps)
    expect(prompt).toContain('DO NOT use exec.vu.abort');
    expect(prompt).toContain('ALL remaining group()s MUST still execute');

    // Placeholder instructions present
    expect(prompt).toContain('Variable placeholders');
    expect(prompt).toContain('{{varName}}');

    // Parameterization (SharedArray) present
    expect(prompt).toContain('SharedArray');
    expect(prompt).toContain("open('./data.json')");
    expect(prompt).toContain('username');
    expect(prompt).toContain('data.length');

    // All sections appear in the same prompt without duplication issues
    const sharedArrayCount = prompt.split('SharedArray').length - 1;
    expect(sharedArrayCount).toBeGreaterThanOrEqual(1);
  });
});

describe('compareDescriptions', () => {
  it('returns REUSE when Gemini responds with REUSE', async () => {
    const fn = await getMockFn();
    fn.mockResolvedValueOnce('REUSE');
    expect(await compareDescriptions('a', 'a')).toBe('REUSE');
  });

  it('returns REGENERATE when Gemini responds with REGENERATE', async () => {
    const fn = await getMockFn();
    fn.mockResolvedValueOnce('REGENERATE');
    expect(await compareDescriptions('a', 'b')).toBe('REGENERATE');
  });

  it('defaults to REGENERATE on unexpected model response', async () => {
    const fn = await getMockFn();
    fn.mockResolvedValueOnce('maybe');
    expect(await compareDescriptions('a', 'b')).toBe('REGENERATE');
  });

  it('returns REGENERATE on generic error (non-429)', async () => {
    const fn = await getMockFn();
    fn.mockRejectedValueOnce(new Error('network failure'));
    expect(await compareDescriptions('a', 'b')).toBe('REGENERATE');
  });

  it('retries once after a 429 rate-limit response and returns the verdict', async () => {
    const fn = await getMockFn();
    fn.mockClear(); // reset accumulated call count from earlier tests in this file
    fn.mockRejectedValueOnce({ status: 429 });
    fn.mockResolvedValueOnce('REUSE');

    vi.useFakeTimers();
    try {
      const promise = compareDescriptions('same description', 'same description');
      await vi.runAllTimersAsync();
      expect(await promise).toBe('REUSE');
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      fn.mockReset();
      fn.mockResolvedValue("import http from 'k6/http';\nexport default function() {}");
    }
  });
});

// ─── BACKEND_PROMPT ───────────────────────────────────────────────────────────

const baseBackend = (): TestRequest => ({
  id: 'test-id',
  type: 'backend',
  targetUrl: 'https://api.example.com/users',
  description: 'load test the users endpoint',
  options: { vus: 10, duration: '30s' } as never,
  createdAt: new Date().toISOString(),
});

describe('BACKEND_PROMPT — basic content', () => {
  it('includes the targetUrl in the prompt', async () => {
    await generateScript(baseBackend());
    expect(await getLastPrompt()).toContain('https://api.example.com/users');
  });

  it('includes the description in the prompt', async () => {
    await generateScript(baseBackend());
    expect(await getLastPrompt()).toContain('load test the users endpoint');
  });

  it('instructs Gemini to return only k6 JavaScript code', async () => {
    await generateScript(baseBackend());
    expect(await getLastPrompt()).toContain('k6 JavaScript API');
    expect(await getLastPrompt()).toContain('Return ONLY the JavaScript code');
  });

  it('includes httpOptions section when discardResponseBodies is enabled', async () => {
    const test = baseBackend();
    (test.options as never as Record<string, unknown>).httpOptions = { discardResponseBodies: true };
    await generateScript(test);
    expect(await getLastPrompt()).toContain('discardResponseBodies');
  });

  it('includes custom headers instructions when headers are provided', async () => {
    const test = baseBackend();
    (test.options as never as Record<string, unknown>).headers = { 'X-Api-Key': 'secret123' };
    await generateScript(test);
    const prompt = await getLastPrompt();
    expect(prompt).toContain('Custom headers');
    expect(prompt).toContain('X-Api-Key');
    expect(prompt).toContain('secret123');
  });

  it('does NOT include custom headers section when no headers are provided', async () => {
    await generateScript(baseBackend());
    expect(await getLastPrompt()).not.toContain('Custom headers');
  });

  it('instructs logging failed requests via console.error', async () => {
    await generateScript(baseBackend());
    const prompt = await getLastPrompt();
    expect(prompt).toContain('Log failures');
    expect(prompt).toContain('console.error');
  });

  it('includes literal FAILED console.error examples for both sample requests, unevaluated', async () => {
    await generateScript(baseBackend());
    const prompt = await getLastPrompt();
    const occurrences = prompt.match(/if \(res\.status === 0 \|\| res\.status >= 400\) console\.error\(`FAILED \$\{res\.status\} \$\{res\.request\.url\}`\);/g);
    expect(occurrences).toHaveLength(2);
  });

  it('defaults to p(95)<1000 and rate<0.01 when no thresholds are set on the request', async () => {
    await generateScript(baseBackend());
    const prompt = await getLastPrompt();
    expect(prompt).toContain('p(95) < 1000');
    expect(prompt).toContain('rate < 0.01');
    expect(prompt).toContain("thresholds: { http_req_duration: ['p(95)<1000'], http_req_failed: ['rate<0.01'] }");
  });

  it('reflects a custom SLOThresholds.errorRate/p95 in the generated prompt instead of the hardcoded default', async () => {
    const test = baseBackend();
    test.thresholds = { p95: 2000, errorRate: 5 };
    await generateScript(test);
    const prompt = await getLastPrompt();
    expect(prompt).toContain('p(95) < 2000');
    expect(prompt).toContain('rate < 0.05');
    expect(prompt).toContain("thresholds: { http_req_duration: ['p(95)<2000'], http_req_failed: ['rate<0.05'] }");
  });
});

describe('BACKEND_PROMPT — profileInstructions', () => {
  const makeBackendWithProfile = (profile: string, extra?: object): TestRequest => ({
    ...baseBackend(),
    options: { vus: 10, duration: '2m', profile, peakVus: 100, ...extra } as never,
  });

  it('includes SPIKE TEST instructions for spike profile', async () => {
    await generateScript(makeBackendWithProfile('spike'));
    expect(await getLastPrompt()).toContain('SPIKE TEST');
    expect(await getLastPrompt()).toContain('spike');
  });

  it('includes CAPACITY / STRESS TEST instructions for capacity profile', async () => {
    await generateScript(makeBackendWithProfile('capacity'));
    expect(await getLastPrompt()).toContain('CAPACITY');
  });

  it('includes SOAK TEST instructions for soak profile', async () => {
    await generateScript(makeBackendWithProfile('soak'));
    expect(await getLastPrompt()).toContain('SOAK TEST');
  });

  it('uses flat VU load profile (default load) with no profile specified', async () => {
    const test = baseBackend(); // no profile key
    await generateScript(test);
    expect(await getLastPrompt()).toContain('LOAD TEST');
  });

  it('includes ramp-up instruction when rampUp is provided for load profile', async () => {
    const test: TestRequest = {
      ...baseBackend(),
      options: { vus: 10, duration: '1m', profile: 'load', rampUp: '30s' } as never,
    };
    await generateScript(test);
    expect(await getLastPrompt()).toContain('30s');
  });
});

// ─── CLIENT_PROMPT ────────────────────────────────────────────────────────────

const baseClient = (): TestRequest => ({
  id: 'test-id',
  type: 'client-side',
  targetUrl: 'https://www.example.com',
  description: 'measure page load performance',
  options: { sessions: 5, duration: '60s', collectWebVitals: true } as never,
  createdAt: new Date().toISOString(),
});

describe('CLIENT_PROMPT', () => {
  it('includes the targetUrl in the prompt', async () => {
    await generateScript(baseClient());
    expect(await getLastPrompt()).toContain('https://www.example.com');
  });

  it('includes the description in the prompt', async () => {
    await generateScript(baseClient());
    expect(await getLastPrompt()).toContain('measure page load performance');
  });

  it('includes the sessions count', async () => {
    await generateScript(baseClient());
    expect(await getLastPrompt()).toContain('5');
  });

  it('includes Web Vitals collection instructions', async () => {
    await generateScript(baseClient());
    const prompt = await getLastPrompt();
    expect(prompt).toContain('Web Vitals');
    expect(prompt).toContain('Puppeteer');
  });

  it('includes setExtraHTTPHeaders instructions when headers are provided', async () => {
    const test = baseClient();
    (test.options as never as Record<string, unknown>).headers = { 'X-Api-Key': 'secret123' };
    await generateScript(test);
    const prompt = await getLastPrompt();
    expect(prompt).toContain('setExtraHTTPHeaders');
    expect(prompt).toContain('X-Api-Key');
    expect(prompt).toContain('secret123');
  });

  it('does NOT include setExtraHTTPHeaders instructions when no headers are provided', async () => {
    await generateScript(baseClient());
    expect(await getLastPrompt()).not.toContain('setExtraHTTPHeaders');
  });
});

// ─── generateScript — 429 retry ──────────────────────────────────────────────

describe('generateScript — 429 retry', () => {
  it('retries once after a 429 rate-limit response and returns the script', async () => {
    const fn = await getMockFn();
    fn.mockClear(); // reset accumulated call count from earlier tests in this file
    fn.mockRejectedValueOnce({ status: 429 });
    fn.mockResolvedValueOnce('k6 script content');

    vi.useFakeTimers();
    try {
      const promise = generateScript(baseFlow());
      await vi.runAllTimersAsync();
      const script = await promise;
      expect(script).toBe('k6 script content');
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      fn.mockReset();
      fn.mockResolvedValue("import http from 'k6/http';\nexport default function() {}");
    }
  });

  it('throws when non-429 error occurs (no retry)', async () => {
    const fn = await getMockFn();
    fn.mockRejectedValueOnce(new Error('auth error'));

    await expect(generateScript(baseFlow())).rejects.toThrow('auth error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts all 3 attempts on repeated 429s and throws the final error', async () => {
    const fn = await getMockFn();
    fn.mockClear();
    fn.mockRejectedValueOnce({ status: 429 });
    fn.mockRejectedValueOnce({ status: 429 });
    fn.mockRejectedValueOnce({ status: 429 });

    vi.useFakeTimers();
    try {
      const promise = generateScript(baseFlow());
      const expectation = expect(promise).rejects.toMatchObject({ status: 429 });
      await vi.runAllTimersAsync();
      await expectation;
      expect(fn).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
      fn.mockReset();
      fn.mockResolvedValue("import http from 'k6/http';\nexport default function() {}");
    }
  });
});

// ─── compareDescriptions — full retry exhaustion ─────────────────────────────

describe('compareDescriptions — retry exhaustion', () => {
  it('defaults to REGENERATE after exhausting all 3 attempts on repeated 429s', async () => {
    const fn = await getMockFn();
    fn.mockClear();
    fn.mockRejectedValueOnce({ status: 429 });
    fn.mockRejectedValueOnce({ status: 429 });
    fn.mockRejectedValueOnce({ status: 429 });

    vi.useFakeTimers();
    try {
      const promise = compareDescriptions('a', 'b');
      await vi.runAllTimersAsync();
      expect(await promise).toBe('REGENERATE');
      expect(fn).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
      fn.mockReset();
      fn.mockResolvedValue("import http from 'k6/http';\nexport default function() {}");
    }
  });
});

// ─── Performance — FLOW_PROMPT construction for a large flow ────────────────

describe('performance', () => {
  it('builds FLOW_PROMPT for a 20-step flow with extract rules, placeholders, and testData within budget', async () => {
    const fn = await getMockFn();
    fn.mockClear();

    const STEP_COUNT = 20;
    const steps: TestRequest['steps'] = [];
    for (let i = 0; i < STEP_COUNT; i++) {
      const varName = `var${i}`;
      steps.push({
        name: `Step ${i}`,
        url: `https://example.com/api/resource${i}`,
        method: i % 2 === 0 ? 'POST' : 'GET',
        body: JSON.stringify({ value: `{{var${Math.max(0, i - 1)}}}`, id: i }),
        headers: { Authorization: `Bearer {{var${Math.max(0, i - 1)}}}`, 'X-Step': String(i) },
        extract: {
          [varName]: { source: 'jsonpath', expression: `$.data.${varName}` },
        },
      });
    }

    const testData: Array<Record<string, string>> = [];
    for (let row = 0; row < 10; row++) {
      const record: Record<string, string> = {};
      for (let col = 0; col < 5; col++) {
        record[`col${col}`] = `value-${row}-${col}`;
      }
      testData.push(record);
    }

    const test: TestRequest = {
      ...baseFlow(),
      steps,
      testData,
    };

    const start = performance.now();
    await generateScript(test);
    const elapsed = performance.now() - start;

    const prompt = await getLastPrompt();
    expect(prompt).toContain('SharedArray');
    expect(prompt).toContain('Step 19');
    expect(prompt).toContain('Variable placeholders');
    expect(prompt).toContain('exec.vu.abort');

    // Regression guard: prompt construction for a large 20-step flow should be fast.
    expect(elapsed).toBeLessThan(200);
  });
});

// ─── Per-team AI provider resolution (AI-15 Phase C) ─────────────────────────

describe('getProviderSetting — per-team resolution', () => {
  it('passes projectId as ?teamId= when generateScript is called for a team', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'gemini', fallbacks: [], available: {}, isOverride: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const test = baseFlow();
    test.projectId = 'team-alpha';
    await generateScript(test);

    const url = String(fetchMock.mock.calls.find(([u]) => String(u).includes('/system/ai-provider'))?.[0]);
    expect(url).toContain(`teamId=${encodeURIComponent('team-alpha')}`);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch disabled in tests')));
  });

  it('omits ?teamId= when no projectId is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'gemini', fallbacks: [], available: {} }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const test = baseFlow();
    test.projectId = undefined;
    await generateScript(test);

    const url = String(fetchMock.mock.calls.find(([u]) => String(u).includes('/system/ai-provider'))?.[0]);
    expect(url).not.toContain('teamId=');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch disabled in tests')));
  });

  it('caches provider settings independently per team', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'openai', fallbacks: [], available: {}, isOverride: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const testA = baseFlow();
    testA.projectId = 'team-cache-a';
    const testB = baseFlow();
    testB.projectId = 'team-cache-b';

    await generateScript(testA);
    await generateScript(testB);
    await generateScript(testA); // should hit the per-team cache, not refetch

    const aiProviderCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/system/ai-provider'));
    expect(aiProviderCalls.length).toBe(2); // one fetch per distinct teamId

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch disabled in tests')));
  });

  it('passes projectId from cachedScriptDescription comparison through compareDescriptions', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'gemini', fallbacks: [], available: {}, isOverride: false }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await compareDescriptions('new description', 'old description', 'team-compare');

    const url = String(fetchMock.mock.calls.find(([u]) => String(u).includes('/system/ai-provider'))?.[0]);
    expect(url).toContain(`teamId=${encodeURIComponent('team-compare')}`);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch disabled in tests')));
  });
});
