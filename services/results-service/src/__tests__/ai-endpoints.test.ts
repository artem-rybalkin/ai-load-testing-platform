/**
 * Integration tests for results-service AI endpoints.
 *
 * All endpoints that call Gemini go through `@alt/shared`'s `generateAIText()`,
 * which dynamically imports `@google/generative-ai` from outside this test
 * file's module graph (so vi.mock('@google/generative-ai', ...) can't intercept
 * it). Instead, mock `generateAIText` itself.
 * Endpoints that need DB history use a real Testcontainers PostgreSQL instance.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from '../../../../test-support/sharedPostgres';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { createSchema } from '../db';

// ── AI provider mock ─────────────────────────────────────────────────────────
// vi.mock is hoisted before variable declarations, so the fn must be created
// with vi.hoisted().

const mockGenerateAIText = vi.hoisted(() => vi.fn());

vi.mock('@alt/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alt/shared')>();
  return { ...actual, generateAIText: mockGenerateAIText };
});

vi.mock('../scheduler', () => ({
  reloadSchedule: vi.fn(), removeSchedule: vi.fn(), startScheduler: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../consumer', async (orig) => {
  const m = await orig<typeof import('../consumer')>();
  return { ...m, isConsumerConnected: vi.fn().mockReturnValue(true) };
});

// ── Infrastructure ────────────────────────────────────────────────────────────

let pool: Pool;
let dropDb: () => Promise<void>;
let app: FastifyInstance;

const jsonResponse = (obj: unknown): string => JSON.stringify(obj);

beforeAll(async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  ({ pool, drop: dropDb } = await createTestDatabase());
  await createSchema(pool);
  app = await buildApp(pool);
});

afterAll(async () => {
  delete process.env.GEMINI_API_KEY;
  await app.close();
  await dropDb();
});

beforeEach(async () => {
  mockGenerateAIText.mockReset();
  await pool.query('TRUNCATE live_metrics, test_results, test_scripts, webhooks, schedules, test_presets, log_sources CASCADE');
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const insertCompletedResult = async (p95 = 400, avg = 200, rps = 50): Promise<string> => {
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
    mockGenerateAIText.mockResolvedValueOnce(jsonResponse({ cron: '0 9 * * 1-5', preview: 'Every weekday at 9 AM' }));
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
    mockGenerateAIText.mockResolvedValueOnce(jsonResponse({ narrative: 'Response times have increased 60% over 3 runs.' }));
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
    mockGenerateAIText.mockResolvedValueOnce(jsonResponse({ p95: 600, avg: 250, errorRate: 1, reasoning: 'Based on 2 runs.' }));

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
    mockGenerateAIText.mockResolvedValueOnce(jsonResponse({ vus: 10, duration: '2m', profile: 'load', reasoning: 'Conservative defaults.' }));
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
    mockGenerateAIText.mockResolvedValueOnce(jsonResponse({ level: 'noisy', message: 'Alert would fire 80% of the time.' }));
    const res = await app.inject({ method: 'POST', url: '/ai/webhook-noise', payload: { events: ['failed', 'degraded'] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().level).toBe('noisy');
    expect(res.json().warning).toContain('80%');
  });

  it('returns ok level when distribution is healthy', async () => {
    await insertCompletedResult();
    mockGenerateAIText.mockResolvedValueOnce(jsonResponse({ level: 'ok', message: 'Threshold looks appropriate.' }));
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
    mockGenerateAIText.mockResolvedValueOnce(jsonResponse({ columns: ['product_id', 'category'], reasoning: 'Found hardcoded IDs.' }));
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
    mockGenerateAIText.mockResolvedValueOnce(jsonResponse({ name: 'Homepage load test — 10 VUs', tags: ['smoke', 'frontend'] }));
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
    mockGenerateAIText.mockResolvedValueOnce(
      '[{"category":"serverError","count":15,"likelyCause":"Backend overloaded.","nextStep":"Scale horizontally."}]'
    );
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

// ─── POST /chat/parse ─────────────────────────────────────────────────────────

describe('POST /chat/parse', () => {
  it('returns a ready config on a clear, well-formed prompt', async () => {
    mockGenerateAIText.mockResolvedValueOnce(jsonResponse({
      status: 'ready',
      config: {
        type: 'backend',
        targetUrl: 'https://api.example.com',
        description: 'Backend load test against https://api.example.com with 50 VUs for 1 minute.',
        options: { vus: 50, duration: '1m', profile: 'load' },
      },
    }));
    const res = await app.inject({
      method: 'POST', url: '/chat/parse',
      payload: { messages: [{ role: 'user', content: 'Load test https://api.example.com with 50 users for 1 minute' }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.config.type).toBe('backend');
    expect(body.config.targetUrl).toBe('https://api.example.com');
    expect(body.config.options.vus).toBe(50);
  });

  it('returns needsClarification when the prompt is missing required info', async () => {
    mockGenerateAIText.mockResolvedValueOnce(jsonResponse({
      status: 'needsClarification',
      question: 'What URL would you like to test?',
    }));
    const res = await app.inject({
      method: 'POST', url: '/chat/parse',
      payload: { messages: [{ role: 'user', content: 'I want to run a load test' }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('needsClarification');
    expect(body.question).toMatch(/URL/);
  });

  it('returns redirectToFlowBuilder for multi-step intent and still meters Gemini usage', async () => {
    mockGenerateAIText.mockResolvedValueOnce(jsonResponse({
      status: 'redirectToFlowBuilder',
      reason: 'This describes multiple sequential steps (login, then checkout).',
    }));

    const SESSION_SECRET = 'test-session-secret-32-chars-min!';
    process.env.SESSION_SECRET = SESSION_SECRET;
    const sessionApp = await buildApp(pool);
    try {
      const reg = await sessionApp.inject({
        method: 'POST', url: '/auth/register',
        payload: { email: 'chat-flow@example.com', password: 'password123', teamName: 'chat-flow-team', name: 'Chat Tester' },
      });
      const cookie = (reg.headers['set-cookie'] as string).split(';')[0];
      const teamId = reg.json().currentTeamId as string;

      const before = await pool.query<{ call_count: number }>(
        `SELECT call_count FROM gemini_usage WHERE team_id = $1 AND usage_date = CURRENT_DATE`,
        [teamId]
      );
      const beforeCount = before.rows[0]?.call_count ?? 0;

      const res = await sessionApp.inject({
        method: 'POST', url: '/chat/parse',
        payload: { messages: [{ role: 'user', content: 'Log in, then add an item to cart, then checkout' }] },
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('redirectToFlowBuilder');
      expect(body.reason).toBeTruthy();

      const after = await pool.query<{ call_count: number }>(
        `SELECT call_count FROM gemini_usage WHERE team_id = $1 AND usage_date = CURRENT_DATE`,
        [teamId]
      );
      expect(after.rows[0]?.call_count ?? 0).toBe(beforeCount + 1);
    } finally {
      await sessionApp.close();
      delete process.env.SESSION_SECRET;
    }
  });

  it('returns 503 when no AI provider is configured', async () => {
    delete process.env.GEMINI_API_KEY;
    const res = await app.inject({
      method: 'POST', url: '/chat/parse',
      payload: { messages: [{ role: 'user', content: 'Load test https://api.example.com' }] },
    });
    expect(res.statusCode).toBe(503);
    process.env.GEMINI_API_KEY = 'test-key';
  });

  it('returns 429 when the team has exhausted its daily Gemini quota', async () => {
    const SESSION_SECRET = 'test-session-secret-32-chars-min!';
    process.env.SESSION_SECRET = SESSION_SECRET;
    const sessionApp = await buildApp(pool);
    try {
      const reg = await sessionApp.inject({
        method: 'POST', url: '/auth/register',
        payload: { email: 'chat-quota@example.com', password: 'password123', teamName: 'chat-quota-team', name: 'Quota Tester' },
      });
      const cookie = (reg.headers['set-cookie'] as string).split(';')[0];
      const teamId = reg.json().currentTeamId as string;

      await pool.query(
        `INSERT INTO team_quotas (team_id, max_concurrent_tests, max_vus_per_test, max_test_duration_seconds, max_scheduled_tests, max_gemini_calls_per_day)
         VALUES ($1, 5, 1000, 3600, 10, 1)`,
        [teamId]
      );

      mockGenerateAIText.mockResolvedValueOnce(jsonResponse({
        status: 'needsClarification', question: 'What URL?',
      }));
      const first = await sessionApp.inject({
        method: 'POST', url: '/chat/parse',
        payload: { messages: [{ role: 'user', content: 'run a test' }] },
        headers: { cookie },
      });
      expect(first.statusCode).toBe(200);

      const second = await sessionApp.inject({
        method: 'POST', url: '/chat/parse',
        payload: { messages: [{ role: 'user', content: 'run a test' }] },
        headers: { cookie },
      });
      expect(second.statusCode).toBe(429);
      expect(second.json().error).toMatch(/daily AI quota/);
    } finally {
      await sessionApp.close();
      delete process.env.SESSION_SECRET;
    }
  });

  it('returns 500 when Gemini response has no JSON object at all', async () => {
    mockGenerateAIText.mockResolvedValueOnce('Sorry, I cannot help with that.');
    const res = await app.inject({
      method: 'POST', url: '/chat/parse',
      payload: { messages: [{ role: 'user', content: 'Load test https://api.example.com' }] },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('AI returned unexpected response');
  });

  it('returns 500 when Gemini response has a brace-matched but invalid JSON block', async () => {
    mockGenerateAIText.mockResolvedValueOnce('{status: ready, config: this is not valid JSON}');
    const res = await app.inject({
      method: 'POST', url: '/chat/parse',
      payload: { messages: [{ role: 'user', content: 'Load test https://api.example.com' }] },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBeTruthy();
  });

  it('returns 400 when messages is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/chat/parse', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('coerces a unit-suffixed string threshold (e.g. "1000ms") to a plain number (regression — found via live testing against real Gemini)', async () => {
    mockGenerateAIText.mockResolvedValueOnce(jsonResponse({
      status: 'ready',
      config: {
        type: 'backend',
        targetUrl: 'https://httpbin.org/get',
        description: 'Backend load test with a p95 threshold.',
        options: { vus: 20, duration: '30s' },
        thresholds: { p95: '1000ms' }, // Gemini sometimes returns this despite the prompt's "no units" instruction
      },
    }));
    const res = await app.inject({
      method: 'POST', url: '/chat/parse',
      payload: { messages: [{ role: 'user', content: 'Backend test against https://httpbin.org/get, p95 under 1000ms' }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.config.thresholds.p95).toBe(1000);
    expect(typeof body.config.thresholds.p95).toBe('number');
  });

  it('returns 500 when a threshold value cannot be coerced to a number at all', async () => {
    mockGenerateAIText.mockResolvedValueOnce(jsonResponse({
      status: 'ready',
      config: {
        type: 'backend',
        targetUrl: 'https://httpbin.org/get',
        description: 'Backend load test.',
        options: { vus: 20, duration: '30s' },
        thresholds: { p95: 'fast' },
      },
    }));
    const res = await app.inject({
      method: 'POST', url: '/chat/parse',
      payload: { messages: [{ role: 'user', content: 'Backend test against https://httpbin.org/get' }] },
    });
    expect(res.statusCode).toBe(500);
  });

  it('returns 500 when Gemini hallucinates config.type as "flow" (regression — out-of-scope type must never reach the client)', async () => {
    mockGenerateAIText.mockResolvedValueOnce(jsonResponse({
      status: 'ready',
      config: {
        type: 'flow',
        targetUrl: 'https://api.example.com',
        description: 'A flow test.',
        options: { vus: 50, duration: '1m' },
      },
    }));
    const res = await app.inject({
      method: 'POST', url: '/chat/parse',
      payload: { messages: [{ role: 'user', content: 'Log in, then check out' }] },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('AI returned unexpected response');
  });

  it('returns 500 when a ready config is missing required fields (regression — malformed shape must not reach the client)', async () => {
    mockGenerateAIText.mockResolvedValueOnce(jsonResponse({
      status: 'ready',
      config: { type: 'backend', options: { vus: 50, duration: '1m' } }, // no targetUrl, no description
    }));
    const res = await app.inject({
      method: 'POST', url: '/chat/parse',
      payload: { messages: [{ role: 'user', content: 'Load test something' }] },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('AI returned unexpected response');
  });

  it('honors a per-team AI provider override instead of the global default', async () => {
    const SESSION_SECRET = 'test-session-secret-32-chars-min!';
    process.env.SESSION_SECRET = SESSION_SECRET;
    process.env.OPENAI_API_KEY = 'test-openai-key';
    const sessionApp = await buildApp(pool);
    try {
      const reg = await sessionApp.inject({
        method: 'POST', url: '/auth/register',
        payload: { email: 'chat-override@example.com', password: 'password123', teamName: 'chat-override-team', name: 'Override Tester' },
      });
      const cookie = (reg.headers['set-cookie'] as string).split(';')[0];
      const teamId = reg.json().currentTeamId as string;

      // Seed a team-level override pointing at 'openai' instead of the global default ('gemini').
      await pool.query(
        `INSERT INTO team_ai_providers (team_id, provider, fallbacks) VALUES ($1, 'openai', '{}')`,
        [teamId]
      );

      mockGenerateAIText.mockResolvedValueOnce(jsonResponse({
        status: 'needsClarification', question: 'What URL?',
      }));
      const res = await sessionApp.inject({
        method: 'POST', url: '/chat/parse',
        payload: { messages: [{ role: 'user', content: 'run a test' }] },
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);

      // generateAIText's second argument is the resolved AiProviderSetting — assert it reflects
      // the team override ('openai'), not the global default ('gemini').
      const settingArg = mockGenerateAIText.mock.calls[0][1];
      expect(settingArg.provider).toBe('openai');
    } finally {
      await sessionApp.close();
      delete process.env.SESSION_SECRET;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('truncates message history to the last 20 messages before calling Gemini', async () => {
    const messages = Array.from({ length: 25 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `message-${i}`,
    }));
    mockGenerateAIText.mockResolvedValueOnce(jsonResponse({
      status: 'needsClarification', question: 'What URL?',
    }));
    const res = await app.inject({ method: 'POST', url: '/chat/parse', payload: { messages } });
    expect(res.statusCode).toBe(200);

    const promptArg = mockGenerateAIText.mock.calls[0][0] as string;
    // The 5 oldest messages (message-0..message-4) must be truncated; the most recent 20 remain.
    expect(promptArg).not.toContain('message-0');
    expect(promptArg).not.toContain('message-4');
    expect(promptArg).toContain('message-5');
    expect(promptArg).toContain('message-24');
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

    mockGenerateAIText.mockResolvedValueOnce(jsonResponse({ cron: '0 9 * * 1-5', preview: 'Every weekday at 9 AM' }));
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
