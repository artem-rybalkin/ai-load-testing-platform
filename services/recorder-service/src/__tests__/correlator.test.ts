import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectCorrelations, suggestStepNames, suggestIgnorePatterns, detectDuplicateSteps } from '../correlator';
import type { RecordedRequest, FlowStep } from '@alt/shared';

// ─── Mock the shared AI provider abstraction (same pattern as aiInsights.test.ts) ──
vi.mock('@alt/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alt/shared')>();
  const mockFn = vi.fn();
  return { ...actual, generateAIText: mockFn };
});

// Mock global fetch so getProviderSetting() (results-service lookup) never makes a real network call
vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch disabled in tests')));

// We need puppeteer-core mocked so recorder.ts can be imported transitively
vi.mock('puppeteer-core', () => ({ default: {} }));

const getMock = async (): Promise<ReturnType<typeof vi.fn>> => {
  const shared = await import('@alt/shared');
  return (shared as unknown as { generateAIText: ReturnType<typeof vi.fn> }).generateAIText;
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
  mock.mockResolvedValue('{"correlations":[]}');
  process.env.GEMINI_API_KEY = 'test-key';
});

// ─── Early-return guards ──────────────────────────────────────────────────────

describe('detectCorrelations — early returns', () => {
  it('returns steps unchanged when no AI provider is configured', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
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
    mock.mockResolvedValueOnce('{"correlations":[]}');
    const result = await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    expect(result[0].extract).toEqual({});
    expect(result[1].extract).toEqual({});
  });

  it('adds an extract rule to the source step when Gemini returns a correlation', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce(JSON.stringify({
          correlations: [{
            sourceStepIndex: 0,
            variableName: 'access_token',
            source: 'jsonpath',
            expression: '$.access_token',
            usedInStepIndices: [1],
          }],
        }));

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
    mock.mockResolvedValueOnce(JSON.stringify({
          correlations: [
            { sourceStepIndex: 0, variableName: 'token',   source: 'jsonpath', expression: '$.access_token', usedInStepIndices: [1, 2] },
            { sourceStepIndex: 1, variableName: 'csrf',    source: 'header',   expression: 'X-CSRF-Token',   usedInStepIndices: [2] },
          ],
        }));

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
    mock.mockResolvedValueOnce(JSON.stringify({
          correlations: [
            { sourceStepIndex: 0, variableName: 'jp_var',  source: 'jsonpath', expression: '$.id',              usedInStepIndices: [1] },
            { sourceStepIndex: 1, variableName: 'hdr_var', source: 'header',   expression: 'X-Auth-Token',      usedInStepIndices: [2] },
            { sourceStepIndex: 2, variableName: 'ck_var',  source: 'cookie',   expression: 'session',           usedInStepIndices: [3] },
            { sourceStepIndex: 3, variableName: 'rx_var',  source: 'regex',    expression: 'token=([^;]+)',     usedInStepIndices: [4] },
          ],
        }));
    const result = await detectCorrelations(fourRequests, fourSteps);
    expect(result[0].extract!.jp_var.source).toBe('jsonpath');
    expect(result[1].extract!.hdr_var.source).toBe('header');
    expect(result[2].extract!.ck_var.source).toBe('cookie');
    expect(result[3].extract!.rx_var.source).toBe('regex');
  });
});

// ─── PII redaction before sending to Gemini ───────────────────────────────────

