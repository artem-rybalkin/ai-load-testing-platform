import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { handleResult } from '../consumer';
import { createSchema } from '../db';
import type { TestResult, BackendMetrics } from '@alt/shared';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let mockFetch: ReturnType<typeof vi.fn>;

const baseMetrics: BackendMetrics = {
  type: 'backend',
  requestsTotal: 1000,
  requestsFailed: 0,
  avgResponseTime: 200,
  p50ResponseTime: 180,
  p95ResponseTime: 400,
  p99ResponseTime: 600,
  rps: 50,
};

const failedMetrics: BackendMetrics = {
  ...baseMetrics,
  p95ResponseTime: 2000, // exceeds 1000ms threshold → perf_status = 'failed'
};

const makeResult = (overrides: Partial<TestResult> = {}): TestResult => ({
  testId: crypto.randomUUID(),
  targetUrl: 'http://example.com',
  status: 'completed',
  metrics: baseMetrics,
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  completedAt: new Date().toISOString(),
  ...overrides,
});

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await createSchema(pool);
  mockFetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', mockFetch);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE live_metrics, test_results, test_scripts, webhooks, schedules, test_presets CASCADE');
  mockFetch.mockReset();
  // Default: analyser-service returns non-ok so consumer falls back to local analyzeResult;
  // webhook calls also return ok. Tests that need different behaviour override per-test.
  mockFetch.mockImplementation((url: string) => {
    if (String(url).includes('/analyse')) return Promise.resolve({ ok: false });
    return Promise.resolve({ ok: true });
  });
});

// ─── Analyser-service integration ────────────────────────────────────────────

describe('handleResult — analyser-service integration', () => {
  const analysisFromService = {
    perfStatus: 'passed' as const,
    diffs: [],
    summary: 'AI-enriched summary',
    thresholdViolations: [],
    aiInsights: {
      narrative: 'The system performed well.',
      anomalies: [],
      rootCauses: [],
      recommendations: ['No action needed'],
      severity: 'info' as const,
    },
  };

  it('stores AI-enriched analysis when analyser-service responds with 200', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('/analyse')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(analysisFromService) });
      }
      return Promise.resolve({ ok: true });
    });

    const result = makeResult();
    await handleResult(pool, result);

    const { rows } = await pool.query(
      'SELECT analysis FROM test_results WHERE test_id = $1',
      [result.testId]
    );
    expect(rows[0].analysis.aiInsights).toBeDefined();
    expect(rows[0].analysis.aiInsights.narrative).toBe('The system performed well.');
    expect(rows[0].analysis.summary).toBe('AI-enriched summary');
  });

  it('falls back to local analyzeResult when analyser-service returns non-ok', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('/analyse')) {
        return Promise.resolve({ ok: false, status: 503 });
      }
      return Promise.resolve({ ok: true });
    });

    const result = makeResult();
    await handleResult(pool, result);

    const { rows } = await pool.query(
      'SELECT analysis FROM test_results WHERE test_id = $1',
      [result.testId]
    );
    // Local analyzeResult produces no diffs (no previous run) and no aiInsights
    expect(rows[0].analysis).toBeDefined();
    expect(rows[0].analysis.aiInsights).toBeUndefined();
    expect(rows[0].perf_status).toBe('passed');
  });

  it('falls back to local analyzeResult when analyser-service throws (network error)', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('/analyse')) {
        return Promise.reject(new Error('ECONNREFUSED'));
      }
      return Promise.resolve({ ok: true });
    });

    const result = makeResult();
    // Should not throw — fallback handles the error
    await expect(handleResult(pool, result)).resolves.toBeUndefined();

    const { rows } = await pool.query(
      'SELECT perf_status FROM test_results WHERE test_id = $1',
      [result.testId]
    );
    expect(rows[0].perf_status).toBe('passed');
  });

  it('falls back to local analyzeResult when analyser-service times out', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('/analyse')) {
        return new Promise((_, reject) =>
          setTimeout(() => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' })), 0)
        );
      }
      return Promise.resolve({ ok: true });
    });

    const result = makeResult();
    await expect(handleResult(pool, result)).resolves.toBeUndefined();

    const { rows } = await pool.query(
      'SELECT perf_status FROM test_results WHERE test_id = $1',
      [result.testId]
    );
    expect(rows[0].perf_status).toBe('passed');
  });

  it('still fires webhooks correctly after AI-enriched analysis', async () => {
    await pool.query(
      `INSERT INTO webhooks (url, events) VALUES ('https://hook.example.com', '{failed,degraded}')`
    );
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('/analyse')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ...analysisFromService, perfStatus: 'failed', thresholdViolations: ['p95 exceeded'] }),
        });
      }
      return Promise.resolve({ ok: true });
    });

    const result = makeResult({ metrics: failedMetrics });
    await handleResult(pool, result);

    await vi.waitFor(
      () => expect(mockFetch).toHaveBeenCalledWith('https://hook.example.com', expect.anything()),
      { timeout: 1000 }
    );
  });
});

