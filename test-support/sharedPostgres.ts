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