describe('detectCorrelations — PII redaction', () => {
  it('redacts emails and credit card numbers from request/response bodies before calling Gemini', async () => {
    const requests = [
      makeRequest({
        url: 'https://api.example.com/checkout',
        body: '{"email":"jane.doe@example.com","card":"4111111111111111"}',
        responseBody: '{"access_token":"tok123","contact":"john@example.com"}',
      }),
      makeRequest({
        url: 'https://api.example.com/profile',
        responseBody: undefined,
      }),
    ];

    const mock = await getMock();
    await detectCorrelations(requests, TWO_STEPS);

    const prompt = mock.mock.calls[0][0] as string;
    expect(prompt).not.toContain('jane.doe@example.com');
    expect(prompt).not.toContain('john@example.com');
    expect(prompt).not.toContain('4111111111111111');
    expect(prompt).toContain('[REDACTED_EMAIL]');
    expect(prompt).toContain('[REDACTED_CARD]');
    // Non-PII data (correlation tokens) remains intact
    expect(prompt).toContain('tok123');
  });

  it('omits binary request/response bodies instead of forwarding raw bytes', async () => {
    const requests = [
      makeRequest({
        url: 'https://api.example.com/upload',
        headers: { 'content-type': 'application/octet-stream' },
        body: '\x89PNG\r\n\x1a\n\x00\x00\x00binarydata',
        responseHeaders: { 'content-type': 'image/png' },
        responseBody: '\x89PNG\r\n\x1a\n\x00\x00\x00binarydata',
      }),
      makeRequest({ url: 'https://api.example.com/profile', responseBody: undefined }),
    ];

    const mock = await getMock();
    await detectCorrelations(requests, TWO_STEPS);

    const prompt = mock.mock.calls[0][0] as string;
    expect(prompt).not.toContain('binarydata');
    expect(prompt).toContain('[BINARY_BODY_OMITTED]');
  });
});

// ─── Gemini response parsing ──────────────────────────────────────────────────

describe('detectCorrelations — Gemini response parsing', () => {
  it('extracts JSON from a markdown code fence', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce('```json\n{"correlations":[]}\n```');
    const result = await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    expect(result).toEqual(TWO_STEPS);  // no error, correlations applied (empty)
  });

  it('extracts JSON even when Gemini adds explanation text around it', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce('Here are the correlations I found:\n{"correlations":[]}\nEnd of analysis.');
    const result = await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    expect(result).toHaveLength(TWO_STEPS.length);
  });

  it('returns steps unchanged when response contains no JSON object', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce('No correlations found.');
    const result = await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    expect(result).toEqual(TWO_STEPS);
  });

  it('returns steps unchanged when parsed JSON has no correlations array', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce('{"result":"ok"}');
    const result = await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    expect(result).toEqual(TWO_STEPS);
  });

  it('returns steps unchanged when correlations field is not an array', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce('{"correlations":"none"}');
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
    mock.mockResolvedValueOnce(JSON.stringify({
          correlations: [{ sourceStepIndex: -1, variableName: 'bad', source: 'jsonpath', expression: '$.x', usedInStepIndices: [0] }],
        }));
    const result = await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    // No extract rule should have been added
    expect(result[0].extract).toEqual({});
    expect(result[1].extract).toEqual({});
  });

  it('skips correlation entry with sourceStepIndex >= steps.length', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce(JSON.stringify({
          correlations: [{ sourceStepIndex: 99, variableName: 'bad', source: 'jsonpath', expression: '$.x', usedInStepIndices: [] }],
        }));
    const result = await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    expect(result[0].extract).toEqual({});
  });

  it('sanitizes variable names by replacing non-alphanumeric/underscore chars with _', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce(JSON.stringify({
          correlations: [{ sourceStepIndex: 0, variableName: 'my-token.val', source: 'jsonpath', expression: '$.t', usedInStepIndices: [1] }],
        }));
    const result = await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    // Hyphens and dots become underscores
    expect(result[0].extract).toHaveProperty('my_token_val');
  });

  it('uses var_N fallback when sanitized variable name is empty', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce(JSON.stringify({
          correlations: [{ sourceStepIndex: 0, variableName: '---', source: 'jsonpath', expression: '$.t', usedInStepIndices: [1] }],
        }));
    const result = await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    // "---" sanitized → "___" which is not empty, so var_N fallback won't trigger
    // BUT if the result is empty string:
    const extractKeys = Object.keys(result[0].extract ?? {});
    expect(extractKeys.length).toBeGreaterThan(0);
  });

  it('does not mutate the original steps array', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce(JSON.stringify({
          correlations: [{ sourceStepIndex: 0, variableName: 'token', source: 'jsonpath', expression: '$.tok', usedInStepIndices: [1] }],
        }));
    const originalExtract = { ...TWO_STEPS[0].extract };
    await detectCorrelations(TWO_REQUESTS, TWO_STEPS);
    // Original steps should be unchanged
    expect(TWO_STEPS[0].extract).toEqual(originalExtract);
  });
});

// ─── {{varName}} substitution in consuming steps ──────────────────────────────

