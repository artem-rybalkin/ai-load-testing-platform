import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { createSchema } from '../db';

let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  // The postgres docker image restarts once after initdb; createSchema's
  // queryWithRetry absorbs that transient restart so subsequent direct
  // pool.query calls in this file don't hit ECONNRESET.
  const warmupPool = new Pool({ connectionString: container.getConnectionUri() });
  await createSchema(warmupPool);
  await warmupPool.end();
});

afterAll(async () => {
  await container.stop();
});

/** Retry a query a few times to absorb transient connection resets on a fresh Pool. */
const queryWithRetry = async (p: Pool, sql: string, retries = 5, delayMs = 500) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await p.query(sql);
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
};

// ─── readPool fallback logic ───────────────────────────────────────────────
// pool/readPool are computed at module load time from env vars, so each test
// resets modules and re-imports ../db with the env var set/unset beforehand.

describe('db — readPool fallback', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('falls back to the primary pool when READ_DATABASE_URL is unset', async () => {
    process.env.DATABASE_URL = container.getConnectionUri();
    delete process.env.READ_DATABASE_URL;

    const { pool, readPool } = await import('../db');

    // Same pool instance is used for both writes and reads
    expect(readPool).toBe(pool);

    // Queries against readPool work using the primary container
    const { rows } = await queryWithRetry(readPool, 'SELECT 1 AS one');
    expect(rows[0].one).toBe(1);

    await pool.end();
  });

  it('uses a distinct pool instance pointed at READ_DATABASE_URL when set', async () => {
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.READ_DATABASE_URL = container.getConnectionUri();

    const { pool, readPool } = await import('../db');

    // Distinct pool instance, even though it points at the same database here
    expect(readPool).not.toBe(pool);

    // The distinct readPool can independently query the (same) Testcontainer
    const readResult = await queryWithRetry(readPool, 'SELECT 2 AS two');
    expect(readResult.rows[0].two).toBe(2);

    await pool.end();
    await readPool.end();
  });
});
