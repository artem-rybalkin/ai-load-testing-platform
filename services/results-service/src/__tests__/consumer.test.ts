import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool, QueryResult } from 'pg';
import { createTestDatabase } from '../../../../test-support/sharedPostgres';
import { handleResult } from '../consumer';
import { createSchema } from '../db';
import type { TestResult, BackendMetrics } from '@alt/shared';

let pool: Pool;
let dropDb: () => Promise<void>;
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
  ({ pool, drop: dropDb } = await createTestDatabase());
  await createSchema(pool);
  mockFetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', mockFetch);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await dropDb();
});

beforeEach(async () => {
  await pool.query('TRUNCATE live_metrics, test_results, test_scripts, webhooks, schedules, test_presets, log_sources CASCADE');
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

  it('passes the result projectId as teamId in the /analyse request body', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('/analyse')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(analysisFromService) });
      }
      return Promise.resolve({ ok: true });
    });

    const projectId = crypto.randomUUID();
    await pool.query(`INSERT INTO projects (id, name) VALUES ($1, $2)`, [projectId, `proj-${projectId}`]);
    const result = makeResult({ projectId });
    await handleResult(pool, result);

    const call = mockFetch.mock.calls.find(([url]) => String(url).includes('/analyse'));
    const body = JSON.parse(call![1].body);
    expect(body.teamId).toBe(projectId);
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
      'SELECT analysis, perf_status FROM test_results WHERE test_id = $1',
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
  const insertWebhook = (events: string[], secret?: string): Promise<QueryResult> =>
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
    // analyser-service IS called (that's expected); only assert the webhook URL was not called
    expect(mockFetch).not.toHaveBeenCalledWith('https://hook.example.com/notify', expect.anything());
  });

  it('does not fire a webhook when its events list does not match the perf_status', async () => {
    await insertWebhook(['degraded']); // only 'degraded', not 'failed'
    const result = makeResult({ metrics: failedMetrics }); // triggers 'failed'
    await handleResult(pool, result);
    await new Promise(resolve => setTimeout(resolve, 50));
    // analyser-service IS called (that's expected); only assert the webhook URL was not called
    expect(mockFetch).not.toHaveBeenCalledWith('https://hook.example.com/notify', expect.anything());
  });

  it('includes X-Webhook-Signature header (sha256 HMAC) when webhook has a secret', async () => {
    await insertWebhook(['failed'], 'my-secret-token');
    const result = makeResult({ metrics: failedMetrics });
    await handleResult(pool, result);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledWith('https://hook.example.com/notify', expect.anything()), { timeout: 1000 });
    const callWithSecret = mockFetch.mock.calls.find(([url]) => String(url) === 'https://hook.example.com/notify');
    const sig = callWithSecret![1].headers['X-Webhook-Signature'] as string;
    expect(sig).toBeDefined();
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('does not include X-Webhook-Signature header when webhook has no secret', async () => {
    await insertWebhook(['failed'], undefined);
    const result = makeResult({ metrics: failedMetrics });
    await handleResult(pool, result);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledWith('https://hook.example.com/notify', expect.anything()), { timeout: 1000 });
    const callWithoutSecret = mockFetch.mock.calls.find(([url]) => String(url) === 'https://hook.example.com/notify');
    expect(callWithoutSecret![1].headers['X-Webhook-Signature']).toBeUndefined();
  });
});

// ─── Webhook payload formats ───────────────────────────────────────────────