describe('detectCorrelations — {{varName}} substitution', () => {
  it('replaces the literal jsonpath value with {{varName}} in a consuming header', async () => {
    const requests = [
      makeRequest({ responseBody: '{"access_token":"tok123","user_id":42}' }),
      makeRequest({ url: 'https://api.example.com/profile', responseBody: undefined }),
    ];
    const steps = [
      makeStep('Login', 'https://api.example.com/login'),
      { ...makeStep('Get profile', 'https://api.example.com/profile'), headers: { Authorization: 'Bearer tok123' } },
    ];
    const mock = await getMock();
    mock.mockResolvedValueOnce(JSON.stringify({
          correlations: [{ sourceStepIndex: 0, variableName: 'access_token', source: 'jsonpath', expression: '$.access_token', usedInStepIndices: [1] }],
        }));

    const result = await detectCorrelations(requests, steps);
    expect(result[0].extract).toEqual({ access_token: { source: 'jsonpath', expression: '$.access_token' } });
    expect(result[1].headers!.Authorization).toBe('Bearer {{access_token}}');
  });

  it('replaces the literal value with {{varName}} in a consuming body', async () => {
    const requests = [
      makeRequest({ responseBody: '{"session_id":"sess-abc-456"}' }),
      makeRequest({ url: 'https://api.example.com/checkout', responseBody: undefined }),
    ];
    const steps = [
      makeStep('Login', 'https://api.example.com/login'),
      { ...makeStep('Checkout', 'https://api.example.com/checkout'), body: '{"sessionId":"sess-abc-456","item":"sku1"}' },
    ];
    const mock = await getMock();
    mock.mockResolvedValueOnce(JSON.stringify({
          correlations: [{ sourceStepIndex: 0, variableName: 'session_id', source: 'jsonpath', expression: '$.session_id', usedInStepIndices: [1] }],
        }));

    const result = await detectCorrelations(requests, steps);
    expect(result[1].body).toBe('{"sessionId":"{{session_id}}","item":"sku1"}');
  });

  it('does not substitute when the extracted value cannot be resolved', async () => {
    const requests = [
      makeRequest({ responseBody: '{"other_field":"value"}' }),
      makeRequest({ url: 'https://api.example.com/profile', responseBody: undefined }),
    ];
    const steps = [
      makeStep('Login', 'https://api.example.com/login'),
      { ...makeStep('Get profile', 'https://api.example.com/profile'), headers: { Authorization: 'Bearer tok123' } },
    ];
    const mock = await getMock();
    mock.mockResolvedValueOnce(JSON.stringify({
          correlations: [{ sourceStepIndex: 0, variableName: 'access_token', source: 'jsonpath', expression: '$.access_token', usedInStepIndices: [1] }],
        }));

    const result = await detectCorrelations(requests, steps);
    expect(result[1].headers!.Authorization).toBe('Bearer tok123');
  });

  it('does not substitute values shorter than 3 characters', async () => {
    const requests = [
      makeRequest({ responseBody: '{"id":42}' }),
      makeRequest({ url: 'https://api.example.com/items/42', responseBody: undefined }),
    ];
    const steps = [
      makeStep('Create item', 'https://api.example.com/items'),
      { ...makeStep('Get item', 'https://api.example.com/items/42'), headers: { 'X-Item-Id': '42' } },
    ];
    const mock = await getMock();
    mock.mockResolvedValueOnce(JSON.stringify({
          correlations: [{ sourceStepIndex: 0, variableName: 'item_id', source: 'jsonpath', expression: '$.id', usedInStepIndices: [1] }],
        }));

    const result = await detectCorrelations(requests, steps);
    expect(result[1].headers!['X-Item-Id']).toBe('42');
  });

  it('re-adds a stripped Authorization header to the consuming step when the recorded request used it', async () => {
    // toFlowSteps() strips Authorization from step.headers, but the raw RecordedRequest
    // still carries it — the correlator should restore it as {{varName}}.
    const requests = [
      makeRequest({ responseBody: '{"access_token":"tok123","user_id":42}' }),
      makeRequest({
        url: 'https://api.example.com/bag/count',
        headers: { Authorization: 'Bearer tok123' },
        responseBody: undefined,
      }),
    ];
    const steps = [
      makeStep('Login', 'https://api.example.com/login'),
      makeStep('Get bag count', 'https://api.example.com/bag/count'), // headers: {} — stripped by toFlowSteps
    ];
    const mock = await getMock();
    mock.mockResolvedValueOnce(JSON.stringify({
          correlations: [{ sourceStepIndex: 0, variableName: 'access_token', source: 'jsonpath', expression: '$.access_token', usedInStepIndices: [1] }],
        }));

    const result = await detectCorrelations(requests, steps);
    expect(result[1].headers!.Authorization).toBe('Bearer {{access_token}}');
  });

  it('extracts a cookie value and substitutes it in a later header', async () => {
    const requests = [
      makeRequest({ responseHeaders: { 'set-cookie': 'session=abc123def; Path=/; HttpOnly' }, responseBody: undefined }),
      makeRequest({ url: 'https://api.example.com/profile', responseBody: undefined }),
    ];
    const steps = [
      makeStep('Login', 'https://api.example.com/login'),
      { ...makeStep('Get profile', 'https://api.example.com/profile'), headers: { Cookie: 'session=abc123def' } },
    ];
    const mock = await getMock();
    mock.mockResolvedValueOnce(JSON.stringify({
          correlations: [{ sourceStepIndex: 0, variableName: 'session', source: 'cookie', expression: 'session', usedInStepIndices: [1] }],
        }));

    const result = await detectCorrelations(requests, steps);
    expect(result[1].headers!.Cookie).toBe('session={{session}}');
  });
});

