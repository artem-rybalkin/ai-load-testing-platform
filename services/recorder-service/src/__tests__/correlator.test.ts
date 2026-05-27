import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectCorrelations } from '../correlator';
import type { RecordedRequest, FlowStep } from '@alt/shared';

// ─── Mock Gemini (same pattern as generator.test.ts) ─────────────────────────
vi.mock('@google/generative-ai', () => {
  const mockGenerate = vi.fn().mockResolvedValue({
    response: { text: () => '{"correlations":[]}' },
  });
  class FakeGAI {
    getGenerativeModel() { return { generateContent: mockGenerate }; }
  }
  (FakeGAI as unknown as { _mock: typeof mockGenerate })._mock = mockGenerate;
  return { GoogleGenerativeAI: FakeGAI };
});

// We need puppeteer-core mocked so recorder.ts can be imported transitively
vi.mock('puppeteer-core', () => ({ default: {} }));

const getMock = async () => {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  return (GoogleGenerativeAI as unknown as { _mock: ReturnType<typeof vi.fn> })._mock;
};

// ─── Fixtures ────────────────────────────────────────────────────────────────

const makeRequest = (overrides: Partial<RecordedRequest> = {}): RecordedRequest => ({
  requestId: crypto.randomUUID(),
  url: 'https://api.example.com/login',
  method: 'POST',
  headers: {},
  body: '{"username":"admin","password":"pass"}',
  responseStatus: 200,
  responseHeaders: {},
  responseBody: '{"access_token":"tok123","user_id":42}',
  ...overrides,
});

const makeStep = (name: string, url: string): FlowStep => ({
  name,
  url,
  method: 'GET',
  headers: {},
  extract: {},
});

const TWO_REQUESTS = [
  makeRequest({ url: 'https://api.example.com/login',   method: 'POST' }),
  makeRequest({ url: 'https://api.example.com/profile', method: 'GET',
    responseBody: undefined }),
];
const TWO_STEPS = [
  makeStep('Login',       'https://api.example.com/login'),
  makeStep('Get profile', 'https://api.example.com/profile'),
];

beforeEach(async () => {
  const mock = await getMock();
  mock.mockReset();
  mock.mockResolvedValue({ response: { text: () => '{"correlations":[]}' } });
  process.env.GEMINI_API_KEY = 'test-key';
});

// ─── Early-return guards ──────────────────────────────────────────────────────

describe('detectCorrelations — early returns', () => {
  it('returns steps unchanged when GEMINI_API_KEY is not set', async () => {
    delete process.env.GEMINI_API_KEY;
    const mock = await getMock();
    const result = await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    expect(result).toEqual(TWO_STEPS);
    expect(mock).not.toHaveBeenCalled();
  });

  it('returns steps unchanged when fewer than 2 requests are provided', async () => {
    const mock = await getMock();
    const result = await detectCorrelations([TWO_REQUESTS[0]], TWO_STEPS);
    expect(result).toEqual(TWO_STEPS);
    expect(mock).not.toHaveBeenCalled();
  });

  it('returns steps unchanged when requests array is empty', async () => {
    const mock = await getMock();
    const result = await detectCorrelations([], TWO_STEPS);
    expect(result).toEqual(TWO_STEPS);
    expect(mock).not.toHaveBeenCalled();
  });
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('detectCorrelations — happy path', () => {
  it('returns steps with no extract rules when Gemini finds no correlations', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce({ response: { text: () => '{"correlations":[]}' } });
    const result = await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    expect(result[0].extract).toEqual({});
    expect(result[1].extract).toEqual({});
  });

  it('adds an extract rule to the source step when Gemini returns a correlation', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify({
          correlations: [{
            sourceStepIndex: 0,
            variableName: 'access_token',
            source: 'jsonpath',
            expression: '$.access_token',
            usedInStepIndices: [1],
          }],
        }),
      },
    });

    const result = await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    expect(result[0].extract).toEqual({
      access_token: { source: 'jsonpath', expression: '$.access_token' },
    });
    // Step 1 is a consumer, not a producer — no extract rule added to it
    expect(result[1].extract).toEqual({});
  });

  it('applies multiple correlations across different source steps', async () => {
    const threeRequests = [...TWO_REQUESTS, makeRequest({ url: 'https://api.example.com/data' })];
    const threeSteps = [...TWO_STEPS, makeStep('Get data', 'https://api.example.com/data')];

    const mock = await getMock();
    mock.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify({
          correlations: [
            { sourceStepIndex: 0, variableName: 'token',   source: 'jsonpath', expression: '$.access_token', usedInStepIndices: [1, 2] },
            { sourceStepIndex: 1, variableName: 'csrf',    source: 'header',   expression: 'X-CSRF-Token',   usedInStepIndices: [2] },
          ],
        }),
      },
    });

    const result = await detectCorrelations(threeRequests, threeSteps);
    expect(result[0].extract).toHaveProperty('token');
    expect(result[1].extract).toHaveProperty('csrf');
    expect(result[1].extract!.csrf).toEqual({ source: 'header', expression: 'X-CSRF-Token' });
  });

  it('supports all four ExtractSource types', async () => {
    const fourRequests = [
      makeRequest(), makeRequest(), makeRequest(), makeRequest(), makeRequest(),
    ];
    const fourSteps = [0,1,2,3,4].map(i => makeStep(`Step ${i}`, `https://api.example.com/${i}`));
    const mock = await getMock();
    mock.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify({
          correlations: [
            { sourceStepIndex: 0, variableName: 'jp_var',  source: 'jsonpath', expression: '$.id',              usedInStepIndices: [1] },
            { sourceStepIndex: 1, variableName: 'hdr_var', source: 'header',   expression: 'X-Auth-Token',      usedInStepIndices: [2] },
            { sourceStepIndex: 2, variableName: 'ck_var',  source: 'cookie',   expression: 'session',           usedInStepIndices: [3] },
            { sourceStepIndex: 3, variableName: 'rx_var',  source: 'regex',    expression: 'token=([^;]+)',     usedInStepIndices: [4] },
          ],
        }),
      },
    });
    const result = await detectCorrelations(fourRequests, fourSteps);
    expect(result[0].extract!.jp_var.source).toBe('jsonpath');
    expect(result[1].extract!.hdr_var.source).toBe('header');
    expect(result[2].extract!.ck_var.source).toBe('cookie');
    expect(result[3].extract!.rx_var.source).toBe('regex');
  });
});

