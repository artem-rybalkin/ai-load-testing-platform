import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { createTestDatabase, truncateAll } from '../../../../test-support/sharedPostgres';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { createSchema } from '../db';

vi.mock('../scheduler', () => ({
  reloadSchedule: vi.fn().mockResolvedValue(undefined),
  removeSchedule: vi.fn(),
  startScheduler: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../consumer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../consumer')>();
  return { ...actual, isConsumerConnected: vi.fn().mockReturnValue(true) };
});

let pool: Pool;
let dropDb: () => Promise<void>;
let app: FastifyInstance;

const SESSION_SECRET = 'test-session-secret-32-chars-min!';

const sessionCookie = (res: { headers: Record<string, unknown> }): string =>
  (res.headers['set-cookie'] as string).split(';')[0]!; // .split() always returns at least one element

const registerUser = async (email: string, teamName: string, password = 'password123'): Promise<Awaited<ReturnType<typeof app.inject>>> =>
  app.inject({
    method: 'POST', url: '/auth/register',
    payload: { email, password, teamName, name: email.split('@')[0] },
  });

beforeAll(async () => {
  ({ pool, drop: dropDb } = await createTestDatabase());
  await createSchema(pool);
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.AUTH_RATE_LIMIT_MAX = '1000';
  app = await buildApp(pool);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.SESSION_SECRET;
  delete process.env.AUTH_RATE_LIMIT_MAX;
  await app.close();
  await dropDb();
});

beforeEach(async () => {
  await truncateAll(pool, 'TRUNCATE test_results, test_scripts, webhooks, schedules, test_presets, log_sources, sessions, team_members, users, projects CASCADE');
});

// ─── POST /auth/register ──────────────────────────────────────────────────────

describe('POST /auth/register', () => {
  it('returns 400 for an invalid email', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'not-an-email', password: 'password123', teamName: 'team-x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/email/i);
  });

  it('returns 400 for a short password', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'a@example.com', password: 'short', teamName: 'team-x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/password/i);
  });

  it('returns 400 for a password over 72 bytes (bcrypt silent-truncation guard)', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'a@example.com', password: 'x'.repeat(73), teamName: 'team-x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/72 bytes/i);
  });

  it('accepts a password exactly at the 72-byte boundary', async () => {
    const res = await registerUser('boundary@example.com', 'team-boundary', 'x'.repeat(72));
    expect(res.statusCode).toBe(200);
  });

  it('returns 400 when teamName is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'a@example.com', password: 'password123' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/teamName/i);
  });

  it('creates a user, team, and admin membership; sets a session cookie', async () => {
    const res = await registerUser('alice@example.com', 'team-alpha');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.email).toBe('alice@example.com');
    expect(body.role).toBe('admin');
    expect(body.currentTeamId).toEqual(expect.any(String));
    expect(body.teams).toEqual([{ id: body.currentTeamId, name: 'team-alpha', role: 'admin' }]);

    const setCookie = res.headers['set-cookie'] as string;
    expect(setCookie).toMatch(/alt_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
  });

  it('returns 409 when the email is already registered', async () => {
    await registerUser('dupe@example.com', 'team-one');
    const res = await registerUser('dupe@example.com', 'team-two');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/email/i);
  });

  it('returns 409 when the team name is already taken', async () => {
    await registerUser('user1@example.com', 'shared-team');
    const res = await registerUser('user2@example.com', 'shared-team');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/team/i);
  });

  it('does not create a user row when team creation fails (rollback)', async () => {
    await registerUser('user1@example.com', 'shared-team');
    await registerUser('user2@example.com', 'shared-team');
    const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', ['user2@example.com']);
    expect(rows).toHaveLength(0);
  });
});

// ─── POST /auth/login ─────────────────────────────────────────────────────────