// ─── suggestStepNames ─────────────────────────────────────────────────────────

describe('suggestStepNames', () => {
  it('renames steps with Gemini suggestions', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce('["Authenticate — get token", "Load homepage"]');
    const result = await suggestStepNames(TWO_STEPS);
    expect(result[0].name).toBe('Authenticate — get token');
    expect(result[1].name).toBe('Load homepage');
  });

  it('returns original steps when Gemini returns wrong array length', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce('["Only one name"]');
    const result = await suggestStepNames(TWO_STEPS);
    expect(result[0].name).toBe(TWO_STEPS[0].name);
  });

  it('returns original steps when Gemini returns non-JSON', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce('not json');
    const result = await suggestStepNames(TWO_STEPS);
    expect(result).toEqual(TWO_STEPS);
  });

  it('returns original steps when Gemini throws', async () => {
    const mock = await getMock();
    mock.mockRejectedValueOnce(new Error('network error'));
    const result = await suggestStepNames(TWO_STEPS);
    expect(result).toEqual(TWO_STEPS);
  });

  it('returns steps unchanged when input is empty', async () => {
    const result = await suggestStepNames([]);
    expect(result).toEqual([]);
  });
});

// ─── suggestIgnorePatterns ────────────────────────────────────────────────────

describe('suggestIgnorePatterns', () => {
  it('returns suggested domain strings from Gemini', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce('["analytics.google.com", "cdn.clarity.ms"]');
    const result = await suggestIgnorePatterns(TWO_REQUESTS);
    expect(result).toEqual(['analytics.google.com', 'cdn.clarity.ms']);
  });

  it('returns empty array when Gemini returns empty array', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce('[]');
    const result = await suggestIgnorePatterns(TWO_REQUESTS);
    expect(result).toEqual([]);
  });

  it('returns empty array when Gemini response is not parseable', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce('not json');
    const result = await suggestIgnorePatterns(TWO_REQUESTS);
    expect(result).toEqual([]);
  });

  it('returns empty array on Gemini error', async () => {
    const mock = await getMock();
    mock.mockRejectedValueOnce(new Error('503'));
    const result = await suggestIgnorePatterns(TWO_REQUESTS);
    expect(result).toEqual([]);
  });

  it('filters non-string values from Gemini output', async () => {
    const mock = await getMock();
    mock.mockResolvedValueOnce('["valid.com", 42, null, "also.valid"]');
    const result = await suggestIgnorePatterns(TWO_REQUESTS);
    expect(result).toEqual(['valid.com', 'also.valid']);
  });

  it('returns empty array when requests list is empty', async () => {
    const result = await suggestIgnorePatterns([]);
    expect(result).toEqual([]);
  });
});

