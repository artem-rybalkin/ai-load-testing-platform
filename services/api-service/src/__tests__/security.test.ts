import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../index';
import { publishTest, publishCancel, isQueueConnected } from '../queue';
import { findExistingScript, checkDbHealth } from '../scripts';

vi.mock('../queue', () => ({
  publishTest: vi.fn(),
  publishCancel: vi.fn(),
  isQueueConnected: vi.fn().mockReturnValue(true),
  connectQueue: vi.fn().mockResolvedValue(undefined),
  getWorkerConsumerCount: vi.fn().mockResolvedValue(1),
}));

vi.mock('../scripts', () => ({
  findExistingScript: vi.fn().mockResolvedValue(null),
  checkDbHealth: vi.fn().mockResolvedValue(undefined),
  incrementUsedCount: vi.fn().mockResolvedValue(undefined),
  stepsToKey: vi.fn().mockReturnValue('flow:abc123'),
  pool: {},
}));

let app: FastifyInstance;
let mockFetch: ReturnType<typeof vi.fn>;

const validBody = {
  type: 'backend',
  targetUrl: 'http://example.com',
  description: 'smoke test',
  options: { vus: 5, duration: '30s' },
};

beforeAll(async () => {
  app = await buildApp();
  mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal('fetch', mockFetch);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isQueueConnected).mockReturnValue(true);
  vi.mocked(findExistingScript).mockResolvedValue(null);
  vi.mocked(checkDbHealth).mockResolvedValue(undefined);
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
});

// ─── API Key Authentication ───────────────────────────────────────────────────

