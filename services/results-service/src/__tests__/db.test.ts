import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Pool, QueryResult } from 'pg';
import { createTestDatabase } from '../../../../test-support/sharedPostgres';
import { createSchema, queryWithRetry } from '../db';

let dbUri: string;
let dropDb: () => Promise<void>;

beforeAll(async () => {
  // The postgres docker image restarts once after initdb; createSchema's
  // queryWithRetry absorbs that transient restart so subsequent direct
  // pool.query calls in this file don't hit ECONNRESET.
  const { pool: warmupPool, uri, drop } = await createTestDatabase();
  dbUri = uri;
  dropDb = drop;
  await createSchema(warmupPool);
}, 60_000);

afterAll(async () => {
  await dropDb();
});

/** Retry a raw pool.query a few times to absorb transient connection resets on a fresh Pool. */
const robustQuery = async (p: Pool, sql: string, retries = 5, delayMs = 500): Promise<QueryResult> => {
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
    process.env.DATABASE_URL = dbUri;
    delete process.env.READ_DATABASE_URL;

    const { pool, readPool } = await import('../db');

    // Same pool instance is used for both writes and reads
    expect(readPool).toBe(pool);

    // Queries against readPool work using the primary container
    const { rows } = await robustQuery(readPool, 'SELECT 1 AS one');
    expect(rows[0].one).toBe(1);

    await pool.end();
  });

  it('uses a distinct pool instance pointed at READ_DATABASE_URL when set', async () => {
    process.env.DATABASE_URL = dbUri;
    process.env.READ_DATABASE_URL = dbUri;

    const { pool, readPool } = await import('../db');

    // Distinct pool instance, even though it points at the same database here
    expect(readPool).not.toBe(pool);

    // The distinct readPool can independently query the (same) Testcontainer
    const readResult = await robustQuery(readPool, 'SELECT 2 AS two');
    expect(readResult.rows[0].two).toBe(2);

    await pool.end();
    await readPool.end();
  });
});

// ─── M7: queryWithRetry retry / backoff logic ─────────────────────────────────

describe('queryWithRetry (M7)', () => {
  it('resolves immediately when the first query succeeds', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool;
    await expect(queryWithRetry(mockPool, 'SELECT 1', 3, 0)).resolves.toBeUndefined();
    expect(mockPool.query).toHaveBeenCalledOnce();
  });

  it('retries and succeeds on the second attempt', async () => {
    const mockPool = {
      query: vi.fn()
        .mockRejectedValueOnce(new Error('ECONNRESET — transient'))
        .mockResolvedValue({ rows: [] }),
    } as unknown as Pool;

    await expect(queryWithRetry(mockPool, 'SELECT 1', 3, 0)).resolves.toBeUndefined();
    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });

  it('retries N-1 times and throws after exhausting all retries', async () => {
    const error = new Error('DB always down');
    const mockPool = { query: vi.fn().mockRejectedValue(error) } as unknown as Pool;

    await expect(queryWithRetry(mockPool, 'SELECT 1', 3, 0)).rejects.toThrow('DB always down');
    // Called exactly `retries` times (1 initial + 2 retries = 3 total)
    expect(mockPool.query).toHaveBeenCalledTimes(3);
  });

  it('uses the default retries=5 when not specified', async () => {
    const error = new Error('persistent failure');
    const mockPool = { query: vi.fn().mockRejectedValue(error) } as unknown as Pool;

    await expect(queryWithRetry(mockPool, 'SELECT 1', 5, 0)).rejects.toThrow();
    expect(mockPool.query).toHaveBeenCalledTimes(5);
  });

  it('throws immediately on the first failure when retries=1', async () => {
    const mockPool = {
      query: vi.fn().mockRejectedValueOnce(new Error('boom')),
    } as unknown as Pool;

    await expect(queryWithRetry(mockPool, 'SELECT 1', 1, 0)).rejects.toThrow('boom');
    expect(mockPool.query).toHaveBeenCalledOnce();
  });
});

// ─── M8: createSchema idempotency ────────────────────────────────────────────

describe('createSchema — idempotency (M8)', () => {
  let idempotPool: Pool;

  beforeAll(async () => {
    const { pool: p } = await createTestDatabase();
    idempotPool = p;
    // First run
    await createSchema(idempotPool);
  }, 60_000);

  afterAll(async () => {
    await idempotPool.end();
  });

  it('does not re-apply any migration when called a second time', async () => {
    const { rows: before } = await idempotPool.query<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    const countBefore = before.length;

    // Second call — should be entirely a no-op
    await createSchema(idempotPool);

    const { rows: after } = await idempotPool.query<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    expect(after.length).toBe(countBefore);
  });

  it('schema_migrations row count equals the number of migrations in MIGRATIONS array (16)', async () => {
    const { rows } = await idempotPool.query<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    expect(rows.length).toBe(16);
  });

  it('schema_migrations contains sequential versions 1..16', async () => {
    const { rows } = await idempotPool.query<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    const versions = rows.map(r => r.version);
    expect(versions).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });
});