describe('handleResult — webhook payload formats', () => {
  const insertWebhookWithFormat = (events: string[], format: string): Promise<QueryResult> =>
    pool.query(
      `INSERT INTO webhooks (url, events, format) VALUES ('https://hook.example.com/notify', $1, $2)`,
      [events, format]
    );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fireAndGetPayload = async (format: string, perfStatus: 'failed' | 'degraded' = 'failed'): Promise<{ result: TestResult; options: any; body: any }> => {
    await insertWebhookWithFormat([perfStatus], format);
    const result = makeResult(perfStatus === 'failed' ? { metrics: failedMetrics } : {
      targetUrl: 'http://degrade-format.com',
      metrics: { ...baseMetrics, avgResponseTime: 200 },
    });
    if (perfStatus === 'degraded') {
      await pool.query(
        `INSERT INTO test_results (test_id, type, target_url, status, metrics, started_at, completed_at)
         VALUES ($1, 'backend', 'http://degrade-format.com', 'completed', $2, NOW()-INTERVAL '5 min', NOW()-INTERVAL '4 min')`,
        [crypto.randomUUID(), JSON.stringify({ ...baseMetrics, avgResponseTime: 100 })]
      );
    }
    await handleResult(pool, result);
    await vi.waitFor(
      () => expect(mockFetch).toHaveBeenCalledWith('https://hook.example.com/notify', expect.anything()),
      { timeout: 1000 }
    );
    const call = mockFetch.mock.calls.find(([url]) => String(url) === 'https://hook.example.com/notify');
    return { result, options: call![1], body: JSON.parse(call![1].body) };
  };

  it('builds a Slack attachment payload for format = slack', async () => {
    const { result, options, body } = await fireAndGetPayload('slack');

    expect(options.headers['Content-Type']).toBe('application/json');
    expect(body.text).toMatch(/FAILED/);
    expect(Array.isArray(body.attachments)).toBe(true);
    expect(body.attachments[0].color).toBe('#cf222e');
    const fields = body.attachments[0].fields;
    expect(fields.find((f: { title: string }) => f.title === 'URL').value).toBe(result.targetUrl);
    expect(fields.find((f: { title: string }) => f.title === 'Test ID').value).toBe(result.testId);
    expect(fields.find((f: { title: string }) => f.title === 'Status').value).toBe('failed');
  });

  it('builds a PagerDuty Events API v2 payload for format = pagerduty', async () => {
    const { result, body } = await fireAndGetPayload('pagerduty', 'failed');

    expect(body.event_action).toBe('trigger');
    expect(body.payload.severity).toBe('error');
    expect(body.payload.source).toBe(result.targetUrl);
    expect(body.payload.custom_details.testId).toBe(result.testId);
    expect(body.payload.custom_details.perfStatus).toBe('failed');
  });

  it('builds a PagerDuty payload with acknowledge action + warning severity for degraded', async () => {
    const { body } = await fireAndGetPayload('pagerduty', 'degraded');

    expect(body.event_action).toBe('acknowledge');
    expect(body.payload.severity).toBe('warning');
  });

  it('builds an OpsGenie Alert API payload for format = opsgenie', async () => {
    const { result, body } = await fireAndGetPayload('opsgenie', 'failed');

    expect(body.message).toMatch(result.targetUrl);
    expect(body.alias).toBe(result.testId);
    expect(body.priority).toBe('P2');
    expect(body.details.testId).toBe(result.testId);
    expect(body.details.targetUrl).toBe(result.targetUrl);
    expect(body.source).toBe('AI Load Testing Platform');
  });

  it('builds an OpsGenie payload with P3 priority for degraded', async () => {
    const { body } = await fireAndGetPayload('opsgenie', 'degraded');

    expect(body.priority).toBe('P3');
  });

  it('does not apply HMAC signature to non-generic formats even when secret is set', async () => {
    await pool.query(
      `INSERT INTO webhooks (url, events, secret, format) VALUES ('https://hook.example.com/notify', '{failed}', 'my-secret', 'slack')`
    );
    const result = makeResult({ metrics: failedMetrics });
    await handleResult(pool, result);
    await vi.waitFor(
      () => expect(mockFetch).toHaveBeenCalledWith('https://hook.example.com/notify', expect.anything()),
      { timeout: 1000 }
    );
    const call = mockFetch.mock.calls.find(([url]) => String(url) === 'https://hook.example.com/notify');
    expect(call![1].headers['X-Webhook-Signature']).toBeUndefined();
  });

  it('falls back to generic payload format when format column is null', async () => {
    await pool.query(
      `INSERT INTO webhooks (url, events, format) VALUES ('https://hook.example.com/notify', '{failed}', NULL)`
    );
    const result = makeResult({ metrics: failedMetrics });
    await handleResult(pool, result);
    await vi.waitFor(
      () => expect(mockFetch).toHaveBeenCalledWith('https://hook.example.com/notify', expect.anything()),
      { timeout: 1000 }
    );
    const call = mockFetch.mock.calls.find(([url]) => String(url) === 'https://hook.example.com/notify');
    const body = JSON.parse(call![1].body);
    expect(body.perfStatus).toBe('failed');
    expect(body.testId).toBe(result.testId);
    expect(body.targetUrl).toBe(result.targetUrl);
    expect(body.timestamp).toBeDefined();
  });
});