describe('POST /auth/login', () => {
  it('returns 400 when email is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { password: 'password123' } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when password is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@example.com' } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 for an unknown email', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'nope@example.com', password: 'password123' } });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for a wrong password', async () => {
    await registerUser('bob@example.com', 'team-bob');
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'bob@example.com', password: 'wrongpassword' } });
    expect(res.statusCode).toBe(401);
  });

  it('returns the session user and sets a cookie on success', async () => {
    await registerUser('carol@example.com', 'team-carol');
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'carol@example.com', password: 'password123' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.email).toBe('carol@example.com');
    expect(body.currentTeamId).toEqual(expect.any(String));
    expect(body.role).toBe('admin');
    expect(res.headers['set-cookie']).toMatch(/alt_session=/);
  });

  it('is case-insensitive on email', async () => {
    await registerUser('dave@example.com', 'team-dave');
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'DAVE@example.com', password: 'password123' } });
    expect(res.statusCode).toBe(200);
  });
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────

describe('POST /auth/logout', () => {
  it('returns 200 with success: true and clears the cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    const setCookie = res.headers['set-cookie'] as string;
    expect(setCookie).toMatch(/alt_session=;|Max-Age=0/i);
  });

  it('revokes the session so it can no longer be used', async () => {
    const reg = await registerUser('erin@example.com', 'team-erin');
    const cookie = sessionCookie(reg);

    await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });
});

// ─── GET /auth/me ─────────────────────────────────────────────────────────────

describe('GET /auth/me', () => {
  it('returns 401 when no cookie is present', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the session user for a valid cookie', async () => {
    const reg = await registerUser('frank@example.com', 'team-frank');
    const cookie = sessionCookie(reg);

    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe('frank@example.com');
    expect(res.json().role).toBe('admin');
  });

  it('returns 401 for a bogus cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: 'alt_session=not-a-real-token' } });
    expect(res.statusCode).toBe(401);
  });
});

// ─── POST /auth/switch-team ───────────────────────────────────────────────────

describe('POST /auth/switch-team', () => {
  it('switches the current team for a multi-team user', async () => {
    const reg = await registerUser('grace@example.com', 'team-grace');
    const cookie = sessionCookie(reg);
    const userId = reg.json().id as string;

    // Create a second team and add grace as a member directly
    const team2 = await pool.query<{ id: string }>(`INSERT INTO projects (name) VALUES ('team-grace-2') RETURNING id`);
    await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, [team2.rows[0]!.id, userId]);

    const res = await app.inject({ method: 'POST', url: '/auth/switch-team', payload: { teamId: team2.rows[0]!.id }, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().currentTeamId).toBe(team2.rows[0]!.id);
    expect(res.json().role).toBe('member');

    // switch-team rotates the token — a stale pre-switch cookie must stop working...
    const staleMe = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(staleMe.statusCode).toBe(401);

    // ...while the freshly rotated cookie from the switch response keeps working.
    const rotatedCookie = sessionCookie(res);
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: rotatedCookie } });
    expect(me.json().currentTeamId).toBe(team2.rows[0]!.id);
  });

  it('returns 403 when switching to a team the user is not a member of', async () => {
    const reg = await registerUser('heidi@example.com', 'team-heidi');
    const cookie = sessionCookie(reg);

    const res = await app.inject({ method: 'POST', url: '/auth/switch-team', payload: { teamId: randomUUID() }, headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });

  it('returns 400 when teamId is missing', async () => {
    const reg = await registerUser('ivan@example.com', 'team-ivan');
    const cookie = sessionCookie(reg);
    const res = await app.inject({ method: 'POST', url: '/auth/switch-team', payload: {}, headers: { cookie } });
    expect(res.statusCode).toBe(400);
  });
});

// ─── Session middleware guards protected routes ───────────────────────────────

