/**
 * Unit tests for routes/helpers.ts's standalone (non-route) exports.
 * No DB/Fastify app needed — these are plain functions.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fetchAndSummarizeSwagger, isValidChatParseResponse } from '../routes/helpers';
import { fetchSsrfSafe } from '@alt/shared';

// Same pattern as ai-endpoints.test.ts: skip real DNS resolution (test
// hostnames aren't real) while still replicating the real SSRF-validation
// behavior fetchSsrfSafe performs before every fetch.
vi.mock('@alt/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alt/shared')>();
  return {
    ...actual,
    fetchSsrfSafe: vi.fn().mockImplementation(async (url: string, init: RequestInit = {}) => {
      const err = actual.validateSsrfSafeUrl(url);
      if (err) throw new Error(`SSRF check failed: ${err}`);
      return (globalThis.fetch as typeof fetch)(url, init);
    }),
  };
});

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);

  // The vi.mock(...) factory above only runs once — with the project's global
  // mockReset: true, fetchSsrfSafe's .mockImplementation() is cleared before
  // every test, so it must be re-established here (same pattern as ai-endpoints.test.ts).
  const actual = await vi.importActual<typeof import('@alt/shared')>('@alt/shared');
  vi.mocked(fetchSsrfSafe).mockImplementation(async (url: string, init: RequestInit = {}) => {
    const err = actual.validateSsrfSafeUrl(url);
    if (err) throw new Error(`SSRF check failed: ${err}`);
    return (globalThis.fetch as typeof fetch)(url, init);
  });
});

describe('fetchAndSummarizeSwagger — SSRF guard', () => {
  it('blocks an SSRF-unsafe URL before any fetch is attempted', async () => {
    const result = await fetchAndSummarizeSwagger('http://169.254.169.254/latest/meta-data/');
    expect(result).toMatch(/^\[Swagger fetch blocked:/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocks an SSRF-unsafe URL even when it looks like a Swagger UI page (discovery loop never reached)', async () => {
    const result = await fetchAndSummarizeSwagger('http://127.0.0.1/swagger-ui/index.html');
    expect(result).toMatch(/^\[Swagger fetch blocked:/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('re-validates each discovery-path candidate URL, not just the original', async () => {
    // A safe host whose swagger-ui page is reachable — every discovery candidate
    // built from the same (already-safe) host must also pass validateSsrfSafeUrl
    // via fetchSsrfSafe, and actually be fetched (not skipped).
    mockFetch.mockResolvedValue({ ok: false, status: 404 });
    await fetchAndSummarizeSwagger('https://api.example.com/swagger-ui/index.html');

    const fetchedUrls = mockFetch.mock.calls.map(c => c[0] as string);
    expect(fetchedUrls).toContain('https://api.example.com/v3/api-docs');
    expect(fetchedUrls).toContain('https://api.example.com/swagger.json');
  });
});

describe('fetchAndSummarizeSwagger — Swagger UI spec discovery', () => {
  it('finds and summarizes a spec via one of the known discovery paths', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === 'https://api.example.com/v3/api-docs') {
        return {
          ok: true,
          text: async () => JSON.stringify({
            info: { title: 'Widgets API' },
            servers: [{ url: 'https://api.example.com' }],
            paths: { '/widgets': { get: { summary: 'List widgets' } } },
          }),
        };
      }
      return { ok: false, status: 404 };
    });

    const result = await fetchAndSummarizeSwagger('https://api.example.com/swagger-ui/index.html');

    expect(result).toContain('Widgets API');
    expect(result).toContain('GET https://api.example.com/widgets');
  });

  it('falls back to fetching the original URL when no discovery path returns a valid spec', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => '<html>Swagger UI</html>' });

    const result = await fetchAndSummarizeSwagger('https://api.example.com/swagger-ui/index.html');

    // Discovery paths (5) + the final fallback fetch of the original URL.
    expect(mockFetch.mock.calls.map((c: unknown[]) => c[0])).toContain('https://api.example.com/swagger-ui/index.html');
    expect(result).toContain('Swagger UI');
  });
});

describe('fetchAndSummarizeSwagger — direct spec fetch (non-Swagger-UI URL)', () => {
  it('summarizes a direct JSON spec URL', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        info: { title: 'Orders API' },
        host: 'orders.example.com',
        schemes: ['https'],
        paths: { '/orders': { post: { summary: 'Create order' } } },
      }),
    });

    const result = await fetchAndSummarizeSwagger('https://orders.example.com/openapi.json');

    expect(result).toContain('Orders API');
    expect(result).toContain('POST https://orders.example.com/orders');
  });

  it('returns a failure message for a non-OK HTTP response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    const result = await fetchAndSummarizeSwagger('https://api.example.com/openapi.json');
    expect(result).toBe('[Swagger fetch failed: HTTP 500]');
  });

  it('returns raw text capped to the context limit when the response is not valid JSON', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => 'not json, just plain text' });
    const result = await fetchAndSummarizeSwagger('https://api.example.com/openapi.json');
    expect(result).toBe('not json, just plain text');
  });

  it('returns a fetch-error message when the network request throws', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await fetchAndSummarizeSwagger('https://api.example.com/openapi.json');
    expect(result).toBe('[Swagger fetch error: ECONNREFUSED]');
  });
});

describe('isValidChatParseResponse', () => {
  it('rejects a non-object value', () => {
    expect(isValidChatParseResponse(null)).toBe(false);
    expect(isValidChatParseResponse('ready')).toBe(false);
  });

  it('rejects an unrecognized status', () => {
    expect(isValidChatParseResponse({ status: 'somethingElse' })).toBe(false);
  });

  describe('needsClarification', () => {
    it('accepts a non-empty question', () => {
      expect(isValidChatParseResponse({ status: 'needsClarification', question: 'What URL?' })).toBe(true);
    });
    it('rejects a missing/empty question', () => {
      expect(isValidChatParseResponse({ status: 'needsClarification', question: '' })).toBe(false);
      expect(isValidChatParseResponse({ status: 'needsClarification' })).toBe(false);
    });
  });

  describe('redirectToFlowBuilder', () => {
    it('accepts a non-empty reason', () => {
      expect(isValidChatParseResponse({ status: 'redirectToFlowBuilder', reason: 'multi-step flow' })).toBe(true);
    });
    it('rejects a missing reason', () => {
      expect(isValidChatParseResponse({ status: 'redirectToFlowBuilder' })).toBe(false);
    });
  });

  describe('ready (backend/client-side config)', () => {
    const validReady = {
      status: 'ready',
      config: {
        type: 'backend',
        targetUrl: 'https://api.example.com',
        description: 'load test',
        options: { vus: 5, duration: '30s' },
      },
    };

    it('accepts a valid backend config', () => {
      expect(isValidChatParseResponse(structuredClone(validReady))).toBe(true);
    });

    it('rejects an invalid config.type', () => {
      const v = structuredClone(validReady);
      (v.config as { type: string }).type = 'flow';
      expect(isValidChatParseResponse(v)).toBe(false);
    });

    it('rejects a missing options object', () => {
      const v = structuredClone(validReady) as { config: Partial<typeof validReady.config> };
      delete v.config.options;
      expect(isValidChatParseResponse(v)).toBe(false);
    });

    it('rejects a non-coercible threshold value', () => {
      const v = structuredClone(validReady) as typeof validReady & { config: { thresholds?: Record<string, unknown> } };
      v.config.thresholds = { p95: 'not-a-number-or-duration' };
      expect(isValidChatParseResponse(v)).toBe(false);
    });
  });

  describe('flowReady', () => {
    const validFlow = {
      status: 'flowReady',
      flow: {
        steps: [{ name: 'Login', url: 'https://api.example.com/login', method: 'POST' }],
        targetUrl: 'https://api.example.com',
        description: 'flow test',
        options: { vus: 5, duration: '30s' },
      },
    };

    it('accepts a valid flow with one well-formed step', () => {
      expect(isValidChatParseResponse(structuredClone(validFlow))).toBe(true);
    });

    it('rejects an empty steps array', () => {
      const v = structuredClone(validFlow);
      v.flow.steps = [];
      expect(isValidChatParseResponse(v)).toBe(false);
    });

    it('rejects a step missing a url', () => {
      const v = structuredClone(validFlow) as { flow: { steps: Array<Partial<{ name: string; url: string; method: string }>> } };
      v.flow.steps = [{ name: 'Login', method: 'POST' }];
      expect(isValidChatParseResponse(v)).toBe(false);
    });

    it('rejects a step with an unsupported HTTP method', () => {
      const v = structuredClone(validFlow);
      v.flow.steps = [{ name: 'Login', url: 'https://api.example.com/login', method: 'TRACE' }];
      expect(isValidChatParseResponse(v)).toBe(false);
    });

    it('rejects a missing flow.targetUrl', () => {
      const v = structuredClone(validFlow) as { flow: Partial<typeof validFlow.flow> };
      delete v.flow.targetUrl;
      expect(isValidChatParseResponse(v)).toBe(false);
    });

    it('rejects a missing flow.options', () => {
      const v = structuredClone(validFlow) as { flow: Partial<typeof validFlow.flow> };
      delete v.flow.options;
      expect(isValidChatParseResponse(v)).toBe(false);
    });

    it('rejects a non-coercible flow.thresholds value', () => {
      const v = structuredClone(validFlow) as typeof validFlow & { flow: { thresholds?: Record<string, unknown> } };
      v.flow.thresholds = { errorRate: 'nope' };
      expect(isValidChatParseResponse(v)).toBe(false);
    });

    it('accepts a valid flow.thresholds value', () => {
      const v = structuredClone(validFlow) as typeof validFlow & { flow: { thresholds?: Record<string, unknown> } };
      v.flow.thresholds = { errorRate: '5' };
      expect(isValidChatParseResponse(v)).toBe(true);
    });
  });
});
