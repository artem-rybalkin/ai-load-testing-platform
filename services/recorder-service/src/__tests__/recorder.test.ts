import { describe, it, expect, vi } from 'vitest';

// puppeteer-core is a native-binary dep that can't run in the Vitest Node environment.
// We mock the entire module so the pure functions in recorder.ts (compileIgnorePatterns,
// toFlowSteps) can be imported and unit-tested without launching a browser.
vi.mock('puppeteer-core', () => ({
  default: {},
}));

import { compileIgnorePatterns, toFlowSteps } from '../recorder';
import type { RecordedRequest } from '@alt/shared';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const makeRequest = (overrides: Partial<RecordedRequest> = {}): RecordedRequest => ({
  requestId: crypto.randomUUID(),
  url: 'https://api.example.com/login',
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-request-id': 'abc' },
  body: '{"username":"admin"}',
  responseStatus: 200,
  responseHeaders: { 'content-type': 'application/json' },
  responseBody: '{"token":"abc123"}',
  ...overrides,
});

// ─── compileIgnorePatterns ────────────────────────────────────────────────────

describe('compileIgnorePatterns', () => {
  it('returns empty array for empty input', () => {
    expect(compileIgnorePatterns([])).toEqual([]);
  });

  it('filters out empty and whitespace-only strings', () => {
    expect(compileIgnorePatterns(['', '   ', '\t'])).toHaveLength(0);
  });

  it('converts a plain string to a substring-match RegExp', () => {
    const [pattern] = compileIgnorePatterns(['analytics']);
    expect(pattern).toBeInstanceOf(RegExp);
    expect(pattern.test('https://api.example.com/analytics/track')).toBe(true);
    expect(pattern.test('https://api.example.com/users')).toBe(false);
  });

  it('escapes special regex characters in plain strings', () => {
    // The dot in "api.example.com" should match literally, not any char
    const [pattern] = compileIgnorePatterns(['api.example.com']);
    expect(pattern.test('api.example.com/path')).toBe(true);
    expect(pattern.test('apiXexampleYcom')).toBe(false);
  });

  it('escapes asterisk and plus signs in plain strings', () => {
    const [pattern] = compileIgnorePatterns(['a+b*c']);
    expect(pattern.test('a+b*c')).toBe(true);
    expect(pattern.test('aaabbbccc')).toBe(false);
  });

  it('converts a /regex/flags pattern to a RegExp with those flags', () => {
    const [pattern] = compileIgnorePatterns(['/analytics/i']);
    expect(pattern.flags).toContain('i');
    expect(pattern.test('ANALYTICS')).toBe(true);
    expect(pattern.test('Analytics')).toBe(true);
  });

  it('converts a /regex/ pattern without flags', () => {
    const [pattern] = compileIgnorePatterns(['/\\.js$/']);
    expect(pattern.test('bundle.js')).toBe(true);
    expect(pattern.test('bundle.css')).toBe(false);
  });

  it('silently drops invalid regex patterns', () => {
    const result = compileIgnorePatterns(['/[invalid/']);
    expect(result).toHaveLength(0);
  });

  it('returns correct count for a mixed valid/invalid array', () => {
    const result = compileIgnorePatterns(['valid', '/[bad/', '/good/i']);
    expect(result).toHaveLength(2);
  });

  it('trims whitespace from each pattern before processing', () => {
    const [pattern] = compileIgnorePatterns(['  analytics  ']);
    expect(pattern.test('analytics')).toBe(true);
  });

  it('supports multiple flags on a regex pattern', () => {
    const [pattern] = compileIgnorePatterns(['/foo/gi']);
    expect(pattern.flags).toContain('g');
    expect(pattern.flags).toContain('i');
  });

  it('handles an array of multiple valid plain strings', () => {
    const result = compileIgnorePatterns(['analytics', 'hotjar', 'sentry']);
    expect(result).toHaveLength(3);
    expect(result[0].test('analytics')).toBe(true);
    expect(result[1].test('hotjar.com')).toBe(true);
    expect(result[2].test('sentry.io')).toBe(true);
  });
});

// ─── toFlowSteps ─────────────────────────────────────────────────────────────