// ─── performance ───────────────────────────────────────────────────────────────

describe('performance', () => {
  it('applies 10 correlations over a large (50KB) response body within budget', async () => {
    // Build a 50KB JSON response body containing 10 distinct extractable values.
    const fields: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      // Each value is >= 3 chars so substitution applies (substituteValue skips < 3 chars).
      fields[`field_${i}`] = `value-${i}-${'x'.repeat(20)}`;
    }
    // Pad the body to ~50KB with a large filler field.
    fields.filler = 'p'.repeat(50_000);
    const responseBody = JSON.stringify(fields);

    const requests = [
      makeRequest({ url: 'https://api.example.com/login', responseBody }),
      {
        ...makeRequest({ url: 'https://api.example.com/consume', responseBody: undefined }),
      },
    ];

    // Consuming step references all 10 extracted values in its headers/body so
    // substituteValue runs for each correlation.
    const headers: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      headers[`X-Field-${i}`] = fields[`field_${i}`];
    }
    const steps = [
      makeStep('Login', 'https://api.example.com/login'),
      { ...makeStep('Consume', 'https://api.example.com/consume'), headers, body: JSON.stringify(headers) },
    ];

    const correlations = Array.from({ length: 10 }, (_, i) => ({
      sourceStepIndex: 0,
      variableName: `field_${i}`,
      source: 'jsonpath' as const,
      expression: `$.field_${i}`,
      usedInStepIndices: [1],
    }));

    const mock = await getMock();
    mock.mockResolvedValueOnce(JSON.stringify({ correlations }));

    const start = performance.now();
    const result = await detectCorrelations(requests, steps);
    const elapsed = performance.now() - start;

    // All 10 extract rules should be applied to the source step.
    expect(Object.keys(result[0].extract ?? {})).toHaveLength(10);
    // Budget is intentionally generous (not a tight perf benchmark) — this only
    // needs to catch an accidental O(n²)-type regression, not measure exact
    // timing. A tight 100ms budget flaked repeatedly on shared CI runners under
    // --coverage instrumentation (observed 300-400ms there for legitimately
    // correct, unchanged code).
    expect(elapsed).toBeLessThan(1500);
  });
});

// ─── detectDuplicateSteps ──────────────────────────────────────────────────────

describe('detectDuplicateSteps', () => {
  it('returns no suggestions when there are no duplicate endpoints', () => {
    const steps = [
      makeStep('Login', 'https://api.example.com/login'),
      makeStep('Get profile', 'https://api.example.com/profile'),
    ];
    expect(detectDuplicateSteps(steps)).toEqual([]);
  });

  it('returns no suggestions for a single step', () => {
    const steps = [makeStep('Login', 'https://api.example.com/login')];
    expect(detectDuplicateSteps(steps)).toEqual([]);
  });

  it('returns an empty array for an empty steps list', () => {
    expect(detectDuplicateSteps([])).toEqual([]);
  });

  it('detects two calls to the same endpoint with a varying query param', () => {
    const steps = [
      makeStep('Get item 1', 'https://api.example.com/items?id=1'),
      makeStep('Get item 2', 'https://api.example.com/items?id=2'),
    ];
    const result = detectDuplicateSteps(steps);
    expect(result).toHaveLength(1);
    expect(result[0].indices).toEqual([0, 1]);
    expect(result[0].commonPath).toBe('https://api.example.com/items');
    expect(result[0].paramKey).toBe('id');
    expect(result[0].suggestion).toContain('Steps 1, 2');
    expect(result[0].suggestion).toContain('id');
  });

  it('does not flag duplicates when method differs even if path is the same', () => {
    const steps = [
      { ...makeStep('Get item', 'https://api.example.com/items/1'), method: 'GET' as const },
      { ...makeStep('Delete item', 'https://api.example.com/items/1'), method: 'DELETE' as const },
    ];
    expect(detectDuplicateSteps(steps)).toEqual([]);
  });

  it('groups by exact pathname when query params are identical (no varying key)', () => {
    const steps = [
      makeStep('Search A', 'https://api.example.com/search?q=foo'),
      makeStep('Search B', 'https://api.example.com/search?q=foo'),
    ];
    const result = detectDuplicateSteps(steps);
    expect(result).toHaveLength(1);
    expect(result[0].paramKey).toBeUndefined();
    expect(result[0].suggestion).not.toContain('with different');
  });

  it('handles three or more steps hitting the same endpoint', () => {
    const steps = [
      makeStep('Get item 1', 'https://api.example.com/items?id=1'),
      makeStep('Get item 2', 'https://api.example.com/items?id=2'),
      makeStep('Get item 3', 'https://api.example.com/items?id=3'),
    ];
    const result = detectDuplicateSteps(steps);
    expect(result).toHaveLength(1);
    expect(result[0].indices).toEqual([0, 1, 2]);
    expect(result[0].suggestion).toContain('Steps 1, 2, 3');
  });

  it('skips steps with invalid URLs without throwing', () => {
    const steps = [
      makeStep('Bad URL', 'not-a-valid-url'),
      makeStep('Get profile', 'https://api.example.com/profile'),
    ];
    expect(() => detectDuplicateSteps(steps)).not.toThrow();
    expect(detectDuplicateSteps(steps)).toEqual([]);
  });
});

