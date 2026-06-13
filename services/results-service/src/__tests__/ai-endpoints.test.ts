/**
 * Integration tests for results-service AI endpoints.
 *
 * All endpoints that call Gemini use `await import('@google/generative-ai')`
 * inside the route handler. vi.mock() intercepts the dynamic import.
 * Endpoints that need DB history use a real Testcontainers PostgreSQL instance.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { createSchema } from '../db';

// ── Gemini mock ───────────────────────────────────────────────────────────────
// vi.mock is hoisted before variable declarations, so the fn must be created
// with vi.hoisted() and the class syntax used for `new GoogleGenerativeAI(...)`.

const mockGenerateContent = vi.hoisted(() => vi.fn());

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel() { return { generateContent: mockGenerateContent }; }
  },
}));

vi.mock('../scheduler', () => ({
  reloadSchedule: vi.fn(), removeSchedule: vi.fn(), startScheduler: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../consumer', async (orig) => {
  const m = await orig<typeof import('../consumer')>();
  return { ...m, isConsumerConnected: vi.fn().mockReturnValue(true) };
});

// ── Infrastructure ────────────────────────────────────────────────────────────

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: FastifyInstance;

const geminiResponse = (text: string) => ({ response: { text: () => text } });
const jsonResponse = (obj: unknown) => geminiResponse(JSON.stringify(obj));

beforeAll(async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await createSchema(pool);
  app = await buildApp(pool);
});

afterAll(async () => {
  delete process.env.GEMINI_API_KEY;
  await app.close();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  mockGenerateContent.mockReset();
  await pool.query('TRUNCATE live_metrics, test_results, test_scripts, webhooks, schedules, test_presets, log_sources CASCADE');
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const insertCompletedResult = async (p95 = 400, avg = 200, rps = 50) => {
  const testId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO test_results (test_id, type, target_url, status, perf_status, metrics, created_at, completed_at)
     VALUES ($1,'backend','http://test.example.com','completed','passed',$2,NOW(),NOW())`,
    [testId, JSON.stringify({ type: 'backend', requestsTotal: 1000, requestsFailed: 5, p95ResponseTime: p95, avgResponseTime: avg, rps })]
  );
  return testId;
};

// ─── POST /ai/cron ────────────────────────────────────────────────────────────

describe('POST /ai/cron', () => {
  it('returns cron expression and preview from Gemini', async () => {
    mockGenerateContent.mockResolvedValueOnce(jsonResponse({ cron: '0 9 * * 1-5', preview: 'Every weekday at 9 AM' }));
    const res = await app.inject({ method: 'POST', url: '/ai/cron', payload: { phrase: 'every weekday at 9am' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cron).toBe('0 9 * * 1-5');
    expect(body.preview).toBe('Every weekday at 9 AM');
  });

  it('returns 400 when phrase is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/ai/cron', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('returns 503 when GEMINI_API_KEY is not set', async () => {
    delete process.env.GEMINI_API_KEY;
    const res = await app.inject({ method: 'POST', url: '/ai/cron', payload: { phrase: 'daily at noon' } });
    expect(res.statusCode).toBe(503);
    process.env.GEMINI_API_KEY = 'test-key';
  });
});

// ─── POST /ai/trend-narrative ─────────────────────────────────────────────────

describe('POST /ai/trend-narrative', () => {
  const trend = [
    { created_at: '2026-01-01', metrics: { p95ResponseTime: 400, rps: 50 }, perf_status: 'passed' },
    { created_at: '2026-01-02', metrics: { p95ResponseTime: 500, rps: 45 }, perf_status: 'passed' },
    { created_at: '2026-01-03', metrics: { p95ResponseTime: 650, rps: 40 }, perf_status: 'degraded' },
  ];

  it('returns narrative from Gemini', async () => {
    mockGenerateContent.mockResolvedValueOnce(jsonResponse({ narrative: 'Response times have increased 60% over 3 runs.' }));
    const res = await app.inject({ method: 'POST', url: '/ai/trend-narrative', payload: { trend } });
    expect(res.statusCode).toBe(200);
    expect(res.json().narrative).toContain('Response times');
  });

  it('returns 422 with fewer than 3 trend points', async () => {
    const res = await app.inject({ method: 'POST', url: '/ai/trend-narrative', payload: { trend: trend.slice(0, 2) } });
    expect(res.statusCode).toBe(422);
  });
});

// ─── GET /results/suggest-thresholds ─────────────────────────────────────────

describe('GET /results/suggest-thresholds', () => {
  it('returns threshold suggestions based on run history', async () => {
    await insertCompletedResult(400);
    await insertCompletedResult(500);
    mockGenerateContent.mockResolvedValueOnce(jsonResponse({ p95: 600, avg: 250, errorRate: 1, reasoning: 'Based on 2 runs.' }));

    const res = await app.inject({ method: 'GET', url: '/results/suggest-thresholds?url=http://test.example.com&type=backend' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.suggestions.p95).toBe(600);
    expect(body.runsAnalysed).toBe(2);
  });

  it('returns 422 when fewer than 2 runs exist', async () => {
    await insertCompletedResult();
    const res = await app.inject({ method: 'GET', url: '/results/suggest-thresholds?url=http://test.example.com' });
    expect(res.statusCode).toBe(422);
  });

  it('returns 400 when url is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/results/suggest-thresholds' });
    expect(res.statusCode).toBe(400);
  });
});

// ─── GET /results/suggest-settings ───────────────────────────────────────────

describe('GET /results/suggest-settings', () => {
  it('returns VU/duration/profile suggestions', async () => {
    mockGenerateContent.mockResolvedValueOnce(jsonResponse({ vus: 10, duration: '2m', profile: 'load', reasoning: 'Conservative defaults.' }));
    const res = await app.inject({ method: 'GET', url: '/results/suggest-settings?url=https://api.example.com' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.vus).toBe(10);
    expect(body.duration).toBe('2m');
    expect(body.profile).toBe('load');
  });
});

// ─── POST /ai/webhook-noise ───────────────────────────────────────────────────

describe('POST /ai/webhook-noise', () => {
  it('returns noisy warning when most runs fail', async () => {
    await insertCompletedResult(2000, 1000); // will be 'passed' since we hardcode perf_status
    mockGenerateContent.mockResolvedValueOnce(jsonResponse({ level: 'noisy', message: 'Alert would fire 80% of the time.' }));
    const res = await app.inject({ method: 'POST', url: '/ai/webhook-noise', payload: { events: ['failed', 'degraded'] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().level).toBe('noisy');
    expect(res.json().warning).toContain('80%');
  });

  it('returns ok level when distribution is healthy', async () => {
    await insertCompletedResult();
    mockGenerateContent.mockResolvedValueOnce(jsonResponse({ level: 'ok', message: 'Threshold looks appropriate.' }));
    const res = await app.inject({ method: 'POST', url: '/ai/webhook-noise', payload: { events: ['failed'] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().level).toBe('ok');
    expect(res.json().warning).toBeNull();
  });

  it('returns 400 when events is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/ai/webhook-noise', payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

// ─── POST /ai/param-suggestions ──────────────────────────────────────────────

describe('POST /ai/param-suggestions', () => {
  it('returns parameterisation column suggestions', async () => {
    mockGenerateContent.mockResolvedValueOnce(jsonResponse({ columns: ['product_id', 'category'], reasoning: 'Found hardcoded IDs.' }));
    const res = await app.inject({
      method: 'POST', url: '/ai/param-suggestions',
      payload: { steps: [{ url: 'https://api.example.com/products/12345', method: 'GET' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().columns).toContain('product_id');
  });

  it('returns 400 when steps is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/ai/param-suggestions', payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

// ─── POST /ai/preset-name ────────────────────────────────────────────────────

describe('POST /ai/preset-name', () => {
  it('returns a suggested name and tags', async () => {
    mockGenerateContent.mockResolvedValueOnce(jsonResponse({ name: 'Homepage load test — 10 VUs', tags: ['smoke', 'frontend'] }));
    const res = await app.inject({
      method: 'POST', url: '/ai/preset-name',
      payload: { url: 'https://example.com', type: 'backend', vus: 10, duration: '1m', profile: 'load' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toContain('load test');
    expect(body.tags).toContain('smoke');
  });
});

// ─── GET /results/:testId/diagnose ────────────────────────────────────────────

describe('GET /results/:testId/diagnose', () => {
  it('returns error diagnoses when errors exist', async () => {
    const testId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status, perf_status, metrics)
       VALUES ($1,'backend','http://test.example.com','completed','failed',$2)`,
      [testId, JSON.stringify({
        type: 'backend', requestsTotal: 100, requestsFailed: 30,
        avgResponseTime: 800, p95ResponseTime: 1500, rps: 10,
        errorBreakdown: { success: 70, clientError: 10, serverError: 15, timeout: 5, networkError: 0 },
      })]
    );
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => '[{"category":"serverError","count":15,"likelyCause":"Backend overloaded.","nextStep":"Scale horizontally."}]' },
    });
    const res = await app.inject({ method: 'GET', url: `/results/${testId}/diagnose` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.diagnoses).toHaveLength(1);
    expect(body.diagnoses[0].category).toBe('serverError');
  });

  it('returns empty diagnoses when no errors exist', async () => {
    const testId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status, perf_status, metrics)
       VALUES ($1,'backend','http://test.example.com','completed','passed',$2)`,
      [testId, JSON.stringify({
        type: 'backend', requestsTotal: 100, requestsFailed: 0,
        avgResponseTime: 200, p95ResponseTime: 400, rps: 50,
        errorBreakdown: { success: 100, clientError: 0, serverError: 0, timeout: 0, networkError: 0 },
      })]
    );
    const res = await app.inject({ method: 'GET', url: `/results/${testId}/diagnose` });
    expect(res.statusCode).toBe(200);
    expect(res.json().diagnoses).toEqual([]);
  });

  it('returns 404 for unknown testId', async () => {
    const res = await app.inject({ method: 'GET', url: `/results/${crypto.randomUUID()}/diagnose` });
    expect(res.statusCode).toBe(404);
  });
});

// ─── Gemini quota enforcement (/ai/* with SESSION_SECRET) ─────────────────────

describe('Gemini quota enforcement', () => {
  const SESSION_SECRET = 'test-session-secret-32-chars-min!';
  let sessionApp: FastifyInstance;

  const sessionCookie = (res: { headers: Record<string, unknown> }): string =>
    (res.headers['set-cookie'] as string).split(';')[0];

  beforeAll(async () => {
    process.env.SESSION_SECRET = SESSION_SECRET;
    sessionApp = await buildApp(pool);
  });

  afterAll(async () => {
    delete process.env.SESSION_SECRET;
    await sessionApp.close();
  });

  it('returns 429 once the team exhausts its daily Gemini quota', async () => {
    const reg = await sessionApp.inject({
      method: 'POST', url: '/auth/register',
      payload: { email: 'quota-ai@example.com', password: 'password123', teamName: 'quota-ai-team', name: 'Quota Tester' },
    });
    const cookie = sessionCookie(reg);
    const teamId = reg.json().currentTeamId as string;

    await pool.query(
      `INSERT INTO team_quotas (team_id, max_concurrent_tests, max_vus_per_test, max_test_duration_seconds, max_scheduled_tests, max_gemini_calls_per_day)
       VALUES ($1, 5, 1000, 3600, 10, 1)`,
      [teamId]
    );

    mockGenerateContent.mockResolvedValueOnce(jsonResponse({ cron: '0 9 * * 1-5', preview: 'Every weekday at 9 AM' }));
    const first = await sessionApp.inject({
      method: 'POST', url: '/ai/cron', payload: { phrase: 'every weekday at 9am' }, headers: { cookie },
    });
    expect(first.statusCode).toBe(200);

    const second = await sessionApp.inject({
      method: 'POST', url: '/ai/cron', payload: { phrase: 'every weekday at 9am' }, headers: { cookie },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toMatch(/daily AI quota/);
  });
});
