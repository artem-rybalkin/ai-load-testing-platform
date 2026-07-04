import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from '../../../../test-support/sharedPostgres';
import { runStaleCleanup, startStaleCleanup } from '../cleanup';
import { createSchema } from '../db';

const mockBroadcast = vi.hoisted(() => vi.fn());
vi.mock('../ws', () => ({ broadcast: mockBroadcast }));

let pool: Pool;
let dropDb: () => Promise<void>;

const insertResult = async (
  status: string,
  ageMinutes: number,
  timestampColumn: 'started_at' | 'created_at' = 'started_at'
): Promise<string> => {
  const testId = crypto.randomUUID();
  const age = `NOW() - ('${ageMinutes} minutes')::INTERVAL`;
  const extraCol = timestampColumn === 'started_at' ? `, started_at` : '';
  const extraVal = timestampColumn === 'started_at' ? `, ${age}` : '';
  await pool.query(
    `INSERT INTO test_results (test_id, type, target_url, status, created_at${extraCol})
     VALUES ($1, 'backend', 'http://example.com', $2, ${age}${extraVal})`,
    [testId, status]
  );
  return testId;
};

beforeAll(async () => {
  ({ pool, drop: dropDb } = await createTestDatabase());
  await createSchema(pool);
});

afterAll(async () => {
  await dropDb();
});

beforeEach(async () => {
  await pool.query('TRUNCATE live_metrics, test_results, test_scripts, webhooks, schedules, test_presets, sessions, audit_log, users CASCADE');
  mockBroadcast.mockClear();
});

describe('runStaleCleanup — running tests', () => {
  it('marks a running test failed when started_at exceeds the threshold', async () => {
    const id = await insertResult('running', 20, 'started_at'); // 20 min old, threshold = 15
    await runStaleCleanup(pool, 15, 30);
    const { rows } = await pool.query('SELECT status FROM test_results WHERE test_id = $1', [id]);
    expect(rows[0].status).toBe('failed');
  });

  it('does not touch a running test that is within the threshold', async () => {
    const id = await insertResult('running', 10, 'started_at'); // 10 min old, threshold = 15
    await runStaleCleanup(pool, 15, 30);
    const { rows } = await pool.query('SELECT status FROM test_results WHERE test_id = $1', [id]);
    expect(rows[0].status).toBe('running');
  });

  it('returns the correct runningFixed count', async () => {
    await insertResult('running', 20, 'started_at');
    await insertResult('running', 25, 'started_at');
    await insertResult('running', 10, 'started_at'); // within threshold
    const result = await runStaleCleanup(pool, 15, 30);
    expect(result.runningFixed).toBe(2);
  });

  it('sets status_message explaining the timeout', async () => {
    const id = await insertResult('running', 20, 'started_at');
    await runStaleCleanup(pool, 15, 30);
    const { rows } = await pool.query('SELECT status_message FROM test_results WHERE test_id = $1', [id]);
    expect(rows[0].status_message).toMatch(/timed out/i);
  });
});

describe('runStaleCleanup — pending tests', () => {
  it('marks a pending test failed when created_at exceeds the threshold', async () => {
    const id = await insertResult('pending', 35, 'created_at'); // 35 min old, threshold = 30
    await runStaleCleanup(pool, 15, 30);
    const { rows } = await pool.query('SELECT status FROM test_results WHERE test_id = $1', [id]);
    expect(rows[0].status).toBe('failed');
  });

  it('does not touch a pending test that is within the threshold', async () => {
    const id = await insertResult('pending', 20, 'created_at'); // 20 min old, threshold = 30
    await runStaleCleanup(pool, 15, 30);
    const { rows } = await pool.query('SELECT status FROM test_results WHERE test_id = $1', [id]);
    expect(rows[0].status).toBe('pending');
  });

  it('returns the correct pendingFixed count', async () => {
    await insertResult('pending', 40, 'created_at');
    await insertResult('pending', 20, 'created_at'); // within threshold
    const result = await runStaleCleanup(pool, 15, 30);
    expect(result.pendingFixed).toBe(1);
  });

  it('sets status_message explaining the timeout', async () => {
    const id = await insertResult('pending', 40, 'created_at');
    await runStaleCleanup(pool, 15, 30);
    const { rows } = await pool.query('SELECT status_message FROM test_results WHERE test_id = $1', [id]);
    expect(rows[0].status_message).toMatch(/timed out/i);
  });
});

