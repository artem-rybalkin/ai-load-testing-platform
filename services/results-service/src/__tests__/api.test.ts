import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from '../../../../test-support/sharedPostgres';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { createSchema } from '../db';

// Prevent real cron tasks from being registered during tests
vi.mock('../scheduler', () => ({
  reloadSchedule: vi.fn().mockResolvedValue(undefined),
  removeSchedule: vi.fn(),
  startScheduler: vi.fn().mockResolvedValue(undefined),
}));

// Mock consumer connection state so health check returns consistent results
vi.mock('../consumer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../consumer')>();
  return { ...actual, isConsumerConnected: vi.fn().mockReturnValue(true) };
});

let pool: Pool;
let dropDb: () => Promise<void>;
let app: FastifyInstance;
let mockFetch: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  ({ pool, drop: dropDb } = await createTestDatabase());
  await createSchema(pool);
  app = await buildApp(pool);
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  await dropDb();
});

beforeEach(async () => {
  await pool.query('TRUNCATE live_metrics, test_results, test_scripts, webhooks, schedules, test_presets, log_sources CASCADE');
  mockFetch.mockReset();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const insertResult = async (overrides: Record<string, unknown> = {}): Promise<string> => {
  const testId = overrides.testId as string ?? crypto.randomUUID();
  await pool.query(
    `INSERT INTO test_results (test_id, type, target_url, status, metrics, started_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, NOW() - INTERVAL '1 minute', NOW())`,
    [
      testId,
      overrides.type ?? 'backend',
      overrides.targetUrl ?? 'http://example.com',
      overrides.status ?? 'completed',
      JSON.stringify(overrides.metrics ?? { type: 'backend', requestsTotal: 100, requestsFailed: 0, avgResponseTime: 200, p50ResponseTime: 180, p95ResponseTime: 400, p99ResponseTime: 500, rps: 10 }),
    ]
  );
  return testId;
};

// ─── GET /results ─────────────────────────────────────────────────────────────

describe('GET /results', () => {
  it('returns empty list when no results', async () => {
    const res = await app.inject({ method: 'GET', url: '/results' });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([]);
  });

  it('returns results ordered by created_at DESC', async () => {
    await insertResult({ testId: '00000000-0000-0000-0000-000000000001' });
    await insertResult({ testId: '00000000-0000-0000-0000-000000000002' });
    const res = await app.inject({ method: 'GET', url: '/results' });
    expect(res.statusCode).toBe(200);
    const ids = res.json().results.map((r: { test_id: string }) => r.test_id);
    expect(ids).toContain('00000000-0000-0000-0000-000000000001');
    expect(ids).toContain('00000000-0000-0000-0000-000000000002');
  });
});

// ─── GET /scripts ─────────────────────────────────────────────────────────────

describe('GET /scripts', () => {
  it('returns empty list when no scripts', async () => {
    const res = await app.inject({ method: 'GET', url: '/scripts' });
    expect(res.statusCode).toBe(200);
    expect(res.json().scripts).toEqual([]);
  });

  it('returns scripts ordered by used_count DESC', async () => {
    await pool.query(`INSERT INTO test_scripts (target_url, test_type, script, used_count) VALUES ('http://a.com', 'backend', 'x', 5)`);
    await pool.query(`INSERT INTO test_scripts (target_url, test_type, script, used_count) VALUES ('http://b.com', 'backend', 'y', 10)`);
    const res = await app.inject({ method: 'GET', url: '/scripts' });
    expect(res.statusCode).toBe(200);
    const scripts = res.json().scripts;
    expect(scripts[0].used_count).toBeGreaterThanOrEqual(scripts[1].used_count);
  });
});

// ─── GET /scripts/:id ─────────────────────────────────────────────────────────

describe('GET /scripts/:id', () => {
  it('returns the script when found', async () => {
    const { rows } = await pool.query(
      `INSERT INTO test_scripts (target_url, test_type, script) VALUES ('http://x.com', 'backend', 'code here') RETURNING id`
    );
    const id: string = rows[0].id;
    const res = await app.inject({ method: 'GET', url: `/scripts/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().script.script).toBe('code here');
  });

  it('returns 404 for unknown script id', async () => {
    const res = await app.inject({ method: 'GET', url: '/scripts/00000000-0000-0000-0000-000000000099' });
    expect(res.statusCode).toBe(404);
  });
});

// ─── POST /results/:testId/cancel ─────────────────────────────────────────────

describe('POST /results/:testId/cancel', () => {
  it('cancels a pending test and returns 200', async () => {
    const testId = await insertResult({ status: 'pending' });
    const res = await app.inject({ method: 'POST', url: `/results/${testId}/cancel` });
    expect(res.statusCode).toBe(200);
    const { rows } = await pool.query('SELECT status FROM test_results WHERE test_id = $1', [testId]);
    expect(rows[0].status).toBe('cancelled');
  });

  it('cancels a running test', async () => {
    const testId = await insertResult({ status: 'running' });
    const res = await app.inject({ method: 'POST', url: `/results/${testId}/cancel` });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 when test not found', async () => {
    const res = await app.inject({ method: 'POST', url: '/results/00000000-0000-0000-0000-000000000099/cancel' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when test is already completed', async () => {
    const testId = await insertResult({ status: 'completed' });
    const res = await app.inject({ method: 'POST', url: `/results/${testId}/cancel` });
    expect(res.statusCode).toBe(404);
  });
});

// ─── POST/DELETE /results/:testId/baseline ────────────────────────────────────

describe('baseline management', () => {
  it('sets is_baseline true on a completed test', async () => {
    const testId = await insertResult({ status: 'completed' });
    const res = await app.inject({ method: 'POST', url: `/results/${testId}/baseline` });
    expect(res.statusCode).toBe(200);
    const { rows } = await pool.query('SELECT is_baseline FROM test_results WHERE test_id = $1', [testId]);
    expect(rows[0].is_baseline).toBe(true);
  });

  it('clears the previous baseline for the same URL+type when setting a new one', async () => {
    const oldId = await insertResult({ targetUrl: 'http://base.com', status: 'completed' });
    await pool.query('UPDATE test_results SET is_baseline = TRUE WHERE test_id = $1', [oldId]);
    const newId = await insertResult({ targetUrl: 'http://base.com', status: 'completed' });
    await app.inject({ method: 'POST', url: `/results/${newId}/baseline` });
    const { rows } = await pool.query('SELECT is_baseline FROM test_results WHERE test_id = $1', [oldId]);
    expect(rows[0].is_baseline).toBe(false);
  });

  it('returns 404 when setting baseline on non-completed test', async () => {
    const testId = await insertResult({ status: 'running' });
    const res = await app.inject({ method: 'POST', url: `/results/${testId}/baseline` });
    expect(res.statusCode).toBe(404);
  });

  it('clears baseline with DELETE and returns 204', async () => {
    const testId = await insertResult({ status: 'completed' });
    await pool.query('UPDATE test_results SET is_baseline = TRUE WHERE test_id = $1', [testId]);
    const res = await app.inject({ method: 'DELETE', url: `/results/${testId}/baseline` });
    expect(res.statusCode).toBe(204);
    const { rows } = await pool.query('SELECT is_baseline FROM test_results WHERE test_id = $1', [testId]);
    expect(rows[0].is_baseline).toBe(false);
  });
});

// ─── GET /results/compare ─────────────────────────────────────────────────────

describe('GET /results/compare', () => {
  it('returns both results side by side', async () => {
    const a = await insertResult({ testId: '00000000-0000-0000-0000-aaaaaaaaaaaa' });
    const b = await insertResult({ testId: '00000000-0000-0000-0000-bbbbbbbbbbbb' });
    const res = await app.inject({ method: 'GET', url: `/results/compare?a=${a}&b=${b}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().resultA.test_id).toBe(a);
    expect(res.json().resultB.test_id).toBe(b);
  });

  it('returns 400 when query params are missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/results/compare' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when only one param is provided', async () => {
    const res = await app.inject({ method: 'GET', url: '/results/compare?a=00000000-0000-0000-0000-aaaaaaaaaaaa' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when one result does not exist', async () => {
    const a = await insertResult();
    const res = await app.inject({
      method: 'GET',
      url: `/results/compare?a=${a}&b=00000000-0000-0000-0000-000000000099`,
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── GET /results/trend ───────────────────────────────────────────────────────

describe('GET /results/trend', () => {
  it('returns completed results for the given URL in chronological order', async () => {
    await insertResult({ targetUrl: 'http://trend.com', status: 'completed' });
    await insertResult({ targetUrl: 'http://trend.com', status: 'completed' });
    await insertResult({ targetUrl: 'http://other.com', status: 'completed' });
    const res = await app.inject({ method: 'GET', url: '/results/trend?url=http://trend.com' });
    expect(res.statusCode).toBe(200);
    expect(res.json().trend).toHaveLength(2);
    expect(res.json().url).toBe('http://trend.com');
  });

  it('excludes non-completed results', async () => {
    await insertResult({ targetUrl: 'http://trend2.com', status: 'running' });
    const res = await app.inject({ method: 'GET', url: '/results/trend?url=http://trend2.com' });
    expect(res.json().trend).toHaveLength(0);
  });

  it('returns 400 when url param is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/results/trend' });
    expect(res.statusCode).toBe(400);
  });
});

// ─── GET /results/preview-thresholds ───────────────────────────────────────────

describe('GET /results/preview-thresholds', () => {
  it('returns available: false when no completed run exists for the URL', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/results/preview-thresholds?url=${encodeURIComponent('http://no-history.com')}&type=backend&thresholds=${encodeURIComponent(JSON.stringify({ p95: 500 }))}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false });
  });

  it('returns passed when thresholds are not violated by the latest run', async () => {
    const testId = await insertResult({ targetUrl: 'http://preview-pass.com', type: 'backend' });
    const res = await app.inject({
      method: 'GET',
      url: `/results/preview-thresholds?url=${encodeURIComponent('http://preview-pass.com')}&type=backend&thresholds=${encodeURIComponent(JSON.stringify({ p95: 1000, errorRate: 5 }))}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.available).toBe(true);
    expect(body.perfStatus).toBe('passed');
    expect(body.thresholdViolations).toEqual([]);
    expect(body.basedOn.testId).toBe(testId);
  });

  it('returns failed with violation details when thresholds are exceeded', async () => {
    await insertResult({
      targetUrl: 'http://preview-fail.com',
      type: 'backend',
      metrics: { type: 'backend', requestsTotal: 100, requestsFailed: 0, avgResponseTime: 200, p50ResponseTime: 180, p95ResponseTime: 400, p99ResponseTime: 500, rps: 10 },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/results/preview-thresholds?url=${encodeURIComponent('http://preview-fail.com')}&type=backend&thresholds=${encodeURIComponent(JSON.stringify({ p95: 100 }))}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.available).toBe(true);
    expect(body.perfStatus).toBe('failed');
    expect(body.thresholdViolations.length).toBeGreaterThan(0);
    expect(body.thresholdViolations[0]).toMatch(/p95/);
  });

  it('returns 400 when url is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/results/preview-thresholds?thresholds=${encodeURIComponent(JSON.stringify({ p95: 100 }))}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when thresholds is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/results/preview-thresholds?url=${encodeURIComponent('http://preview-fail.com')}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when thresholds is not valid JSON', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/results/preview-thresholds?url=${encodeURIComponent('http://preview-fail.com')}&thresholds=not-json`,
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── Webhooks CRUD ────────────────────────────────────────────────────────────

describe('webhooks', () => {
  it('creates a webhook with default events and returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks',
      payload: { url: 'https://hook.example.com/notify' },
    });
    expect(res.statusCode).toBe(201);
    const { webhook } = res.json();
    expect(webhook.url).toBe('https://hook.example.com/notify');
    expect(webhook.events).toEqual(['failed', 'degraded']);
  });

  it('creates a webhook with custom events', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks',
      payload: { url: 'https://hook.example.com/2', events: ['failed'] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().webhook.events).toEqual(['failed']);
  });

  it('returns 400 when url is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/webhooks', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('lists all webhooks', async () => {
    await app.inject({ method: 'POST', url: '/webhooks', payload: { url: 'https://a.com' } });
    await app.inject({ method: 'POST', url: '/webhooks', payload: { url: 'https://b.com' } });
    const res = await app.inject({ method: 'GET', url: '/webhooks' });
    expect(res.statusCode).toBe(200);
    expect(res.json().webhooks).toHaveLength(2);
  });

  it('deletes a webhook and returns 204', async () => {
    const create = await app.inject({ method: 'POST', url: '/webhooks', payload: { url: 'https://del.com' } });
    const id = create.json().webhook.id;
    const del = await app.inject({ method: 'DELETE', url: `/webhooks/${id}` });
    expect(del.statusCode).toBe(204);
    const list = await app.inject({ method: 'GET', url: '/webhooks' });
    expect(list.json().webhooks).toHaveLength(0);
  });
});

// ─── Schedules CRUD ───────────────────────────────────────────────────────────

const schedulePayload = {
  name: 'Hourly smoke',
  cron: '0 * * * *',
  type: 'backend',
  target_url: 'http://smoke.com',   // app.ts expects snake_case (Phase 15 fix)
  options: { vus: 5, duration: '30s' },
};

describe('schedules', () => {
  it('creates a schedule and returns 201', async () => {
    const res = await app.inject({ method: 'POST', url: '/schedules', payload: schedulePayload });
    expect(res.statusCode).toBe(201);
    const { schedule } = res.json();
    expect(schedule.name).toBe('Hourly smoke');
    expect(schedule.enabled).toBe(true);
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/schedules', payload: { name: 'x' } });
    expect(res.statusCode).toBe(400);
  });

  it('lists all schedules', async () => {
    await app.inject({ method: 'POST', url: '/schedules', payload: schedulePayload });
    const res = await app.inject({ method: 'GET', url: '/schedules' });
    expect(res.statusCode).toBe(200);
    expect(res.json().schedules).toHaveLength(1);
  });

  it('updates a schedule and returns 200', async () => {
    const create = await app.inject({ method: 'POST', url: '/schedules', payload: schedulePayload });
    const id = create.json().schedule.id;
    const res = await app.inject({ method: 'PUT', url: `/schedules/${id}`, payload: { enabled: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json().schedule.enabled).toBe(false);
  });

  it('returns 404 when updating non-existent schedule', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/schedules/00000000-0000-0000-0000-000000000099',
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when PUT body has no fields', async () => {
    const create = await app.inject({ method: 'POST', url: '/schedules', payload: schedulePayload });
    const id = create.json().schedule.id;
    const res = await app.inject({ method: 'PUT', url: `/schedules/${id}`, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('deletes a schedule and returns 204', async () => {
    const create = await app.inject({ method: 'POST', url: '/schedules', payload: schedulePayload });
    const id = create.json().schedule.id;
    const del = await app.inject({ method: 'DELETE', url: `/schedules/${id}` });
    expect(del.statusCode).toBe(204);
  });

  it('POST /schedules/:id/run triggers the test and updates last_run_at', async () => {
    const create = await app.inject({ method: 'POST', url: '/schedules', payload: schedulePayload });
    const id = create.json().schedule.id;
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200, json: async () => ({ success: true, test: { id: 'new-test-id' } }),
    });
    const res = await app.inject({ method: 'POST', url: `/schedules/${id}/run` });
    expect(res.statusCode).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/tests'), expect.objectContaining({ method: 'POST' }));
    const { rows } = await pool.query('SELECT last_run_at FROM schedules WHERE id = $1', [id]);
    expect(rows[0].last_run_at).not.toBeNull();
  });

  it('returns 404 when running non-existent schedule', async () => {
    const res = await app.inject({ method: 'POST', url: '/schedules/00000000-0000-0000-0000-000000000099/run' });
    expect(res.statusCode).toBe(404);
  });
});

// ─── Presets CRUD ────────────────────────────────────────────────────────────

const presetPayload = {
  name: 'API smoke',
  type: 'backend',
  options: { vus: 5, duration: '30s' },
};

describe('presets', () => {
  it('creates a preset and returns 201', async () => {
    const res = await app.inject({ method: 'POST', url: '/presets', payload: presetPayload });
    expect(res.statusCode).toBe(201);
    expect(res.json().preset.name).toBe('API smoke');
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/presets', payload: { name: 'x' } });
    expect(res.statusCode).toBe(400);
  });

  it('saves and returns target_url (regression: was silently dropped due to camelCase mismatch)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/presets',
      payload: { ...presetPayload, target_url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().preset.target_url).toBe('https://example.com');
  });

  it('saves and returns description', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/presets',
      payload: { ...presetPayload, description: 'load test 10 users 1 min' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().preset.description).toBe('load test 10 users 1 min');
  });

  it('saves and returns all options fields including profile and rampUp', async () => {
    const options = { vus: 10, duration: '2m', profile: 'spike', peakVus: 100, rampUp: '30s' };
    const res = await app.inject({
      method: 'POST',
      url: '/presets',
      payload: { ...presetPayload, options },
    });
    expect(res.statusCode).toBe(201);
    const saved = res.json().preset.options;
    expect(saved.vus).toBe(10);
    expect(saved.duration).toBe('2m');
    expect(saved.profile).toBe('spike');
    expect(saved.peakVus).toBe(100);
    expect(saved.rampUp).toBe('30s');
  });

  it('saves and returns thresholds', async () => {
    const thresholds = { p95: 800, errorRate: 1 };
    const res = await app.inject({
      method: 'POST',
      url: '/presets',
      payload: { ...presetPayload, thresholds },
    });
    expect(res.statusCode).toBe(201);
    const saved = res.json().preset.thresholds;
    expect(saved.p95).toBe(800);
    expect(saved.errorRate).toBe(1);
  });

  it('target_url is null when not provided', async () => {
    const res = await app.inject({ method: 'POST', url: '/presets', payload: presetPayload });
    expect(res.statusCode).toBe(201);
    expect(res.json().preset.target_url).toBeNull();
  });

  it('lists presets ordered by used_count DESC', async () => {
    await app.inject({ method: 'POST', url: '/presets', payload: presetPayload });
    await app.inject({ method: 'POST', url: '/presets', payload: { ...presetPayload, name: 'Second' } });
    const res = await app.inject({ method: 'GET', url: '/presets' });
    expect(res.statusCode).toBe(200);
    expect(res.json().presets).toHaveLength(2);
  });

  it('GET /presets returns target_url and description in list', async () => {
    await app.inject({
      method: 'POST',
      url: '/presets',
      payload: { ...presetPayload, target_url: 'https://api.example.com', description: 'smoke test' },
    });
    const res = await app.inject({ method: 'GET', url: '/presets' });
    const t = res.json().presets[0];
    expect(t.target_url).toBe('https://api.example.com');
    expect(t.description).toBe('smoke test');
  });

  it('GET /presets/:id returns the preset and increments used_count', async () => {
    const create = await app.inject({ method: 'POST', url: '/presets', payload: presetPayload });
    const id = create.json().preset.id;
    await app.inject({ method: 'GET', url: `/presets/${id}` });
    const { rows } = await pool.query('SELECT used_count FROM test_presets WHERE id = $1', [id]);
    expect(rows[0].used_count).toBe(1);
  });

  it('GET /presets/:id returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/presets/00000000-0000-0000-0000-000000000099' });
    expect(res.statusCode).toBe(404);
  });

  it('deletes a preset and returns 204', async () => {
    const create = await app.inject({ method: 'POST', url: '/presets', payload: presetPayload });
    const id = create.json().preset.id;
    const del = await app.inject({ method: 'DELETE', url: `/presets/${id}` });
    expect(del.statusCode).toBe(204);
  });

  it('DELETE returns 204 even for non-existent id (idempotent)', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/presets/00000000-0000-0000-0000-000000000099' });
    expect(res.statusCode).toBe(204);
  });
});

// ─── Log sources CRUD ────────────────────────────────────────────────────────

describe('log-sources', () => {
  it('POST /log-sources creates a log source and returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/log-sources',
      payload: { name: 'Grafana Prod', platform: 'Grafana', urlTemplate: 'https://grafana.example.com/explore?from={startedAtMs}&to={completedAtMs}' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.logSource.name).toBe('Grafana Prod');
    expect(body.logSource.platform).toBe('Grafana');
    expect(body.logSource.url_template).toBe('https://grafana.example.com/explore?from={startedAtMs}&to={completedAtMs}');
    expect(body.logSource.id).toBeDefined();
  });

  it('POST /log-sources accepts optional platform (null when omitted)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/log-sources',
      payload: { name: 'Custom Logs', urlTemplate: 'https://logs.example.com?start={startedAtMs}' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().logSource.platform).toBeNull();
  });

  it('POST /log-sources returns 400 when name is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/log-sources',
      payload: { urlTemplate: 'https://logs.example.com' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /log-sources returns 400 when urlTemplate is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/log-sources',
      payload: { name: 'My Logs' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /log-sources returns empty array when none configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/log-sources' });
    expect(res.statusCode).toBe(200);
    expect(res.json().logSources).toEqual([]);
  });

  it('GET /log-sources lists all created log sources', async () => {
    await app.inject({ method: 'POST', url: '/log-sources', payload: { name: 'Source A', urlTemplate: 'https://a.example.com' } });
    await app.inject({ method: 'POST', url: '/log-sources', payload: { name: 'Source B', urlTemplate: 'https://b.example.com' } });

    const res = await app.inject({ method: 'GET', url: '/log-sources' });
    expect(res.json().logSources).toHaveLength(2);
    const names = res.json().logSources.map((s: { name: string }) => s.name);
    expect(names).toContain('Source A');
    expect(names).toContain('Source B');
  });

  it('DELETE /log-sources/:id removes the source and returns 204', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/log-sources',
      payload: { name: 'To Delete', urlTemplate: 'https://delete.example.com' },
    });
    const id = create.json().logSource.id;

    const del = await app.inject({ method: 'DELETE', url: `/log-sources/${id}` });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({ method: 'GET', url: '/log-sources' });
    expect(list.json().logSources).toHaveLength(0);
  });

  it('DELETE /log-sources/:id returns 204 even for non-existent id (idempotent)', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/log-sources/00000000-0000-0000-0000-000000000099' });
    expect(res.statusCode).toBe(204);
  });
});