describe('toFlowSteps', () => {
  it('returns empty array for empty input', () => {
    expect(toFlowSteps([])).toEqual([]);
  });

  it('filters out 5xx server error responses', () => {
    const requests = [
      makeRequest({ url: 'https://api.example.com/ok',  responseStatus: 200 }),
      makeRequest({ url: 'https://api.example.com/err', responseStatus: 500 }),
      makeRequest({ url: 'https://api.example.com/svc', responseStatus: 503 }),
    ];
    const steps = toFlowSteps(requests);
    expect(steps).toHaveLength(1);
    expect(steps[0].url).toBe('https://api.example.com/ok');
  });

  it('does NOT filter out 4xx client error responses', () => {
    const steps = toFlowSteps([
      makeRequest({ responseStatus: 404 }),
      makeRequest({ responseStatus: 401 }),
      makeRequest({ responseStatus: 400 }),
    ]);
    expect(steps).toHaveLength(3);
  });

  it('boundary: status 499 passes, status 500 is filtered', () => {
    expect(toFlowSteps([makeRequest({ responseStatus: 499 })])).toHaveLength(1);
    expect(toFlowSteps([makeRequest({ responseStatus: 500 })])).toHaveLength(0);
  });

  it('caps output at 20 steps when more than 20 requests are provided', () => {
    const requests = Array.from({ length: 25 }, (_, i) =>
      makeRequest({ url: `https://api.example.com/step/${i}`, requestId: `req-${i}` })
    );
    expect(toFlowSteps(requests)).toHaveLength(20);
  });

  it('sets step name as "Step N: METHOD /pathname"', () => {
    const steps = toFlowSteps([
      makeRequest({ url: 'https://api.example.com/login', method: 'POST' }),
    ]);
    expect(steps[0].name).toBe('Step 1: POST /login');
  });

  it('numbers steps sequentially starting at 1', () => {
    const requests = [
      makeRequest({ url: 'https://api.example.com/a', requestId: 'r1' }),
      makeRequest({ url: 'https://api.example.com/b', requestId: 'r2' }),
      makeRequest({ url: 'https://api.example.com/c', requestId: 'r3' }),
    ];
    const steps = toFlowSteps(requests);
    expect(steps[0].name).toMatch(/^Step 1:/);
    expect(steps[1].name).toMatch(/^Step 2:/);
    expect(steps[2].name).toMatch(/^Step 3:/);
  });

  it('numbering reflects post-filter index, not original array index', () => {
    // First request is 500 (filtered), second should become Step 1
    const steps = toFlowSteps([
      makeRequest({ url: 'https://api.example.com/bad',  responseStatus: 500, requestId: 'r1' }),
      makeRequest({ url: 'https://api.example.com/good', responseStatus: 200, requestId: 'r2' }),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0].name).toMatch(/^Step 1:/);
  });

  it('uppercases the HTTP method in the step object', () => {
    const steps = toFlowSteps([makeRequest({ method: 'get' })]);
    expect(steps[0].method).toBe('GET');
  });

  it('preserves the full original URL in step.url', () => {
    const url = 'https://api.example.com/users?page=2&limit=10';
    const steps = toFlowSteps([makeRequest({ url })]);
    expect(steps[0].url).toBe(url);
  });

  it('uses only the pathname in the step name (no query string or fragment)', () => {
    const steps = toFlowSteps([
      makeRequest({ url: 'https://api.example.com/users?page=2#section', method: 'GET' }),
    ]);
    expect(steps[0].name).toBe('Step 1: GET /users');
  });

  it('falls back to the full URL in step name when URL is not parseable', () => {
    const badUrl = 'not-a-valid-url-at-all';
    const steps = toFlowSteps([makeRequest({ url: badUrl })]);
    expect(steps[0].name).toContain(badUrl);
  });

  it('defaults body to empty string when request body is undefined', () => {
    const steps = toFlowSteps([makeRequest({ body: undefined })]);
    expect(steps[0].body).toBe('');
  });

  it('preserves request body when provided', () => {
    const steps = toFlowSteps([makeRequest({ body: '{"key":"value"}' })]);
    expect(steps[0].body).toBe('{"key":"value"}');
  });

  it('initialises extract as an empty object', () => {
    const steps = toFlowSteps([makeRequest()]);
    expect(steps[0].extract).toEqual({});
  });

  it('strips all internal browser-managed headers', () => {
    const internalHeaders: Record<string, string> = {
      'cookie': 'session=abc',
      'authorization': 'Bearer token',
      'host': 'api.example.com',
      'content-length': '42',
      'connection': 'keep-alive',
      'accept-encoding': 'gzip, deflate',
      'accept-language': 'en-US,en',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      'sec-ch-ua': '"Chromium";v="124"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'upgrade-insecure-requests': '1',
      'cache-control': 'no-cache',
      'pragma': 'no-cache',
    };
    const steps = toFlowSteps([makeRequest({ headers: internalHeaders })]);
    expect(steps[0].headers).toEqual({});
  });

  it('strips internal headers matched case-insensitively', () => {
    const steps = toFlowSteps([
      makeRequest({
        headers: { 'Cookie': 'session=abc', 'Authorization': 'Bearer token' },
      }),
    ]);
    expect(steps[0].headers).not.toHaveProperty('Cookie');
    expect(steps[0].headers).not.toHaveProperty('Authorization');
  });

  it('preserves non-trivial application headers', () => {
    const steps = toFlowSteps([
      makeRequest({
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'my-key',
          'x-correlation-id': '12345',
          'accept': 'application/json',
        },
      }),
    ]);
    expect(steps[0].headers!['content-type']).toBe('application/json');
    expect(steps[0].headers!['x-api-key']).toBe('my-key');
    expect(steps[0].headers!['x-correlation-id']).toBe('12345');
    expect(steps[0].headers!['accept']).toBe('application/json');
  });

  it('handles a request with no headers gracefully', () => {
    const steps = toFlowSteps([makeRequest({ headers: {} })]);
    expect(steps[0].headers).toEqual({});
  });
});