describe('runStaleCleanup — non-target statuses', () => {
  it('does not touch completed tests regardless of age', async () => {
    const id = await insertResult('completed', 120, 'started_at');
    await runStaleCleanup(pool, 15, 30);
    const { rows } = await pool.query('SELECT status FROM test_results WHERE test_id = $1', [id]);
    expect(rows[0].status).toBe('completed');
  });

  it('does not touch already-failed tests', async () => {
    const id = await insertResult('failed', 120, 'started_at');
    await runStaleCleanup(pool, 15, 30);
    const { rows } = await pool.query('SELECT status FROM test_results WHERE test_id = $1', [id]);
    expect(rows[0].status).toBe('failed');
  });

  it('returns zeroes when nothing is stale', async () => {
    await insertResult('running', 5, 'started_at');
    await insertResult('pending', 10, 'created_at');
    const result = await runStaleCleanup(pool, 15, 30);
    expect(result.runningFixed).toBe(0);
    expect(result.pendingFixed).toBe(0);
    expect(result.liveMetricsDeleted).toBe(0);
    expect(result.testResultsDeleted).toBe(0);
  });

  it('returns zeroes when DB is empty', async () => {
    const result = await runStaleCleanup(pool, 15, 30);
    expect(result.runningFixed).toBe(0);
    expect(result.pendingFixed).toBe(0);
    expect(result.liveMetricsDeleted).toBe(0);
    expect(result.testResultsDeleted).toBe(0);
  });
});