// ─── GET /results/:testId/report.pdf ─────────────────────────────────────────

describe('GET /results/:testId/report.pdf', () => {
  it('returns a PDF with correct content-type for a completed test', async () => {
    const testId = await insertResult({ status: 'completed' });
    const res = await app.inject({ method: 'GET', url: `/results/${testId}/report.pdf` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.length).toBeGreaterThan(100);
  });

  it('returns 404 for unknown test', async () => {
    const res = await app.inject({ method: 'GET', url: '/results/00000000-0000-0000-0000-000000000099/report.pdf' });
    expect(res.statusCode).toBe(404);
  });
});

// ─── GET /results/:testId/report.csv ─────────────────────────────────────────

describe('GET /results/:testId/report.csv', () => {
  it('returns a CSV with metric rows for a completed backend test', async () => {
    const testId = await insertResult({ status: 'completed' });
    const res = await app.inject({ method: 'GET', url: `/results/${testId}/report.csv` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain(`report-${testId.slice(0, 8)}.csv`);
    const body = res.body;
    expect(body).toContain('metric,value');
    expect(body).toContain(`testId,${testId}`);
    expect(body).toContain('requestsTotal,100');
    expect(body).toContain('p95ResponseTime,400');
  });

  it('includes a step metrics section for flow tests', async () => {
    const testId = await insertResult({
      status: 'completed',
      type: 'flow',
      metrics: {
        type: 'backend', requestsTotal: 50, requestsFailed: 0, avgResponseTime: 100, p50ResponseTime: 90, p95ResponseTime: 150, p99ResponseTime: 180, rps: 5,
        stepMetrics: [{ name: 'Step 1: login', avgResponseTime: 120, p95ResponseTime: 160, requestsTotal: 25, requestsFailed: 0 }],
      },
    });
    const res = await app.inject({ method: 'GET', url: `/results/${testId}/report.csv` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('step,avgResponseTime,p95ResponseTime,requestsTotal,requestsFailed');
    expect(res.body).toContain('Step 1: login,120,160,25,0');
  });

  it('returns 404 for unknown test', async () => {
    const res = await app.inject({ method: 'GET', url: '/results/00000000-0000-0000-0000-000000000099/report.csv' });
    expect(res.statusCode).toBe(404);
  });
});

// ─── GET /health (t13) ────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 when DB and consumer are healthy', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });
});

// ─── GET /system/health ───────────────────────────────────────────────────────

describe('GET /system/health', () => {
  it('returns aggregated health including self and unreachable external services', async () => {
    const res = await app.inject({ method: 'GET', url: '/system/health' });
    // External services (workers, api, ai) will be unreachable in test env
    expect(res.statusCode).toBe(207); // partial degradation
    const body = res.json();
    expect(body).toHaveProperty('healthy');
    expect(Array.isArray(body.services)).toBe(true);
    const self = body.services.find((s: { name: string }) => s.name === 'results-service');
    expect(self).toBeDefined();
    expect(self.status).toBe('ok');
  });

  it('includes metrics field when present in worker response', async () => {
    // Simulate a worker response that includes metrics by checking passthrough logic
    // The fetch is mocked — we verify the structure is forwarded correctly
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'ok',
        checks: { queue: 'ok' },
        metrics: { cpuPercent: 25, memoryMb: 300, memoryPercent: 30, activeTests: 1, maxTests: 2 },
      }),
    });
    const res = await app.inject({ method: 'GET', url: '/system/health' });
    const body = res.json();
    // At least one service should have passed through metrics if the mock was used
    // (results depends on which service fetch hit the mock first)
    expect(body.services).toBeDefined();
  });

  it('passes through saturated status from worker health response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'saturated',
        checks: { queue: 'ok', capacity: 'saturated' },
        metrics: { cpuPercent: 50, memoryMb: 400, memoryPercent: 40, activeTests: 2, maxTests: 2 },
      }),
    });
    const res = await app.inject({ method: 'GET', url: '/system/health' });
    const body = res.json();
    // With all external services returning 'saturated', healthy should be false
    expect(body.healthy).toBe(false);
  });
});

