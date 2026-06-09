import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateScript, compareDescriptions } from '../generator';
import type { TestRequest } from '@alt/shared';

// Mock Gemini API — factory must be self-contained (vi.mock is hoisted)
vi.mock('@google/generative-ai', () => {
  const mockFn = vi.fn().mockResolvedValue({
    response: { text: () => "import http from 'k6/http';\nexport default function() {}" },
  });
  class FakeGAI {
    getGenerativeModel() { return { generateContent: mockFn }; }
  }
  (FakeGAI as unknown as { _mockFn: typeof mockFn })._mockFn = mockFn;
  return { GoogleGenerativeAI: FakeGAI };
});

// Accessor for the shared mock function
const getMockFn = async () => {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  return (GoogleGenerativeAI as unknown as { _mockFn: ReturnType<typeof vi.fn> })._mockFn;
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

const getLastPrompt = async () => {
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

  it('includes exec.vu.abort instructions when any step has extractions', async () => {
    const test = baseFlow();
    test.steps![0].extract = { token: { source: 'jsonpath', expression: '$.token' } };
    await generateScript(test);
    const prompt = await getLastPrompt();
    expect(prompt).toContain('exec.vu.abort');
    expect(prompt).toContain("import exec from 'k6/execution'");
  });

  it('does NOT include exec import when no extractions are defined', async () => {
    await generateScript(baseFlow());
    expect(await getLastPrompt()).not.toContain('exec.test.abort');
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

describe('compareDescriptions', () => {
  it('returns REUSE when Gemini responds with REUSE', async () => {
    const fn = await getMockFn();
    fn.mockResolvedValueOnce({ response: { text: () => 'REUSE' } });
    expect(await compareDescriptions('a', 'a')).toBe('REUSE');
  });

  it('returns REGENERATE when Gemini responds with REGENERATE', async () => {
    const fn = await getMockFn();
    fn.mockResolvedValueOnce({ response: { text: () => 'REGENERATE' } });
    expect(await compareDescriptions('a', 'b')).toBe('REGENERATE');
  });

  it('defaults to REGENERATE on unexpected model response', async () => {
    const fn = await getMockFn();
    fn.mockResolvedValueOnce({ response: { text: () => 'maybe' } });
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
    fn.mockResolvedValueOnce({ response: { text: () => 'REUSE' } });

    vi.useFakeTimers();
    try {
      const promise = compareDescriptions('same description', 'same description');
      await vi.runAllTimersAsync();
      expect(await promise).toBe('REUSE');
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      fn.mockReset();
      fn.mockResolvedValue({ response: { text: () => "import http from 'k6/http';\nexport default function() {}" } });
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

  it('includes httpOptions section when http2 is enabled', async () => {
    const test = baseBackend();
    (test.options as never as Record<string, unknown>).httpOptions = { http2: true };
    await generateScript(test);
    expect(await getLastPrompt()).toContain('http2');
  });

  it('includes httpOptions section when discardResponseBodies is enabled', async () => {
    const test = baseBackend();
    (test.options as never as Record<string, unknown>).httpOptions = { discardResponseBodies: true };
    await generateScript(test);
    expect(await getLastPrompt()).toContain('discardResponseBodies');
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
});

// ─── generateScript — 429 retry ──────────────────────────────────────────────

describe('generateScript — 429 retry', () => {
  it('retries once after a 429 rate-limit response and returns the script', async () => {
    const fn = await getMockFn();
    fn.mockClear(); // reset accumulated call count from earlier tests in this file
    fn.mockRejectedValueOnce({ status: 429 });
    fn.mockResolvedValueOnce({ response: { text: () => 'k6 script content' } });

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
      fn.mockResolvedValue({ response: { text: () => "import http from 'k6/http';\nexport default function() {}" } });
    }
  });

  it('throws when non-429 error occurs (no retry)', async () => {
    const fn = await getMockFn();
    fn.mockRejectedValueOnce(new Error('auth error'));

    await expect(generateScript(baseFlow())).rejects.toThrow('auth error');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
