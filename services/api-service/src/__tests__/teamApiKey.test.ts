import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { createHash, randomBytes } from 'crypto';
import { FastifyInstance } from 'fastify';

vi.mock('../queue', () => ({
  publishTest: vi.fn(),
  publishCancel: vi.fn(),
  isQueueConnected: vi.fn().mockReturnValue(true),
  connectQueue: vi.fn().mockResolvedValue(undefined),
  getWorkerConsumerCount: vi.fn().mockResolvedValue(1),
}));

vi.mock('../quotas', () => ({
  checkTestQuota: vi.fn().mockResolvedValue(null),
}));

vi.mock('../scripts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scripts')>();
  return {
    ...actual,
    findExistingScript: vi.fn().mockResolvedValue(null),
    checkDbHealth: vi.fn().mockResolvedValue(undefined),
    incrementUsedCount: vi.fn().mockResolvedValue(undefined),
  };
});

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: FastifyInstance;
let appPool: Pool;
let mockFetch: ReturnType<typeof vi.fn>;
let mockPublishTest: ReturnType<typeof vi.fn>;

const hashApiKey = (key: string): string => createHash('sha256').update(key).digest('hex');

const createSchema = async (p: Pool): Promise<void> => {
  await p.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await p.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name       TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS team_api_keys (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      team_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      key_hash     TEXT NOT NULL UNIQUE,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
      revoked_at   TIMESTAMPTZ
    )
  `);
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  await createSchema(pool);

  const { buildApp } = await import('../index');
  const queueMod = await import('../queue');
  const scriptsMod = await import('../scripts');
  app = await buildApp();
  appPool = scriptsMod.pool;

  mockPublishTest = vi.mocked(queueMod.publishTest);
  mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal('fetch', mockFetch);
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  await appPool.end();
  await pool.end();
  await container.stop();
  delete process.env.DATABASE_URL;
});

beforeEach(async () => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  await pool.query('TRUNCATE team_api_keys, projects CASCADE');
});

const validBody = {
  type: 'backend',
  targetUrl: 'http://example.com',
  description: 'smoke test',
  options: { vus: 5, duration: '30s' },
};

describe('per-team API key auth (api-service)', () => {
  it('scopes POST /tests to the team owning a valid x-api-key', async () => {
    const teamResult = await pool.query<{ id: string }>(`INSERT INTO projects (name) VALUES ('team-with-key') RETURNING id`);
    const teamId = teamResult.rows[0].id;

    const rawKey = randomBytes(24).toString('hex');
    await pool.query(
      `INSERT INTO team_api_keys (team_id, name, key_hash) VALUES ($1, 'CI key', $2)`,
      [teamId, hashApiKey(rawKey)]
    );

    const res = await app.inject({ method: 'POST', url: '/tests', payload: validBody, headers: { 'x-api-key': rawKey } });
    expect(res.statusCode).toBe(200);
    expect(mockPublishTest).toHaveBeenCalledWith(expect.objectContaining({ projectId: teamId }), false);

    // last_used_at is updated fire-and-forget; poll briefly for it to land.
    await vi.waitFor(async () => {
      const { rows } = await pool.query<{ last_used_at: Date | null }>(
        `SELECT last_used_at FROM team_api_keys WHERE team_id = $1`, [teamId]
      );
      expect(rows[0].last_used_at).not.toBeNull();
    });
  });

  it('rejects a revoked team key', async () => {
    const teamResult = await pool.query<{ id: string }>(`INSERT INTO projects (name) VALUES ('team-revoked-key') RETURNING id`);
    const teamId = teamResult.rows[0].id;

    const rawKey = randomBytes(24).toString('hex');
    await pool.query(
      `INSERT INTO team_api_keys (team_id, name, key_hash, revoked_at) VALUES ($1, 'revoked', $2, NOW())`,
      [teamId, hashApiKey(rawKey)]
    );

    const res = await app.inject({ method: 'POST', url: '/tests', payload: validBody, headers: { 'x-api-key': rawKey } });
    // No SESSION_SECRET / API_KEYS configured in this test, so an unrecognized key falls through to dev mode (unauthenticated, no projectId).
    expect(res.statusCode).toBe(200);
    expect(mockPublishTest).toHaveBeenCalledWith(expect.objectContaining({ projectId: undefined }), false);
  });

  it('rejects an unknown team key the same way (no projectId set)', async () => {
    const res = await app.inject({ method: 'POST', url: '/tests', payload: validBody, headers: { 'x-api-key': 'not-a-real-key' } });
    expect(res.statusCode).toBe(200);
    expect(mockPublishTest).toHaveBeenCalledWith(expect.objectContaining({ projectId: undefined }), false);
  });
});