describe('Session middleware', () => {
  it('returns 401 on GET /results when no cookie is present', async () => {
    const res = await app.inject({ method: 'GET', url: '/results' });
    expect(res.statusCode).toBe(401);
  });

  it('allows GET /health without a session cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).not.toBe(401);
  });

  it('allows POST /results/pending without a session cookie (internal path)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/results/pending',
      payload: { testId: randomUUID(), type: 'backend', targetUrl: 'http://x.com' },
    });
    expect(res.statusCode).not.toBe(401);
  });

  it('allows POST /results/:testId/cancel without a session cookie (internal path)', async () => {
    const testId = randomUUID();
    await app.inject({
      method: 'POST', url: '/results/pending',
      payload: { testId, type: 'backend', targetUrl: 'http://x.com' },
    });
    const res = await app.inject({ method: 'POST', url: `/results/${testId}/cancel` });
    expect(res.statusCode).toBe(200);
  });

  it('allows GET /results with a valid session cookie', async () => {
    const reg = await registerUser('judy@example.com', 'team-judy');
    const cookie = sessionCookie(reg);
    const res = await app.inject({ method: 'GET', url: '/results', headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });

  it('blocks a viewer from POST /webhooks (mutation) with 403', async () => {
    const admin = await registerUser('admin1@example.com', 'team-viewer-test');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;

    const viewerReg = await registerUser('viewer1@example.com', 'team-viewer1-own');
    // Move viewer1 into team-viewer-test as a viewer
    const viewerId = viewerReg.json().id as string;
    await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'viewer')`, [teamId, viewerId]);
    const switched = await app.inject({ method: 'POST', url: '/auth/switch-team', payload: { teamId }, headers: { cookie: sessionCookie(viewerReg) } });
    expect(switched.statusCode).toBe(200);
    const viewerCookie = sessionCookie(switched);

    const res = await app.inject({ method: 'POST', url: '/webhooks', payload: { url: 'http://example.com/hook' }, headers: { cookie: viewerCookie } });
    expect(res.statusCode).toBe(403);

    // sanity: admin can still post
    const adminRes = await app.inject({ method: 'POST', url: '/webhooks', payload: { url: 'http://example.com/hook' }, headers: { cookie: adminCookie } });
    expect(adminRes.statusCode).toBe(201);
  });

  it('allows a viewer to GET /results (read-only)', async () => {
    const admin = await registerUser('admin2@example.com', 'team-viewer-test2');
    const teamId = admin.json().currentTeamId as string;

    const viewerReg = await registerUser('viewer2@example.com', 'team-viewer2-own');
    const viewerId = viewerReg.json().id as string;
    await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'viewer')`, [teamId, viewerId]);
    const switched = await app.inject({ method: 'POST', url: '/auth/switch-team', payload: { teamId }, headers: { cookie: sessionCookie(viewerReg) } });

    const res = await app.inject({ method: 'GET', url: '/results', headers: { cookie: sessionCookie(switched) } });
    expect(res.statusCode).toBe(200);
  });

  it('returns 403 with "no team selected" for a session whose current team membership was removed', async () => {
    const reg = await registerUser('kim@example.com', 'team-kim');
    const cookie = sessionCookie(reg);
    const userId = reg.json().id as string;
    const teamId = reg.json().currentTeamId as string;

    // Removing the only membership leaves the session pointed at a team the user no longer belongs to
    await pool.query('DELETE FROM team_members WHERE user_id = $1 AND team_id = $2', [userId, teamId]);

    const res = await app.inject({ method: 'GET', url: '/results', headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });

  it('still allows POST /teams for a session with no current team', async () => {
    const reg = await registerUser('liam@example.com', 'team-liam');
    const cookie = sessionCookie(reg);
    const userId = reg.json().id as string;
    const teamId = reg.json().currentTeamId as string;

    await pool.query('DELETE FROM team_members WHERE user_id = $1 AND team_id = $2', [userId, teamId]);

    const res = await app.inject({ method: 'POST', url: '/teams', payload: { name: 'a-fresh-team' }, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('admin');
  });
});

// ─── Dev mode (SESSION_SECRET empty) ─────────────────────────────────────────

describe('Auth dev mode (SESSION_SECRET not set)', () => {
  let devApp: FastifyInstance;

  beforeAll(async () => {
    const origSecret = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    devApp = await buildApp(pool);
    process.env.SESSION_SECRET = origSecret;
  });

  afterAll(async () => { await devApp.close(); });

  it('POST /auth/register returns the dev user without setting a cookie', async () => {
    const res = await devApp.inject({ method: 'POST', url: '/auth/register', payload: { email: 'x@example.com', password: 'password123', teamName: 'x' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('dev');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('POST /auth/login returns the dev user without setting a cookie', async () => {
    const res = await devApp.inject({ method: 'POST', url: '/auth/login', payload: { email: 'x@example.com', password: 'password123' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('dev');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('GET /auth/me returns the dev user', async () => {
    const res = await devApp.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('dev');
    expect(res.json().role).toBe('admin');
  });

  it('GET /results is accessible without auth in dev mode', async () => {
    const res = await devApp.inject({ method: 'GET', url: '/results' });
    expect(res.statusCode).toBe(200);
  });
});

// ─── Cross-team isolation: baseline, report.pdf, live metrics ────────────────

describe('Cross-team isolation', () => {
  let cookieA: string;
  let cookieB: string;
  let testIdA: string;

  beforeEach(async () => {
    const regA = await registerUser('isolation-a@example.com', 'isolation-team-a');
    cookieA = sessionCookie(regA);
    const teamIdA = regA.json().currentTeamId as string;

    const regB = await registerUser('isolation-b@example.com', 'isolation-team-b');
    cookieB = sessionCookie(regB);

    testIdA = randomUUID();
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status, metrics, started_at, completed_at, project_id)
       VALUES ($1, 'backend', 'http://example.com', 'completed', $2, NOW() - INTERVAL '1 minute', NOW(), $3)`,
      [testIdA, JSON.stringify({ type: 'backend', requestsTotal: 100, requestsFailed: 0, avgResponseTime: 200, p50ResponseTime: 180, p95ResponseTime: 400, p99ResponseTime: 500, rps: 10 }), teamIdA]
    );
    await pool.query(
      `INSERT INTO live_metrics (test_id, timestamp, vus, rps, avg_response_time, error_rate)
       VALUES ($1, NOW(), 10, 5, 200, 0)`,
      [testIdA]
    );
  });

  it('GET /results/:testId/report.pdf returns 404 for a different team', async () => {
    const res = await app.inject({ method: 'GET', url: `/results/${testIdA}/report.pdf`, headers: { cookie: cookieB } });
    expect(res.statusCode).toBe(404);
  });

  it('GET /results/:testId/report.pdf returns 200 for the owning team', async () => {
    const res = await app.inject({ method: 'GET', url: `/results/${testIdA}/report.pdf`, headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
  });

  it('GET /results/:testId/report.csv returns 404 for a different team', async () => {
    const res = await app.inject({ method: 'GET', url: `/results/${testIdA}/report.csv`, headers: { cookie: cookieB } });
    expect(res.statusCode).toBe(404);
  });

  it('GET /results/:testId/report.csv returns 200 for the owning team', async () => {
    const res = await app.inject({ method: 'GET', url: `/results/${testIdA}/report.csv`, headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
  });

  it('GET /results/:testId/live returns no points for a different team', async () => {
    const res = await app.inject({ method: 'GET', url: `/results/${testIdA}/live`, headers: { cookie: cookieB } });
    expect(res.statusCode).toBe(200);
    expect(res.json().points).toHaveLength(0);
  });

  it('GET /results/:testId/live returns points for the owning team', async () => {
    const res = await app.inject({ method: 'GET', url: `/results/${testIdA}/live`, headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
    expect(res.json().points).toHaveLength(1);
  });

  it('POST /results/:testId/baseline returns 404 for a different team and does not set is_baseline', async () => {
    const res = await app.inject({ method: 'POST', url: `/results/${testIdA}/baseline`, headers: { cookie: cookieB } });
    expect(res.statusCode).toBe(404);
    const { rows } = await pool.query('SELECT is_baseline FROM test_results WHERE test_id = $1', [testIdA]);
    expect(rows[0].is_baseline).toBe(false);
  });

  it('POST /results/:testId/baseline succeeds for the owning team', async () => {
    const res = await app.inject({ method: 'POST', url: `/results/${testIdA}/baseline`, headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(200);
    const { rows } = await pool.query('SELECT is_baseline FROM test_results WHERE test_id = $1', [testIdA]);
    expect(rows[0].is_baseline).toBe(true);
  });

  it('DELETE /results/:testId/baseline succeeds for the owning team', async () => {
    await pool.query('UPDATE test_results SET is_baseline = TRUE WHERE test_id = $1', [testIdA]);
    const res = await app.inject({ method: 'DELETE', url: `/results/${testIdA}/baseline`, headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(204);
    const { rows } = await pool.query('SELECT is_baseline FROM test_results WHERE test_id = $1', [testIdA]);
    expect(rows[0].is_baseline).toBe(false);
  });
});
