import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { writeFileSync, rmSync } from 'fs';
import path from 'path';

const INFO_PATH = path.join(__dirname, '.shared-pg.json');

/**
 * Vitest globalSetup: starts a single shared PostgreSQL container for the whole
 * test run. Individual test files create their own isolated database on this
 * container (see sharedPostgres.ts) instead of each starting their own container —
 * 18+ container startups was the main source of the ~36min full-suite runtime and
 * the resulting Testcontainers/Docker resource-contention timeouts.
 */
export async function setup(): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  writeFileSync(INFO_PATH, JSON.stringify({ uri: container.getConnectionUri() }), 'utf-8');

  return async () => {
    rmSync(INFO_PATH, { force: true });
    await container.stop();
  };
}