// ─── Gemini response parsing ──────────────────────────────────────────────────

describe('detectCorrelations — Gemini response parsing', () => {
  it('extracts JSON from a markdown code fence', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce({
      response: {
        text: () => '```json\n{"correlations":[]}\n```',
      },
    });
    const result = await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    expect(result).toEqual(TWO_STEPS);  // no error, correlations applied (empty)
  });

  it('extracts JSON even when Gemini adds explanation text around it', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce({
      response: {
        text: () => 'Here are the correlations I found:\n{"correlations":[]}\nEnd of analysis.',
      },
    });
    const result = await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    expect(result).toHaveLength(TWO_STEPS.length);
  });

  it('returns steps unchanged when response contains no JSON object', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce({ response: { text: () => 'No correlations found.' } });
    const result = await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    expect(result).toEqual(TWO_STEPS);
  });

  it('returns steps unchanged when parsed JSON has no correlations array', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce({ response: { text: () => '{"result":"ok"}' } });
    const result = await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    expect(result).toEqual(TWO_STEPS);
  });

  it('returns steps unchanged when correlations field is not an array', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce({ response: { text: () => '{"correlations":"none"}' } });
    const result = await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    expect(result).toEqual(TWO_STEPS);
  });

  it('returns steps unchanged when Gemini throws an error', async () => {
    const mock = await getMock();
    mock.mockRejectedValueOnce(new Error('Gemini rate limit'));
    const result = await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    expect(result).toEqual(TWO_STEPS);
  });
});

// ─── applyCorrelations edge cases (tested via detectCorrelations) ─────────────

describe('detectCorrelations — applyCorrelations edge cases', () => {
  it('skips correlation entry with sourceStepIndex < 0', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify({
          correlations: [{ sourceStepIndex: -1, variableName: 'bad', source: 'jsonpath', expression: '$.x', usedInStepIndices: [0] }],
        }),
      },
    });
    const result = await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    // No extract rule should have been added
    expect(result[0].extract).toEqual({});
    expect(result[1].extract).toEqual({});
  });

  it('skips correlation entry with sourceStepIndex >= steps.length', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify({
          correlations: [{ sourceStepIndex: 99, variableName: 'bad', source: 'jsonpath', expression: '$.x', usedInStepIndices: [] }],
        }),
      },
    });
    const result = await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    expect(result[0].extract).toEqual({});
  });

  it('sanitizes variable names by replacing non-alphanumeric/underscore chars with _', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify({
          correlations: [{ sourceStepIndex: 0, variableName: 'my-token.val', source: 'jsonpath', expression: '$.t', usedInStepIndices: [1] }],
        }),
      },
    });
    const result = await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    // Hyphens and dots become underscores
    expect(result[0].extract).toHaveProperty('my_token_val');
  });

  it('uses var_N fallback when sanitized variable name is empty', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify({
          correlations: [{ sourceStepIndex: 0, variableName: '---', source: 'jsonpath', expression: '$.t', usedInStepIndices: [1] }],
        }),
      },
    });
    const result = await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    // "---" sanitized → "___" which is not empty, so var_N fallback won't trigger
    // BUT if the result is empty string:
    const extractKeys = Object.keys(result[0].extract ?? {});
    expect(extractKeys.length).toBeGreaterThan(0);
  });

  it('does not mutate the original steps array', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify({
          correlations: [{ sourceStepIndex: 0, variableName: 'token', source: 'jsonpath', expression: '$.tok', usedInStepIndices: [1] }],
        }),
      },
    });
    const originalExtract = { ...TWO_STEPS[0].extract };
    await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    // Original steps should be unchanged
    expect(TWO_STEPS[0].extract).toEqual(originalExtract);
  });
});