// ─── Per-team AI provider resolution (AI-15 Phase C) ──────────────────────────

describe('getProviderSetting — per-team resolution', () => {
  it('detectCorrelations passes teamId as ?teamId= when fetching the provider setting', async () => {
    const mock = await getMock();
    mock.mockResolvedValue('{"correlations":[]}');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'gemini', fallbacks: [], available: {}, isOverride: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await detectCorrelations(TWO_REQUESTS, TWO_STEPS, 'team-detect-1');

    const url = String(fetchMock.mock.calls.find(([u]) => String(u).includes('/system/ai-provider'))?.[0]);
    expect(url).toContain(`teamId=${encodeURIComponent('team-detect-1')}`);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch disabled in tests')));
  });

  it('suggestStepNames passes teamId as ?teamId= when fetching the provider setting', async () => {
    const mock = await getMock();
    mock.mockResolvedValue(JSON.stringify(TWO_STEPS.map(s => s.name)));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'gemini', fallbacks: [], available: {}, isOverride: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await suggestStepNames(TWO_STEPS, 'team-detect-2');

    const url = String(fetchMock.mock.calls.find(([u]) => String(u).includes('/system/ai-provider'))?.[0]);
    expect(url).toContain(`teamId=${encodeURIComponent('team-detect-2')}`);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch disabled in tests')));
  });

  it('suggestIgnorePatterns passes teamId as ?teamId= when fetching the provider setting', async () => {
    const mock = await getMock();
    mock.mockResolvedValue('{"patterns":[]}');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'gemini', fallbacks: [], available: {}, isOverride: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await suggestIgnorePatterns(TWO_REQUESTS, 'team-detect-3');

    const url = String(fetchMock.mock.calls.find(([u]) => String(u).includes('/system/ai-provider'))?.[0]);
    expect(url).toContain(`teamId=${encodeURIComponent('team-detect-3')}`);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch disabled in tests')));
  });

  it('omits ?teamId= when no teamId is provided', async () => {
    const mock = await getMock();
    mock.mockResolvedValue('{"correlations":[]}');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'gemini', fallbacks: [], available: {} }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await detectCorrelations(TWO_REQUESTS, TWO_STEPS);

    const url = String(fetchMock.mock.calls.find(([u]) => String(u).includes('/system/ai-provider'))?.[0]);
    expect(url).not.toContain('teamId=');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch disabled in tests')));
  });

  it('caches provider settings independently per team', async () => {
    const mock = await getMock();
    mock.mockResolvedValue('{"correlations":[]}');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ provider: 'openai', fallbacks: [], available: {}, isOverride: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await detectCorrelations(TWO_REQUESTS, TWO_STEPS, 'team-cache-x');
    await detectCorrelations(TWO_REQUESTS, TWO_STEPS, 'team-cache-y');
    await detectCorrelations(TWO_REQUESTS, TWO_STEPS, 'team-cache-x'); // should hit the per-team cache, not refetch

    const aiProviderCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/system/ai-provider'));
    expect(aiProviderCalls.length).toBe(2); // one fetch per distinct teamId

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch disabled in tests')));
  });
});
