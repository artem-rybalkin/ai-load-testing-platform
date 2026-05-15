import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { runStaleCleanup } from '../cleanup';
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
  await pool.query('TRUNCATE live_metrics, test_results, test_scripts, webhooks, schedules, test_templates CASCADE');
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
  });

  it('returns zeroes when DB is empty', async () => {
    const result = await runStaleCleanup(pool, 15, 30);
    expect(result.runningFixed).toBe(0);
    expect(result.pendingFixed).toBe(0);
  });
});