// ─── Result persistence ───────────────────────────────────────────────────────

describe('handleResult — result persistence', () => {
  it('inserts a completed result row with correct fields', async () => {
    const result = makeResult();
    await handleResult(pool, result);
    const { rows } = await pool.query('SELECT * FROM test_results WHERE test_id = $1', [result.testId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('completed');
    expect(rows[0].target_url).toBe('http://example.com');
    expect(rows[0].metrics).toMatchObject({ type: 'backend' });
    expect(rows[0].perf_status).toBe('passed');
    expect(rows[0].analysis).toBeDefined();
  });

  it('produces no diffs when there is no previous result for this URL', async () => {
    const result = makeResult();
    await handleResult(pool, result);
    const { rows } = await pool.query('SELECT analysis FROM test_results WHERE test_id = $1', [result.testId]);
    expect(rows[0].analysis.diffs).toEqual([]);
  });

  it('produces diffs when a previous completed result exists for the same URL', async () => {
    const previousId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status, metrics, started_at, completed_at)
       VALUES ($1, 'backend', 'http://example.com', 'completed', $2, NOW()-INTERVAL '5 min', NOW()-INTERVAL '4 min')`,
      [previousId, JSON.stringify({ ...baseMetrics, avgResponseTime: 100 })]
    );
    // 200ms vs 100ms previous = +100% worse → degraded
    const result = makeResult({ metrics: { ...baseMetrics, avgResponseTime: 200 } });
    await handleResult(pool, result);
    const { rows } = await pool.query('SELECT analysis FROM test_results WHERE test_id = $1', [result.testId]);
    expect(rows[0].analysis.diffs.length).toBeGreaterThan(0);
    const avgDiff = rows[0].analysis.diffs.find((d: { metric: string }) => d.metric === 'Avg response time');
    expect(avgDiff).toBeDefined();
    expect(avgDiff.current).toBe(200);
    expect(avgDiff.previous).toBe(100);
  });

  it('upserts when a pending row already exists for the same test_id', async () => {
    const testId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status) VALUES ($1, 'backend', 'http://example.com', 'pending')`,
      [testId]
    );
    const result = makeResult({ testId, status: 'completed' });
    await handleResult(pool, result);
    const { rows } = await pool.query('SELECT status, perf_status FROM test_results WHERE test_id = $1', [testId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('completed');
    expect(rows[0].perf_status).toBe('passed');
  });
});

// ─── Baseline ordering ────────────────────────────────────────────────────────

describe('handleResult — baseline ordering', () => {
  it('prefers baseline over the most-recent run when selecting comparison target', async () => {
    // Recent result (no baseline flag): fast metrics that would make current look worse
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status, metrics, started_at, completed_at, created_at, is_baseline)
       VALUES ($1, 'backend', 'http://baseline-test.com', 'completed', $2,
               NOW()-INTERVAL '2 min', NOW()-INTERVAL '1 min', NOW()-INTERVAL '1 min', FALSE)`,
      [crypto.randomUUID(), JSON.stringify({ ...baseMetrics, avgResponseTime: 100 })]
    );
    // Baseline (older, is_baseline=TRUE): slower metrics that make current look better
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status, metrics, started_at, completed_at, created_at, is_baseline)
       VALUES ($1, 'backend', 'http://baseline-test.com', 'completed', $2,
               NOW()-INTERVAL '10 min', NOW()-INTERVAL '9 min', NOW()-INTERVAL '5 min', TRUE)`,
      [crypto.randomUUID(), JSON.stringify({ ...baseMetrics, avgResponseTime: 500 })]
    );

    // Current: 300ms
    //   vs recent  (100ms): +200% worse → would be 'degraded'
    //   vs baseline (500ms): -40% better → should be 'passed'
    const result = makeResult({
      targetUrl: 'http://baseline-test.com',
      metrics: { ...baseMetrics, avgResponseTime: 300 },
    });
    await handleResult(pool, result);

    const { rows } = await pool.query(
      'SELECT perf_status, analysis FROM test_results WHERE test_id = $1',
      [result.testId]
    );
    expect(rows[0].perf_status).toBe('passed');
    const avgDiff = rows[0].analysis.diffs.find((d: { metric: string }) => d.metric === 'Avg response time');
    expect(avgDiff.status).toBe('better');
  });
});

