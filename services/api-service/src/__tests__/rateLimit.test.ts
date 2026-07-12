import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../index';

// Keep external dependencies inert so buildApp() resolves without a real
// DB / queue — only the rate-limit plugin behaviour is under test here.
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

vi.mock('../session', () => ({
  getApiSession: vi.fn().mockResolvedValue(null),
  hashApiKey: vi.fn().mockReturnValue('hashed'),
}));

vi.mock('../quotas', () => ({
  checkTestQuota: vi.fn().mockResolvedValue(null),
}));

vi.mock('../redis', () => ({ redisClient: undefined }));

let app: FastifyInstance;

const validBody = {
  type: 'backend',
  targetUrl: 'http://example.com',
  description: 'rate limit smoke test',
  options: { vus: 5, duration: '30s' },
};

beforeAll(async () => {
  process.env.RATE_LIMIT_MAX = '3';
  process.env.RATE_LIMIT_WINDOW_MS = '60000';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  app = await buildApp();
});

afterAll(async () => {
  delete process.env.RATE_LIMIT_MAX;
  delete process.env.RATE_LIMIT_WINDOW_MS;
  vi.unstubAllGlobals();
  await app.close();
});

describe('rate limiting', () => {
  it('does not rate-limit /health regardless of request count', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).not.toBe(429);
    }
  });

  it('returns 429 with Retry-After once RATE_LIMIT_MAX is exceeded', async () => {
    const responses = [];
    for (let i = 0; i < 4; i++) {
      responses.push(await app.inject({ method: 'POST', url: '/tests', payload: validBody }));
    }

    expect(responses.slice(0, 3).every(r => r.statusCode !== 429)).toBe(true);

    const limited = responses[3]!; // loop above pushes exactly 4 responses
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });
});