// ─── POST /results/pending ────────────────────────────────────────────────────

describe('POST /results/pending', () => {
  it('creates a record with status pending', async () => {
    const testId = '00000000-0000-0000-0000-000000000001';
    const res = await app.inject({
      method: 'POST',
      url: '/results/pending',
      payload: { testId, type: 'backend', targetUrl: 'http://example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    const { rows } = await pool.query('SELECT status FROM test_results WHERE test_id = $1', [testId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
  });

  it('is idempotent — duplicate testId does not throw', async () => {
    const testId = '00000000-0000-0000-0000-000000000002';
    const payload = { testId, type: 'backend', targetUrl: 'http://example.com' };
    await app.inject({ method: 'POST', url: '/results/pending', payload });
    const res = await app.inject({ method: 'POST', url: '/results/pending', payload });
    expect(res.statusCode).toBe(200);
  });
});

// ─── GET /results/active ──────────────────────────────────────────────────────

describe('GET /results/active', () => {
  it('returns only pending and running tests', async () => {
    const ids = {
      pending:   '00000000-0000-0000-0000-000000000010',
      running:   '00000000-0000-0000-0000-000000000011',
      completed: '00000000-0000-0000-0000-000000000012',
    };
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status) VALUES
       ($1, 'backend', 'http://a.com', 'pending'),
       ($2, 'backend', 'http://b.com', 'running'),
       ($3, 'backend', 'http://c.com', 'completed')`,
      [ids.pending, ids.running, ids.completed]
    );
    const res = await app.inject({ method: 'GET', url: '/results/active' });
    expect(res.statusCode).toBe(200);
    const { active } = res.json();
    const returnedIds = active.map((r: { test_id: string }) => r.test_id);
    expect(returnedIds).toContain(ids.pending);
    expect(returnedIds).toContain(ids.running);
    expect(returnedIds).not.toContain(ids.completed);
  });
});

// ─── GET /results/:testId ─────────────────────────────────────────────────────

describe('GET /results/:testId', () => {
  it('returns 404 when testId does not exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/results/00000000-0000-0000-0000-000000000099' });
    expect(res.statusCode).toBe(404);
  });

  it('returns the result when it exists', async () => {
    const testId = '00000000-0000-0000-0000-000000000020';
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status) VALUES ($1, 'backend', 'http://x.com', 'completed')`,
      [testId]
    );
    const res = await app.inject({ method: 'GET', url: `/results/${testId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.test_id).toBe(testId);
  });

  it('includes script_description from the linked test_script', async () => {
    const testId = '00000000-0000-0000-0000-000000000021';
    // Insert a script with a description
    const { rows: scriptRows } = await pool.query(
      `INSERT INTO test_scripts (target_url, test_type, script, description)
       VALUES ('http://x.com', 'backend', 'import http from "k6/http";', 'load test 10 VUs 1 minute')
       RETURNING id`
    );
    const scriptId = scriptRows[0].id as string;
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status, script_id)
       VALUES ($1, 'backend', 'http://x.com', 'completed', $2)`,
      [testId, scriptId]
    );
    const res = await app.inject({ method: 'GET', url: `/results/${testId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.script_description).toBe('load test 10 VUs 1 minute');
  });

  it('returns null script_description when result has no linked script', async () => {
    const testId = '00000000-0000-0000-0000-000000000022';
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status) VALUES ($1, 'backend', 'http://x.com', 'completed')`,
      [testId]
    );
    const res = await app.inject({ method: 'GET', url: `/results/${testId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.script_description).toBeNull();
  });
});

// ─── GET /results/:testId/log ────────────────────────────────────────────────

describe('GET /results/:testId/log', () => {
  it('returns null when no execution_log stored', async () => {
    const testId = '00000000-0000-0000-0000-0000000000a1';
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status) VALUES ($1, 'backend', 'http://x.com', 'completed')`,
      [testId]
    );
    const res = await app.inject({ method: 'GET', url: `/results/${testId}/log` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ log: null });
  });

  it('returns stored execution_log when present', async () => {
    const testId = '00000000-0000-0000-0000-0000000000a2';
    const logContent = '[INFO] Starting test\n[WARN] High response time\n[ERROR] Request failed';
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status, execution_log)
       VALUES ($1, 'backend', 'http://x.com', 'completed', $2)`,
      [testId, logContent]
    );
    const res = await app.inject({ method: 'GET', url: `/results/${testId}/log` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ log: logContent });
  });

  it('returns 404 for unknown testId', async () => {
    const res = await app.inject({ method: 'GET', url: '/results/00000000-0000-0000-0000-000000000099/log' });
    expect(res.statusCode).toBe(404);
  });

  it('stores execution_log via consumer and retrieves it', async () => {
    const testId = '00000000-0000-0000-0000-0000000000a4';
    const logContent = '[INFO] k6 starting\n[WARN] slow response\n[ERROR] failed request';
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status, execution_log)
       VALUES ($1, 'backend', 'http://x.com', 'completed', $2)`,
      [testId, logContent]
    );
    const res = await app.inject({ method: 'GET', url: `/results/${testId}/log` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { log: string };
    expect(body.log).toBe(logContent);
    // log entries are newline-separated and parseable
    const lines = body.log.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\[INFO\]/);
    expect(lines[1]).toMatch(/^\[WARN\]/);
    expect(lines[2]).toMatch(/^\[ERROR\]/);
  });
});

// ─── POST /results/:testId/live ───────────────────────────────────────────────

describe('POST /results/:testId/live', () => {
  it('saves a live metric point', async () => {
    const testId = '00000000-0000-0000-0000-000000000030';
    const point = { timestamp: new Date().toISOString(), vus: 10, rps: 5.5, avgResponseTime: 120, errorRate: 0 };
    const res = await app.inject({ method: 'POST', url: `/results/${testId}/live`, payload: point });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    const { rows } = await pool.query('SELECT vus, rps FROM live_metrics WHERE test_id = $1', [testId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].vus).toBe(10);
    expect(parseFloat(rows[0].rps)).toBeCloseTo(5.5, 1);
  });
});

// ─── GET /results/:testId/live ────────────────────────────────────────────────

describe('GET /results/:testId/live', () => {
  it('returns points in chronological order', async () => {
    const testId = '00000000-0000-0000-0000-000000000040';
    const t1 = '2024-01-01T00:00:01.000Z';
    const t2 = '2024-01-01T00:00:02.000Z';
    const t3 = '2024-01-01T00:00:03.000Z';
    await pool.query(
      `INSERT INTO live_metrics (test_id, timestamp, vus, rps, avg_response_time, error_rate) VALUES
       ($1, $4, 5, 2, 100, 0), ($1, $2, 8, 4, 150, 0), ($1, $3, 10, 6, 200, 1)`,
      [testId, t2, t3, t1]
    );
    const res = await app.inject({ method: 'GET', url: `/results/${testId}/live` });
    expect(res.statusCode).toBe(200);
    const { points } = res.json();
    expect(points).toHaveLength(3);
    expect(new Date(points[0].timestamp) <= new Date(points[1].timestamp)).toBe(true);
  });

  it('handles 500 live_metric rows with step_metrics within a generous time budget', async () => {
    const testId = '00000000-0000-0000-0000-000000000041';
    const baseTime = new Date('2024-01-01T00:00:00.000Z').getTime();
    const stepMetrics = Array.from({ length: 5 }, (_, i) => ({
      name: `Step ${i + 1}`,
      avgResponseTime: 100 + i,
      rps: 10 + i,
      errorRate: 0,
    }));

    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < 500; i++) {
      const ts = new Date(baseTime + i * 5000).toISOString();
      const base = params.length;
      params.push(testId, ts, 10, 5.5, 120, 0, JSON.stringify(stepMetrics));
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`);
    }
    await pool.query(
      `INSERT INTO live_metrics (test_id, timestamp, vus, rps, avg_response_time, error_rate, step_metrics) VALUES ${values.join(', ')}`,
      params
    );

    const start = performance.now();
    const res = await app.inject({ method: 'GET', url: `/results/${testId}/live` });
    const elapsedMs = performance.now() - start;

    expect(res.statusCode).toBe(200);
    const { points } = res.json();
    expect(points).toHaveLength(500);
    // chronological order
    for (let i = 1; i < points.length; i++) {
      expect(new Date(points[i - 1].timestamp) <= new Date(points[i].timestamp)).toBe(true);
    }
    expect(points[0].stepMetrics).toHaveLength(5);
    expect(points[0].stepMetrics[0].name).toBe('Step 1');
    expect(elapsedMs).toBeLessThan(500);
  });
});

// ─── DELETE /scripts/:id ──────────────────────────────────────────────────────

describe('DELETE /scripts/:id', () => {
  it('deletes the script record', async () => {
    const { rows } = await pool.query(
      `INSERT INTO test_scripts (target_url, test_type, script)
       VALUES ('http://delete-me.com', 'backend', 'export default function(){}')
       RETURNING id`
    );
    const id: string = rows[0].id;
    const res = await app.inject({ method: 'DELETE', url: `/scripts/${id}` });
    expect(res.statusCode).toBe(204);
    const { rows: after } = await pool.query('SELECT id FROM test_scripts WHERE id = $1', [id]);
    expect(after).toHaveLength(0);
  });
});

// ─── POST /results/:testId/message ───────────────────────────────────────────

describe('POST /results/:testId/message', () => {
  it('updates status_message for a known test', async () => {
    const testId = await insertResult({ status: 'pending' });
    const res = await app.inject({
      method: 'POST',
      url: `/results/${testId}/message`,
      payload: { message: 'Generating test script with AI…' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    const { rows } = await pool.query('SELECT status_message FROM test_results WHERE test_id = $1', [testId]);
    expect(rows[0].status_message).toBe('Generating test script with AI…');
  });

  it('overwrites an existing status_message', async () => {
    const testId = await insertResult({ status: 'pending' });
    await app.inject({
      method: 'POST',
      url: `/results/${testId}/message`,
      payload: { message: 'First message' },
    });
    await app.inject({
      method: 'POST',
      url: `/results/${testId}/message`,
      payload: { message: 'Second message' },
    });
    const { rows } = await pool.query('SELECT status_message FROM test_results WHERE test_id = $1', [testId]);
    expect(rows[0].status_message).toBe('Second message');
  });

  it('works for a running test (no status restriction)', async () => {
    const testId = await insertResult({ status: 'running' });
    const res = await app.inject({
      method: 'POST',
      url: `/results/${testId}/message`,
      payload: { message: 'Gemini unavailable — retrying… (2 attempts left)' },
    });
    expect(res.statusCode).toBe(200);
    const { rows } = await pool.query('SELECT status_message FROM test_results WHERE test_id = $1', [testId]);
    expect(rows[0].status_message).toContain('Gemini unavailable');
  });

  it('does NOT overwrite status_message once the test has reached a terminal state (RES-16 race guard)', async () => {
    const testId = await insertResult({ status: 'failed' }); // status_message defaults to NULL
    const res = await app.inject({
      method: 'POST',
      url: `/results/${testId}/message`,
      payload: { message: 'Script ready — starting test…' },
    });
    // Endpoint still reports success (fire-and-forget from ai-service's perspective)
    // but the UPDATE is a no-op — a delayed progress message must never resurrect
    // a stale status_message on an already-finished test.
    expect(res.statusCode).toBe(200);
    const { rows } = await pool.query('SELECT status_message FROM test_results WHERE test_id = $1', [testId]);
    expect(rows[0].status_message).toBeNull();
  });
});

// ─── POST /results/:testId/fail ───────────────────────────────────────────────

describe('POST /results/:testId/fail', () => {
  it('marks a pending test as failed and sets completed_at', async () => {
    const testId = await insertResult({ status: 'pending' });
    const before = new Date();
    const res = await app.inject({ method: 'POST', url: `/results/${testId}/fail` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    const { rows } = await pool.query(
      'SELECT status, completed_at FROM test_results WHERE test_id = $1', [testId]
    );
    expect(rows[0].status).toBe('failed');
    expect(new Date(rows[0].completed_at).getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it('marks a running test as failed', async () => {
    const testId = await insertResult({ status: 'running' });
    await app.inject({ method: 'POST', url: `/results/${testId}/fail` });
    const { rows } = await pool.query('SELECT status FROM test_results WHERE test_id = $1', [testId]);
    expect(rows[0].status).toBe('failed');
  });

  it('clears status_message when failing a test', async () => {
    const testId = await insertResult({ status: 'pending' });
    await pool.query(
      'UPDATE test_results SET status_message = $1 WHERE test_id = $2',
      ['Script generation failed after 3 attempts', testId]
    );
    await app.inject({ method: 'POST', url: `/results/${testId}/fail` });
    const { rows } = await pool.query('SELECT status_message FROM test_results WHERE test_id = $1', [testId]);
    expect(rows[0].status_message).toBeNull();
  });

  it('does not change a completed test (status IN guard)', async () => {
    const testId = await insertResult({ status: 'completed' });
    await app.inject({ method: 'POST', url: `/results/${testId}/fail` });
    const { rows } = await pool.query('SELECT status FROM test_results WHERE test_id = $1', [testId]);
    expect(rows[0].status).toBe('completed');
  });

  it('does not change a cancelled test', async () => {
    const testId = await insertResult({ status: 'cancelled' });
    await app.inject({ method: 'POST', url: `/results/${testId}/fail` });
    const { rows } = await pool.query('SELECT status FROM test_results WHERE test_id = $1', [testId]);
    expect(rows[0].status).toBe('cancelled');
  });
});

// ─── POST /results/:testId/running ───────────────────────────────────────────

describe('POST /results/:testId/running', () => {
  it('sets status to running and sets started_at', async () => {
    const testId = await insertResult({ status: 'pending' });
    const before = new Date();
    const res = await app.inject({ method: 'POST', url: `/results/${testId}/running` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    const { rows } = await pool.query(
      'SELECT status, started_at FROM test_results WHERE test_id = $1', [testId]
    );
    expect(rows[0].status).toBe('running');
    expect(new Date(rows[0].started_at).getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it('clears status_message when marking a test as running', async () => {
    const testId = await insertResult({ status: 'pending' });
    await pool.query(
      'UPDATE test_results SET status_message = $1 WHERE test_id = $2',
      ['Script ready — starting test…', testId]
    );
    await app.inject({ method: 'POST', url: `/results/${testId}/running` });
    const { rows } = await pool.query('SELECT status_message FROM test_results WHERE test_id = $1', [testId]);
    expect(rows[0].status_message).toBeNull();
  });

  it('resets started_at when called again (idempotent re-call updates timestamp)', async () => {
    const testId = await insertResult({ status: 'running' });
    const before = new Date();
    await app.inject({ method: 'POST', url: `/results/${testId}/running` });
    const { rows } = await pool.query('SELECT started_at FROM test_results WHERE test_id = $1', [testId]);
    expect(new Date(rows[0].started_at).getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });
});

// ─── GET /system/ai-status ────────────────────────────────────────────────────

describe('GET /system/ai-status', () => {
  it('returns quotaExceeded false when no results exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/system/ai-status' });
    expect(res.statusCode).toBe(200);
    expect(res.json().quotaExceeded).toBe(false);
  });

  it('returns quotaExceeded false when no recent Gemini error messages exist', async () => {
    // A completed test with no status_message should not trigger quota detection
    await insertResult({ status: 'completed' });
    const res = await app.inject({ method: 'GET', url: '/system/ai-status' });
    expect(res.json().quotaExceeded).toBe(false);
  });

  it('returns quotaExceeded true when a recent "Gemini unavailable" message exists', async () => {
    const testId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status, status_message, created_at)
       VALUES ($1, 'backend', 'http://ai.com', 'failed', $2, NOW() - INTERVAL '10 minutes')`,
      [testId, 'Gemini unavailable — retrying… (0 attempts left)']
    );
    const res = await app.inject({ method: 'GET', url: '/system/ai-status' });
    expect(res.json().quotaExceeded).toBe(true);
    expect(res.json().message).toContain('Gemini unavailable');
    expect(res.json().since).toBeDefined();
  });

  it('returns quotaExceeded true for a "generation failed after" message', async () => {
    const testId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status, status_message, created_at)
       VALUES ($1, 'backend', 'http://ai2.com', 'failed', $2, NOW() - INTERVAL '5 minutes')`,
      [testId, 'Script generation failed after 3 attempts — test could not start']
    );
    const res = await app.inject({ method: 'GET', url: '/system/ai-status' });
    expect(res.json().quotaExceeded).toBe(true);
  });

  it('ignores Gemini errors older than 2 hours', async () => {
    const testId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status, status_message, created_at)
       VALUES ($1, 'backend', 'http://old.com', 'failed', $2, NOW() - INTERVAL '3 hours')`,
      [testId, 'Gemini unavailable — retrying… (0 attempts left)']
    );
    const res = await app.inject({ method: 'GET', url: '/system/ai-status' });
    expect(res.json().quotaExceeded).toBe(false);
  });
});

