import { Pool } from 'pg';
import { readFileSync } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

const INFO_PATH = path.join(__dirname, '.shared-pg.json');

function getBaseUri(): string {
  const raw = readFileSync(INFO_PATH, 'utf-8');
  return (JSON.parse(raw) as { uri: string }).uri;
}

function withDatabase(uri: string, dbName: string): string {
  const url = new URL(uri);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/** Connection URI for the shared container's default database (admin connection only). */
export const getSharedConnectionUri = getBaseUri;

/**
 * Creates a fresh, isolated database on the shared Testcontainers PostgreSQL
 * instance and returns a Pool connected to it, plus its own connection URI and
 * a `drop()` cleanup function. Each test file gets its own database (full
 * isolation for concurrent test files) while sharing one underlying container.
 */
export async function createTestDatabase(): Promise<{ pool: Pool; uri: string; drop: () => Promise<void> }> {
  const baseUri = getBaseUri();
  const dbName = `test_${randomBytes(8).toString('hex')}`;

  const admin = new Pool({ connectionString: baseUri });
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const uri = withDatabase(baseUri, dbName);
  const pool = new Pool({ connectionString: uri });

  const drop = async (): Promise<void> => {
    await pool.end();
    const adminPool = new Pool({ connectionString: baseUri });
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await adminPool.end();
  };

  return { pool, uri, drop };
}

/**
 * Runs a TRUNCATE (or any statement) with a few retries on Postgres deadlock
 * (40P01) — every test file's beforeEach truncates a fixed, multi-table list,
 * but a still-in-flight fire-and-forget write from the previous test (e.g.
 * audit logging, webhook firing — several routes intentionally don't await
 * these) can hold a lock on one of those same tables when the next TRUNCATE
 * starts, and a multi-table TRUNCATE's lock acquisition order can then form a
 * genuine circular wait with that lingering transaction. Each file has its
 * own isolated database (see createTestDatabase above), so this is purely an
 * intra-file timing race, not cross-file contention — a short retry is the
 * standard mitigation Postgres itself recommends for 40P01, since the losing
 * transaction is simply rolled back and safe to immediately retry.
 */
export async function truncateAll(pool: Pool, sql: string, maxAttempts = 3): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query(sql);
      return;
    } catch (err) {
      const isDeadlock = (err as { code?: string }).code === '40P01';
      if (!isDeadlock || attempt === maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}
