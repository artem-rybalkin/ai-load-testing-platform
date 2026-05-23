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

  it('includes exec.test.abort instructions when any step has extractions', async () => {
    const test = baseFlow();
    test.steps![0].extract = { token: { source: 'jsonpath', expression: '$.token' } };
    await generateScript(test);
    const prompt = await getLastPrompt();
    expect(prompt).toContain('exec.test.abort');
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
});
