import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase, truncateAll } from '../../../../test-support/sharedPostgres';
import { createHash, randomBytes } from 'crypto';
import { getApiSession } from '../session';

let pool: Pool;
let dropDb: () => Promise<void>;

let userId: string;
let teamId: string;

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
    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name          TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS team_members (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      team_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member','viewer')),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(team_id, user_id)
    )
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  TEXT NOT NULL UNIQUE,
      team_id     UUID REFERENCES projects(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      expires_at  TIMESTAMPTZ NOT NULL,
      revoked_at  TIMESTAMPTZ
    )
  `);
};

const insertSession = async (
  p: Pool,
  uId: string,
  tId: string | null,
  opts: { revoked?: boolean; expired?: boolean } = {}
): Promise<string> => {
  const token = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = opts.expired ? `NOW() - INTERVAL '1 day'` : `NOW() + INTERVAL '30 days'`;
  await p.query(
    `INSERT INTO sessions (user_id, token_hash, team_id, expires_at, revoked_at)
     VALUES ($1, $2, $3, ${expiresAt}, ${opts.revoked ? 'NOW()' : 'NULL'})`,
    [uId, tokenHash, tId]
  );
  return token;
};

beforeAll(async () => {
  ({ pool, drop: dropDb } = await createTestDatabase());
  await createSchema(pool);
}, 120_000);

afterAll(async () => {
  await dropDb();
});

beforeEach(async () => {
  await truncateAll(pool, 'TRUNCATE sessions, team_members, users, projects CASCADE');

  const userResult = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name) VALUES ('alice@example.com', 'hash', 'Alice') RETURNING id`
  );
  userId = userResult.rows[0]!.id; // INSERT ... RETURNING always returns exactly one row

  const teamResult = await pool.query<{ id: string }>(`INSERT INTO projects (name) VALUES ('team-a') RETURNING id`);
  teamId = teamResult.rows[0]!.id; // INSERT ... RETURNING always returns exactly one row

  await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'admin')`, [teamId, userId]);
});

describe('getApiSession', () => {
  it('returns null when token is undefined', async () => {
    expect(await getApiSession(pool, undefined)).toBeNull();
  });

  it('returns null for an unknown token', async () => {
    expect(await getApiSession(pool, 'not-a-real-token')).toBeNull();
  });

  it('returns projectId and role for a valid session', async () => {
    const token = await insertSession(pool, userId, teamId);
    const session = await getApiSession(pool, token);
    expect(session).toEqual({ projectId: teamId, role: 'admin' });
  });

  it('returns null projectId/role when session has no current team', async () => {
    const token = await insertSession(pool, userId, null);
    const session = await getApiSession(pool, token);
    expect(session).toEqual({ projectId: null, role: null });
  });

  it('returns null for a revoked session', async () => {
    const token = await insertSession(pool, userId, teamId, { revoked: true });
    expect(await getApiSession(pool, token)).toBeNull();
  });

  it('returns null for an expired session', async () => {
    const token = await insertSession(pool, userId, teamId, { expired: true });
    expect(await getApiSession(pool, token)).toBeNull();
  });

  it('reflects the caller role from team_members', async () => {
    const memberResult = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name) VALUES ('bob@example.com', 'hash', 'Bob') RETURNING id`
    );
    const memberId = memberResult.rows[0]!.id; // INSERT ... RETURNING always returns exactly one row
    await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'viewer')`, [teamId, memberId]);

    const token = await insertSession(pool, memberId, teamId);
    const session = await getApiSession(pool, token);
    expect(session).toEqual({ projectId: teamId, role: 'viewer' });
  });
});