describe('API Key Authentication', () => {
  it('allows requests when API_KEYS env var is empty (dev mode)', async () => {
    // Default test env has API_KEYS='' (vitest.config.ts sets placeholder)
    const res = await app.inject({ method: 'POST', url: '/tests', payload: validBody });
    expect(res.statusCode).toBe(200);
  });

  it('GET /health is always exempt from auth', async () => {
    const originalKeys = process.env.API_KEYS;
    process.env.API_KEYS = 'secret-key';
    const app2 = await buildApp();

    try {
      const res = await app2.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).not.toBe(401);
    } finally {
      process.env.API_KEYS = originalKeys;
      await app2.close();
    }
  });

  it('returns 401 when API_KEYS set and header missing', async () => {
    const originalKeys = process.env.API_KEYS;
    process.env.API_KEYS = 'secret-key';
    const app2 = await buildApp();

    try {
      const res = await app2.inject({
        method: 'POST',
        url: '/tests',
        payload: validBody,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('Unauthorized');
    } finally {
      process.env.API_KEYS = originalKeys;
      await app2.close();
    }
  });

  it('returns 401 when API_KEYS set and wrong key provided', async () => {
    const originalKeys = process.env.API_KEYS;
    process.env.API_KEYS = 'correct-key';
    const app2 = await buildApp();

    try {
      const res = await app2.inject({
        method: 'POST',
        url: '/tests',
        payload: validBody,
        headers: { 'X-API-Key': 'wrong-key' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      process.env.API_KEYS = originalKeys;
      await app2.close();
    }
  });

  it('returns 200 when API_KEYS set and correct key provided', async () => {
    const originalKeys = process.env.API_KEYS;
    process.env.API_KEYS = 'valid-key';
    const app2 = await buildApp();

    try {
      const res = await app2.inject({
        method: 'POST',
        url: '/tests',
        payload: validBody,
        headers: { 'X-API-Key': 'valid-key' },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      process.env.API_KEYS = originalKeys;
      await app2.close();
    }
  });

  it('accepts any key from comma-separated API_KEYS list', async () => {
    const originalKeys = process.env.API_KEYS;
    process.env.API_KEYS = 'key-one,key-two,key-three';
    const app2 = await buildApp();

    try {
      const res = await app2.inject({
        method: 'POST',
        url: '/tests',
        payload: validBody,
        headers: { 'X-API-Key': 'key-two' },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      process.env.API_KEYS = originalKeys;
      await app2.close();
    }
  });
});

// ─── Input Validation ─────────────────────────────────────────────────────────

describe('Input validation', () => {
  it('rejects invalid URL format', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tests',
      payload: { ...validBody, targetUrl: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('URL');
  });

  it('rejects description longer than 500 characters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tests',
      payload: { ...validBody, description: 'a'.repeat(501) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('500');
  });

  it('rejects more than 20 steps in a flow test', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tests',
      payload: {
        type: 'flow',
        targetUrl: 'http://example.com',
        description: 'flow',
        options: { vus: 5, duration: '30s' },
        steps: Array(21).fill({ name: 'step', url: 'http://example.com', method: 'GET' }),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('20');
  });

  it('accepts valid URL with http scheme', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tests',
      payload: { ...validBody, targetUrl: 'http://api.example.com/endpoint' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('accepts valid URL with https scheme', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tests',
      payload: { ...validBody, targetUrl: 'https://api.example.com/path?q=1' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects invalid test type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tests',
      payload: { ...validBody, type: 'invalid' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Invalid test type');
  });

  it('accepts description exactly 500 characters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tests',
      payload: { ...validBody, description: 'a'.repeat(500) },
    });
    expect(res.statusCode).toBe(200);
  });

  it('accepts flow with exactly 20 steps', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tests',
      payload: {
        type: 'flow',
        targetUrl: 'http://example.com',
        description: 'flow',
        options: { vus: 5, duration: '30s' },
        steps: Array(20).fill({ name: 'step', url: 'http://example.com', method: 'GET' }),
      },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ─── CORS ─────────────────────────────────────────────────────────────────────

describe('CORS headers', () => {
  it('includes CORS headers in response (default wildcard in dev)', async () => {
    const originalOrigin = process.env.ALLOWED_ORIGIN;
    process.env.ALLOWED_ORIGIN = '*';
    const app2 = await buildApp();

    try {
      const res = await app2.inject({
        method: 'OPTIONS',
        url: '/tests',
        headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST' },
      });
      expect(res.headers['access-control-allow-origin']).toBeDefined();
    } finally {
      process.env.ALLOWED_ORIGIN = originalOrigin;
      await app2.close();
    }
  });

  it('uses ALLOWED_ORIGIN env var when set', async () => {
    const originalOrigin = process.env.ALLOWED_ORIGIN;
    process.env.ALLOWED_ORIGIN = 'https://myapp.example.com';
    const app2 = await buildApp();

    try {
      const res = await app2.inject({
        method: 'GET',
        url: '/health',
        headers: { Origin: 'https://myapp.example.com' },
      });
      const corsHeader = res.headers['access-control-allow-origin'] as string;
      expect(corsHeader).toBe('https://myapp.example.com');
    } finally {
      process.env.ALLOWED_ORIGIN = originalOrigin;
      await app2.close();
    }
  });

  // Regression #3 (Low): "ALLOWED_ORIGIN defaults to '*' while cookies use credentials: true"
  //
  // This is a documentation-via-test of current behavior, not a bug reproduction:
  // when ALLOWED_ORIGIN is unset the server responds with Access-Control-Allow-Origin: *
  // AND Access-Control-Allow-Credentials: true simultaneously. Browsers reject that
  // combination (spec §3.2.5 — wildcard is incompatible with credentials), so this
  // is not independently exploitable in a real browser session. However the
  // misconfiguration should be fixed at deploy time by requiring ALLOWED_ORIGIN.
  //
  // This test PASSES because it documents existing behavior (no it.fails wrapper).
  // When the config-hardening fix ships (e.g. throw on missing ALLOWED_ORIGIN, or
  // suppress the Credentials header when origin is '*'), update or remove this test.
  it('responds with Access-Control-Allow-Origin: * when ALLOWED_ORIGIN is not set (regression #3)', async () => {
    const orig = process.env.ALLOWED_ORIGIN;
    delete process.env.ALLOWED_ORIGIN;
    const app2 = await buildApp();

    try {
      const res = await app2.inject({
        method: 'GET',
        url: '/health',
        headers: { Origin: 'https://attacker.example.com' },
      });
      // Documents the unfixed default: wildcard origin is returned even though
      // credentials: true is also configured. Fix: set ALLOWED_ORIGIN in production.
      expect(res.headers['access-control-allow-origin']).toBe('*');
    } finally {
      if (orig !== undefined) process.env.ALLOWED_ORIGIN = orig;
      await app2.close();
    }
  });
});

// ─── envVar injection protection ──────────────────────────────────────────────

describe('envVar injection protection', () => {
  it('accepts valid envVar keys', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tests',
      payload: {
        type: 'flow',
        targetUrl: 'http://example.com',
        description: 'flow',
        options: { vus: 2, duration: '30s' },
        steps: [{ name: 's', url: 'http://example.com', method: 'GET' }],
        envVars: { API_TOKEN: 'abc123', USER_NAME: 'test' },
      },
    });
    expect(res.statusCode).toBe(200);
    const published = vi.mocked(publishTest).mock.calls[0][0] as { envVars?: Record<string, string> };
    expect(published.envVars).toEqual({ API_TOKEN: 'abc123', USER_NAME: 'test' });
  });
});

// ─── Cancel endpoint security ─────────────────────────────────────────────────

describe('Cancel endpoint', () => {
  it('returns 404 when results-service returns non-OK', async () => {
    const testId = '00000000-0000-0000-0000-000000000001';
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'not found or not cancellable' }),
    });
    const res = await app.inject({ method: 'POST', url: `/tests/${testId}/cancel` });
    expect(res.statusCode).toBe(404);
    expect(vi.mocked(publishCancel)).not.toHaveBeenCalled();
  });

  it('forwards testId to results-service for cancel', async () => {
    const testId = '00000000-0000-0000-0000-000000000002';
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await app.inject({ method: 'POST', url: `/tests/${testId}/cancel` });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(testId),
      expect.objectContaining({ method: 'POST' })
    );
  });
});