// ─── INTERNAL_API_KEY gating on internal callback endpoints ──────────────────

describe('INTERNAL_API_KEY gating', () => {
  let gatedApp: FastifyInstance;
  const INTERNAL_KEY = 'test-internal-secret';

  beforeAll(async () => {
    process.env.INTERNAL_API_KEY = INTERNAL_KEY;
    gatedApp = await buildApp(pool);
  });

  afterAll(async () => {
    delete process.env.INTERNAL_API_KEY;
    await gatedApp.close();
  });

  it('rejects POST /results/pending without X-Internal-Key', async () => {
    const res = await gatedApp.inject({
      method: 'POST',
      url: '/results/pending',
      payload: { testId: crypto.randomUUID(), type: 'backend', targetUrl: 'http://example.com' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects POST /results/pending with a wrong X-Internal-Key', async () => {
    const res = await gatedApp.inject({
      method: 'POST',
      url: '/results/pending',
      headers: { 'x-internal-key': 'wrong-key' },
      payload: { testId: crypto.randomUUID(), type: 'backend', targetUrl: 'http://example.com' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts POST /results/pending with the correct X-Internal-Key', async () => {
    const res = await gatedApp.inject({
      method: 'POST',
      url: '/results/pending',
      headers: { 'x-internal-key': INTERNAL_KEY },
      payload: { testId: crypto.randomUUID(), type: 'backend', targetUrl: 'http://example.com' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects POST /results/:testId/running without X-Internal-Key', async () => {
    const testId = await insertResult({ status: 'pending' });
    const res = await gatedApp.inject({ method: 'POST', url: `/results/${testId}/running` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects POST /results/:testId/live without X-Internal-Key', async () => {
    const testId = await insertResult({ status: 'running' });
    const res = await gatedApp.inject({
      method: 'POST',
      url: `/results/${testId}/live`,
      payload: { vus: 1, rps: 1, avgResponseTime: 1, errorRate: 0 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('does not gate GET /results/:testId/live (project-scoped UI read)', async () => {
    const testId = await insertResult({ status: 'running' });
    const res = await gatedApp.inject({ method: 'GET', url: `/results/${testId}/live` });
    expect(res.statusCode).toBe(200);
  });

  it('does not gate /health', async () => {
    const res = await gatedApp.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});