describe('runStaleCleanup — WebSocket broadcasts', () => {
  it('broadcasts test:status and tests:changed when a stale running test is marked failed', async () => {
    const id = await insertResult('running', 20, 'started_at');
    await runStaleCleanup(pool, 15, 30);

    expect(mockBroadcast).toHaveBeenCalledWith({ type: 'test:status', testId: id, status: 'failed', perfStatus: null });
    expect(mockBroadcast).toHaveBeenCalledWith({ type: 'tests:changed' });
  });

  it('broadcasts test:status and tests:changed when a stale pending test is marked failed', async () => {
    const id = await insertResult('pending', 40, 'created_at');
    await runStaleCleanup(pool, 15, 30);

    expect(mockBroadcast).toHaveBeenCalledWith({ type: 'test:status', testId: id, status: 'failed', perfStatus: null });
    expect(mockBroadcast).toHaveBeenCalledWith({ type: 'tests:changed' });
  });

  it('broadcasts one test:status per stale test plus a single tests:changed', async () => {
    const id1 = await insertResult('running', 20, 'started_at');
    const id2 = await insertResult('pending', 40, 'created_at');
    await runStaleCleanup(pool, 15, 30);

    const statusEvents = mockBroadcast.mock.calls.filter(([e]) => e.type === 'test:status');
    const changedEvents = mockBroadcast.mock.calls.filter(([e]) => e.type === 'tests:changed');
    expect(statusEvents.map(([e]) => e.testId).sort()).toEqual([id1, id2].sort());
    expect(changedEvents).toHaveLength(1);
  });

  it('does not broadcast when nothing is stale', async () => {
    await insertResult('running', 5, 'started_at');
    await insertResult('pending', 10, 'created_at');
    await runStaleCleanup(pool, 15, 30);

    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

describe('runStaleCleanup — live_metrics retention', () => {
  it('deletes live_metrics rows older than LIVE_METRICS_RETENTION_DAYS', async () => {
    const testId = await insertResult('completed', 0, 'created_at');
    // Insert an old live_metrics row (32 days old) and a recent one
    await pool.query(
      `INSERT INTO live_metrics (test_id, timestamp, vus, rps, avg_response_time, error_rate)
       VALUES ($1, NOW() - INTERVAL '32 days', 0, 0, 0, 0)`,
      [testId]
    );
    await pool.query(
      `INSERT INTO live_metrics (test_id, timestamp, vus, rps, avg_response_time, error_rate)
       VALUES ($1, NOW() - INTERVAL '1 day', 0, 0, 0, 0)`,
      [testId]
    );

    const result = await runStaleCleanup(pool, 15, 30);

    expect(result.liveMetricsDeleted).toBe(1);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS cnt FROM live_metrics WHERE test_id = $1', [testId]);
    expect(rows[0].cnt).toBe(1); // only the recent row remains
  });
});

describe('runStaleCleanup — test_results retention (GDPR)', () => {
  it('does not delete old test_results when TEST_RESULTS_RETENTION_DAYS is unset (default)', async () => {
    const id = await insertResult('completed', 0, 'created_at');
    await pool.query(`UPDATE test_results SET created_at = NOW() - INTERVAL '400 days' WHERE test_id = $1`, [id]);

    const result = await runStaleCleanup(pool, 15, 30);

    expect(result.testResultsDeleted).toBe(0);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS cnt FROM test_results WHERE test_id = $1', [id]);
    expect(rows[0].cnt).toBe(1);
  });

  it('purges test_results (and associated live_metrics) older than TEST_RESULTS_RETENTION_DAYS when set', async () => {
    vi.stubEnv('TEST_RESULTS_RETENTION_DAYS', '90');
    vi.resetModules();
    const { runStaleCleanup: runStaleCleanupWithRetention } = await import('../cleanup');

    const oldId = await insertResult('completed', 0, 'created_at');
    await pool.query(`UPDATE test_results SET created_at = NOW() - INTERVAL '100 days' WHERE test_id = $1`, [oldId]);
    await pool.query(
      `INSERT INTO live_metrics (test_id, timestamp, vus, rps, avg_response_time, error_rate) VALUES ($1, NOW(), 0, 0, 0, 0)`,
      [oldId]
    );
    const recentId = await insertResult('completed', 0, 'created_at');

    const result = await runStaleCleanupWithRetention(pool, 15, 30);

    expect(result.testResultsDeleted).toBe(1);
    const { rows: remaining } = await pool.query('SELECT test_id FROM test_results');
    expect(remaining.map((r: { test_id: string }) => r.test_id)).toEqual([recentId]);
    const { rows: liveRows } = await pool.query('SELECT COUNT(*)::int AS cnt FROM live_metrics WHERE test_id = $1', [oldId]);
    expect(liveRows[0].cnt).toBe(0);

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

describe('runStaleCleanup — sessions purge', () => {
  it('deletes expired sessions but keeps valid ones', async () => {
    const { rows: userRows } = await pool.query(
      `INSERT INTO users (email, password_hash) VALUES ('stale-session@example.com', 'hash') RETURNING id`
    );
    const userId = userRows[0].id;
    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, 'expired-token', NOW() - INTERVAL '1 hour')`,
      [userId]
    );
    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, 'valid-token', NOW() + INTERVAL '1 hour')`,
      [userId]
    );

    const result = await runStaleCleanup(pool, 15, 30);

    expect(result.sessionsDeleted).toBe(1);
    const { rows } = await pool.query('SELECT token_hash FROM sessions WHERE user_id = $1', [userId]);
    expect(rows.map((r: { token_hash: string }) => r.token_hash)).toEqual(['valid-token']);
  });

  it('deletes revoked sessions regardless of expiry', async () => {
    const { rows: userRows } = await pool.query(
      `INSERT INTO users (email, password_hash) VALUES ('revoked-session@example.com', 'hash') RETURNING id`
    );
    const userId = userRows[0].id;
    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at, revoked_at) VALUES ($1, 'revoked-token', NOW() + INTERVAL '1 hour', NOW())`,
      [userId]
    );

    const result = await runStaleCleanup(pool, 15, 30);

    expect(result.sessionsDeleted).toBe(1);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS cnt FROM sessions WHERE user_id = $1', [userId]);
    expect(rows[0].cnt).toBe(0);
  });
});

describe('runStaleCleanup — audit_log retention', () => {
  it('purges audit_log rows older than AUDIT_LOG_RETENTION_DAYS (default 180)', async () => {
    await pool.query(
      `INSERT INTO audit_log (action, resource_type, created_at) VALUES ('delete', 'script', NOW() - INTERVAL '200 days')`
    );
    await pool.query(
      `INSERT INTO audit_log (action, resource_type, created_at) VALUES ('delete', 'script', NOW() - INTERVAL '1 day')`
    );

    const result = await runStaleCleanup(pool, 15, 30);

    expect(result.auditLogDeleted).toBe(1);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS cnt FROM audit_log');
    expect(rows[0].cnt).toBe(1);
  });

  it('does not purge audit_log when AUDIT_LOG_RETENTION_DAYS is set to 0', async () => {
    vi.stubEnv('AUDIT_LOG_RETENTION_DAYS', '0');
    vi.resetModules();
    const { runStaleCleanup: runStaleCleanupNoAuditRetention } = await import('../cleanup');

    await pool.query(
      `INSERT INTO audit_log (action, resource_type, created_at) VALUES ('delete', 'script', NOW() - INTERVAL '400 days')`
    );

    const result = await runStaleCleanupNoAuditRetention(pool, 15, 30);

    expect(result.auditLogDeleted).toBe(0);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS cnt FROM audit_log');
    expect(rows[0].cnt).toBe(1);

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

// ─── startStaleCleanup ────────────────────────────────────────────────────────
// Uses fake timers + a mock pool so no PostgreSQL container is needed.

describe('startStaleCleanup', () => {
  let mockPool: { query: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    mockPool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not call runStaleCleanup immediately on start', () => {
    startStaleCleanup(mockPool as unknown as Pool, 15, 30);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('calls runStaleCleanup after 60 seconds', async () => {
    startStaleCleanup(mockPool as unknown as Pool, 15, 30);
    await vi.advanceTimersByTimeAsync(60_000);
    // runStaleCleanup issues 5 queries: running UPDATE, pending UPDATE, live_metrics DELETE,
    // sessions DELETE, audit_log DELETE (test_results DELETE is skipped — retention disabled by default)
    expect(mockPool.query).toHaveBeenCalledTimes(5);
  });

  it('fires repeatedly on every subsequent 60-second tick', async () => {
    startStaleCleanup(mockPool as unknown as Pool, 15, 30);
    await vi.advanceTimersByTimeAsync(180_000); // 3 × 60 s
    expect(mockPool.query).toHaveBeenCalledTimes(15); // 3 fires × 5 queries
  });

  it('does not propagate errors when runStaleCleanup rejects', async () => {
    mockPool.query.mockRejectedValue(new Error('DB connection lost'));
    startStaleCleanup(mockPool as unknown as Pool, 15, 30);
    // The interval catches errors internally; advancing time should not throw
    await expect(vi.advanceTimersByTimeAsync(60_000)).resolves.not.toThrow();
  });
});
