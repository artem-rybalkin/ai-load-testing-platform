import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from '../../../../test-support/sharedPostgres';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { createSchema } from '../db';

vi.mock('../scheduler', () => ({
  reloadSchedule: vi.fn().mockResolvedValue(undefined),
  removeSchedule: vi.fn(),
  startScheduler: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../consumer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../consumer')>();
  return { ...actual, isConsumerConnected: vi.fn().mockReturnValue(true) };
});

vi.mock('../redis', () => ({ redisClient: undefined }));

let pool: Pool;
let dropDb: () => Promise<void>;

beforeAll(async () => {
  ({ pool, drop: dropDb } = await createTestDatabase());
  await createSchema(pool);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await dropDb();
});

describe('global rate limiting', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.RATE_LIMIT_MAX = '3';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';
    app = await buildApp(pool);
  });

  afterAll(async () => {
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_WINDOW_MS;
    await app.close();
  });

  it('does not rate-limit /health regardless of request count', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).not.toBe(429);
    }
  });

  it('returns 429 with Retry-After once RATE_LIMIT_MAX is exceeded', async () => {
    const responses = [];
    for (let i = 0; i < 4; i++) {
      responses.push(await app.inject({ method: 'GET', url: '/scripts' }));
    }

    expect(responses.slice(0, 3).every(r => r.statusCode !== 429)).toBe(true);

    const limited = responses[3];
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });
});

describe('auth endpoint rate limiting', () => {
  let app: FastifyInstance;
  const SESSION_SECRET = 'test-session-secret-32-chars-min!';

  beforeAll(async () => {
    process.env.RATE_LIMIT_MAX = '600';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';
    process.env.AUTH_RATE_LIMIT_MAX = '2';
    process.env.SESSION_SECRET = SESSION_SECRET;
    app = await buildApp(pool);
  });

  afterAll(async () => {
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_WINDOW_MS;
    delete process.env.AUTH_RATE_LIMIT_MAX;
    delete process.env.SESSION_SECRET;
    await app.close();
  });

  it('returns 429 on /auth/login once AUTH_RATE_LIMIT_MAX is exceeded', async () => {
    const payload = { email: 'nobody@example.com', password: 'wrong-password' };
    const responses = [];
    for (let i = 0; i < 3; i++) {
      responses.push(await app.inject({ method: 'POST', url: '/auth/login', payload }));
    }

    expect(responses.slice(0, 2).every(r => r.statusCode !== 429)).toBe(true);

    const limited = responses[2];
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });
});