// ─── Webhook firing ───────────────────────────────────────────────────────────

describe('handleResult — webhook firing', () => {
  const insertWebhook = (events: string[], secret?: string) =>
    pool.query(
      `INSERT INTO webhooks (url, events, secret) VALUES ('https://hook.example.com/notify', $1, $2)`,
      [events, secret ?? null]
    );

  it('fires a webhook when perf_status is failed', async () => {
    await insertWebhook(['failed', 'degraded']);
    const result = makeResult({ metrics: failedMetrics });
    await handleResult(pool, result);
    await vi.waitFor(
      () => expect(mockFetch).toHaveBeenCalledWith(
        'https://hook.example.com/notify',
        expect.objectContaining({ method: 'POST' })
      ),
      { timeout: 1000 }
    );
    const webhookCall = mockFetch.mock.calls.find(([url]) => String(url) === 'https://hook.example.com/notify');
    const body = JSON.parse(webhookCall![1].body);
    expect(body.perfStatus).toBe('failed');
    expect(body.testId).toBe(result.testId);
    expect(body.targetUrl).toBe(result.targetUrl);
  });

  it('fires a webhook when perf_status is degraded', async () => {
    await insertWebhook(['failed', 'degraded']);
    // Previous fast result → current slower → degraded
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status, metrics, started_at, completed_at)
       VALUES ($1, 'backend', 'http://degrade.com', 'completed', $2, NOW()-INTERVAL '5 min', NOW()-INTERVAL '4 min')`,
      [crypto.randomUUID(), JSON.stringify({ ...baseMetrics, avgResponseTime: 100 })]
    );
    // 200ms vs 100ms previous = +100% → degraded
    const result = makeResult({
      targetUrl: 'http://degrade.com',
      metrics: { ...baseMetrics, avgResponseTime: 200 },
    });
    await handleResult(pool, result);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledWith('https://hook.example.com/notify', expect.anything()), { timeout: 1000 });
    const webhookCall = mockFetch.mock.calls.find(([url]) => String(url) === 'https://hook.example.com/notify');
    const body = JSON.parse(webhookCall![1].body);
    expect(body.perfStatus).toBe('degraded');
  });

  it('does not fire a webhook when perf_status is passed', async () => {
    await insertWebhook(['failed', 'degraded']);
    const result = makeResult(); // all metrics fine, no previous → passed
    await handleResult(pool, result);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not fire a webhook when its events list does not match the perf_status', async () => {
    await insertWebhook(['degraded']); // only 'degraded', not 'failed'
    const result = makeResult({ metrics: failedMetrics }); // triggers 'failed'
    await handleResult(pool, result);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('includes X-Webhook-Secret header when webhook has a secret', async () => {
    await insertWebhook(['failed'], 'my-secret-token');
    const result = makeResult({ metrics: failedMetrics });
    await handleResult(pool, result);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledWith('https://hook.example.com/notify', expect.anything()), { timeout: 1000 });
    const callWithSecret = mockFetch.mock.calls.find(([url]) => String(url) === 'https://hook.example.com/notify');
    expect(callWithSecret![1].headers['X-Webhook-Secret']).toBe('my-secret-token');
  });

  it('does not include X-Webhook-Secret header when webhook has no secret', async () => {
    await insertWebhook(['failed'], undefined);
    const result = makeResult({ metrics: failedMetrics });
    await handleResult(pool, result);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledWith('https://hook.example.com/notify', expect.anything()), { timeout: 1000 });
    const callWithoutSecret = mockFetch.mock.calls.find(([url]) => String(url) === 'https://hook.example.com/notify');
    expect(callWithoutSecret![1].headers['X-Webhook-Secret']).toBeUndefined();
  });
});
