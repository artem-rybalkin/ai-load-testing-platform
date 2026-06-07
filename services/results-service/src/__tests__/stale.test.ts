import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { runStaleCleanup, startStaleCleanup } from '../cleanup';
import { createSchema } from '../db';

let container: StartedPostgreSqlContainer;
let pool: Pool;

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
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await createSchema(pool);
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE live_metrics, test_results, test_scripts, webhooks, schedules, test_presets CASCADE');
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
  });

  it('returns zeroes when DB is empty', async () => {
    const result = await runStaleCleanup(pool, 15, 30);
    expect(result.runningFixed).toBe(0);
    expect(result.pendingFixed).toBe(0);
    expect(result.liveMetricsDeleted).toBe(0);
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
    // runStaleCleanup issues 3 queries: running UPDATE, pending UPDATE, live_metrics DELETE
    expect(mockPool.query).toHaveBeenCalledTimes(3);
  });

  it('fires repeatedly on every subsequent 60-second tick', async () => {
    startStaleCleanup(mockPool as unknown as Pool, 15, 30);
    await vi.advanceTimersByTimeAsync(180_000); // 3 × 60 s
    expect(mockPool.query).toHaveBeenCalledTimes(9); // 3 fires × 3 queries
  });

  it('does not propagate errors when runStaleCleanup rejects', async () => {
    mockPool.query.mockRejectedValue(new Error('DB connection lost'));
    startStaleCleanup(mockPool as unknown as Pool, 15, 30);
    // The interval catches errors internally; advancing time should not throw
    await expect(vi.advanceTimersByTimeAsync(60_000)).resolves.not.toThrow();
  });
});