// ─── fetchExternalMetricsForTest (via handleResult → callAnalyserService) ────

describe('handleResult — fetchExternalMetricsForTest', () => {
  const insertLogSource = (overrides: Record<string, unknown> = {}): Promise<QueryResult> =>
    pool.query(
      `INSERT INTO log_sources (name, platform, url_template, metrics_endpoint_template, auth_header)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        overrides.name ?? 'Grafana',
        overrides.platform ?? 'Grafana',
        overrides.urlTemplate ?? 'https://grafana.example.com/{testId}',
        overrides.metricsEndpointTemplate ?? null,
        overrides.authHeader ?? null,
      ]
    );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getAnalyseBody = (): any => {
    const call = mockFetch.mock.calls.find(([url]) => String(url).includes('/analyse'));
    return call ? JSON.parse(call[1].body) : null;
  };

  it('returns empty externalMetrics when no log source has a metrics_endpoint_template', async () => {
    await insertLogSource({ metricsEndpointTemplate: null });
    const result = makeResult();
    await handleResult(pool, result);
    const body = getAnalyseBody();
    expect(body.externalMetrics).toEqual([]);
  });

  it('interpolates placeholders and includes auth header when fetching from a configured log source', async () => {
    await insertLogSource({
      name: 'Loki',
      platform: 'Loki',
      metricsEndpointTemplate:
        'https://loki.example.com/query?start={startedAtMs}&end={completedAtMs}&startS={startedAtS}&endS={completedAtS}&startISO={startedAtISO}&endISO={completedAtISO}&url={targetUrlEncoded}&raw={targetUrl}',
      authHeader: 'Bearer test-token',
    });

    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    mockFetch.mockImplementation((url: string, opts?: { headers?: Record<string, string> }) => {
      if (String(url).includes('/analyse')) return Promise.resolve({ ok: false });
      if (String(url).includes('loki.example.com')) {
        capturedUrl = String(url);
        capturedHeaders = opts?.headers;
        return Promise.resolve({ ok: true, text: () => Promise.resolve('{"data":"loki-result"}') });
      }
      return Promise.resolve({ ok: true });
    });

    const started = new Date(Date.now() - 60_000);
    const completed = new Date();
    const result = makeResult({ startedAt: started.toISOString(), completedAt: completed.toISOString() });
    await handleResult(pool, result);

    expect(capturedUrl).toContain(`start=${started.getTime()}`);
    expect(capturedUrl).toContain(`end=${completed.getTime()}`);
    expect(capturedUrl).toContain(`startS=${Math.floor(started.getTime() / 1000)}`);
    expect(capturedUrl).toContain(`endS=${Math.floor(completed.getTime() / 1000)}`);
    expect(capturedUrl).toContain(`startISO=${started.toISOString()}`);
    expect(capturedUrl).toContain(`endISO=${completed.toISOString()}`);
    expect(capturedUrl).toContain(`raw=${result.targetUrl}`);
    expect(capturedUrl).toContain(`url=${encodeURIComponent(result.targetUrl)}`);
    expect(capturedHeaders?.Authorization).toBe('Bearer test-token');

    const body = getAnalyseBody();
    expect(body.externalMetrics).toHaveLength(1);
    expect(body.externalMetrics[0].sourceName).toBe('Loki');
    expect(body.externalMetrics[0].platform).toBe('Loki');
    expect(body.externalMetrics[0].data).toBe('{"data":"loki-result"}');
  });

  it('skips a log source whose fetch returns non-ok', async () => {
    await insertLogSource({ name: 'Datadog', metricsEndpointTemplate: 'https://datadog.example.com/metrics' });
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('/analyse')) return Promise.resolve({ ok: false });
      if (String(url).includes('datadog.example.com')) return Promise.resolve({ ok: false, status: 500 });
      return Promise.resolve({ ok: true });
    });

    const result = makeResult();
    await handleResult(pool, result);

    const body = getAnalyseBody();
    expect(body.externalMetrics).toEqual([]);
  });

  it('non-fatally skips a log source whose fetch throws', async () => {
    await insertLogSource({ name: 'Kibana', metricsEndpointTemplate: 'https://kibana.example.com/metrics' });
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('/analyse')) return Promise.resolve({ ok: false });
      if (String(url).includes('kibana.example.com')) return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve({ ok: true });
    });

    const result = makeResult();
    await expect(handleResult(pool, result)).resolves.toBeUndefined();

    const body = getAnalyseBody();
    expect(body.externalMetrics).toEqual([]);
  });

  it('aggregates results from multiple log sources via Promise.allSettled (mixed success/failure)', async () => {
    await insertLogSource({ name: 'Grafana', metricsEndpointTemplate: 'https://grafana.example.com/metrics' });
    await insertLogSource({ name: 'Datadog', metricsEndpointTemplate: 'https://datadog.example.com/metrics' });
    await insertLogSource({ name: 'Kibana', metricsEndpointTemplate: 'https://kibana.example.com/metrics' });

    mockFetch.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/analyse')) return Promise.resolve({ ok: false });
      if (u.includes('grafana.example.com')) return Promise.resolve({ ok: true, text: () => Promise.resolve('grafana-ok') });
      if (u.includes('datadog.example.com')) return Promise.resolve({ ok: false, status: 503 });
      if (u.includes('kibana.example.com')) return Promise.reject(new Error('timeout'));
      return Promise.resolve({ ok: true });
    });

    const result = makeResult();
    await handleResult(pool, result);

    const body = getAnalyseBody();
    expect(body.externalMetrics).toHaveLength(1);
    expect(body.externalMetrics[0].sourceName).toBe('Grafana');
    expect(body.externalMetrics[0].data).toBe('grafana-ok');
  });

  it('truncates response body to 3000 characters', async () => {
    await insertLogSource({ name: 'BigSource', metricsEndpointTemplate: 'https://big.example.com/metrics' });
    const largeBody = 'x'.repeat(5000);
    mockFetch.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/analyse')) return Promise.resolve({ ok: false });
      if (u.includes('big.example.com')) return Promise.resolve({ ok: true, text: () => Promise.resolve(largeBody) });
      return Promise.resolve({ ok: true });
    });

    const result = makeResult();
    await handleResult(pool, result);

    const body = getAnalyseBody();
    expect(body.externalMetrics).toHaveLength(1);
    expect(body.externalMetrics[0].data).toHaveLength(3000);
  });

  it('only includes log sources matching the result projectId', async () => {
    // log_sources without project_id (NULL) — project_id filter in fetchExternalMetricsForTest
    // resolves to ($1::uuid IS NULL OR project_id = $1::uuid); result has no projectId (null),
    // so the NULL-project_id source is matched (project_id IS NULL is not equal to NULL,
    // but $1 IS NULL short-circuits to true).
    await insertLogSource({ name: 'Unscoped', metricsEndpointTemplate: 'https://unscoped.example.com/metrics' });
    mockFetch.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/analyse')) return Promise.resolve({ ok: false });
      if (u.includes('unscoped.example.com')) return Promise.resolve({ ok: true, text: () => Promise.resolve('unscoped-ok') });
      return Promise.resolve({ ok: true });
    });

    const result = makeResult(); // projectId undefined → null
    await handleResult(pool, result);

    const body = getAnalyseBody();
    expect(body.externalMetrics).toHaveLength(1);
    expect(body.externalMetrics[0].sourceName).toBe('Unscoped');
  });
});
