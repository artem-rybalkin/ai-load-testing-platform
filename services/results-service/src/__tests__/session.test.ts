import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { createSchema } from '../db';
import { createSession, getSession, revokeSession, switchSessionTeam } from '../session';

let container: StartedPostgreSqlContainer;
let pool: Pool;

let userId: string;
let teamAId: string;
let teamBId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await createSchema(pool);
}, 60_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE sessions, team_members, users, projects CASCADE');

  const userResult = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name) VALUES ('alice@example.com', 'hash', 'Alice') RETURNING id`
  );
  userId = userResult.rows[0].id;

  const teamA = await pool.query<{ id: string }>(`INSERT INTO projects (name) VALUES ('team-a') RETURNING id`);
  teamAId = teamA.rows[0].id;

  const teamB = await pool.query<{ id: string }>(`INSERT INTO projects (name) VALUES ('team-b') RETURNING id`);
  teamBId = teamB.rows[0].id;

  await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'admin')`, [teamAId, userId]);
  await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, [teamBId, userId]);
});

describe('createSession / getSession', () => {
  it('creates a session and returns a raw token', async () => {
    const token = await createSession(pool, userId, teamAId);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  it('looks up a valid session by token', async () => {
    const token = await createSession(pool, userId, teamAId);
    const session = await getSession(pool, token);
    expect(session).not.toBeNull();
    expect(session?.userId).toBe(userId);
    expect(session?.teamId).toBe(teamAId);
    expect(session?.expiresAt).toBeInstanceOf(Date);
  });

  it('stores only a hash of the token, not the raw token', async () => {
    const token = await createSession(pool, userId, teamAId);
    const { rows } = await pool.query('SELECT token_hash FROM sessions WHERE user_id = $1', [userId]);
    expect(rows[0].token_hash).not.toBe(token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('supports a null teamId', async () => {
    const token = await createSession(pool, userId, null);
    const session = await getSession(pool, token);
    expect(session?.teamId).toBeNull();
  });

  it('returns null for an unknown token', async () => {
    const session = await getSession(pool, 'not-a-real-token');
    expect(session).toBeNull();
  });

  it('returns null when token is undefined', async () => {
    const session = await getSession(pool, undefined);
    expect(session).toBeNull();
  });

  it('returns null for an expired session', async () => {
    const token = await createSession(pool, userId, teamAId);
    await pool.query(
      `UPDATE sessions SET expires_at = NOW() - INTERVAL '1 day' WHERE user_id = $1`,
      [userId]
    );
    const session = await getSession(pool, token);
    expect(session).toBeNull();
  });
});

describe('revokeSession', () => {
  it('makes a previously valid session invalid', async () => {
    const token = await createSession(pool, userId, teamAId);
    expect(await getSession(pool, token)).not.toBeNull();

    await revokeSession(pool, token);
    expect(await getSession(pool, token)).toBeNull();
  });

  it('is a no-op for an undefined token', async () => {
    await expect(revokeSession(pool, undefined)).resolves.toBeUndefined();
  });
});

describe('switchSessionTeam', () => {
  it('updates the current team for a session', async () => {
    const token = await createSession(pool, userId, teamAId);
    await switchSessionTeam(pool, token, teamBId);
    const session = await getSession(pool, token);
    expect(session?.teamId).toBe(teamBId);
  });

  it('is a no-op for an undefined token', async () => {
    await expect(switchSessionTeam(pool, undefined, teamBId)).resolves.toBeUndefined();
  });
});
