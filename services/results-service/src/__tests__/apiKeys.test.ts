import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.AUTH_RATE_LIMIT_MAX;
  delete process.env.SESSION_SECRET;
  await app.close();
  await dropDb();
});

beforeEach(async () => {
  await truncateAll(pool, 'TRUNCATE test_results, test_scripts, webhooks, schedules, test_presets, log_sources, sessions, team_api_keys, org_members, organizations, team_members, users, projects CASCADE');
});

// ─── POST /teams/:id/api-keys ─────────────────────────────────────────────────

describe('POST /teams/:id/api-keys', () => {
  it('admin can generate a key and the raw key is returned only once', async () => {
    const admin = await registerUser('admin1@example.com', 'apikey-team1');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;

    const res = await app.inject({ method: 'POST', url: `/teams/${teamId}/api-keys`, payload: { name: 'CI key' }, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('CI key');
    expect(typeof body.key).toBe('string');
    expect(body.key.length).toBeGreaterThan(20);

    const list = await app.inject({ method: 'GET', url: `/teams/${teamId}/api-keys`, headers: { cookie: adminCookie } });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).not.toHaveProperty('key');
    expect(list.json()[0].name).toBe('CI key');
    expect(list.json()[0].revoked).toBe(false);
  });

  it('returns 400 when name is missing', async () => {
    const admin = await registerUser('admin2@example.com', 'apikey-team2');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;

    const res = await app.inject({ method: 'POST', url: `/teams/${teamId}/api-keys`, payload: {}, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 when a non-admin member tries to generate a key', async () => {
    const admin = await registerUser('admin3@example.com', 'apikey-team3');
    const teamId = admin.json().currentTeamId as string;

    const memberReg = await registerUser('member3@example.com', 'member3-own-team');
    const memberId = memberReg.json().id as string;
    await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, [teamId, memberId]);
    const switched = await app.inject({ method: 'POST', url: '/auth/switch-team', payload: { teamId }, headers: { cookie: sessionCookie(memberReg) } });

    const res = await app.inject({ method: 'POST', url: `/teams/${teamId}/api-keys`, payload: { name: 'sneaky' }, headers: { cookie: sessionCookie(switched) } });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 when targeting a team the caller is not in', async () => {
    const admin = await registerUser('admin4@example.com', 'apikey-team4');
    const adminCookie = sessionCookie(admin);
    const other = await registerUser('other4@example.com', 'apikey-team4-other');
    const otherTeamId = other.json().currentTeamId as string;

    const res = await app.inject({ method: 'POST', url: `/teams/${otherTeamId}/api-keys`, payload: { name: 'cross-team' }, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(403);
  });
});

// ─── DELETE /teams/:id/api-keys/:keyId ────────────────────────────────────────

describe('DELETE /teams/:id/api-keys/:keyId', () => {
  it('admin can revoke a key', async () => {
    const admin = await registerUser('admin5@example.com', 'apikey-team5');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;

    const created = await app.inject({ method: 'POST', url: `/teams/${teamId}/api-keys`, payload: { name: 'to-revoke' }, headers: { cookie: adminCookie } });
    const keyId = created.json().id as string;

    const res = await app.inject({ method: 'DELETE', url: `/teams/${teamId}/api-keys/${keyId}`, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: `/teams/${teamId}/api-keys`, headers: { cookie: adminCookie } });
    expect(list.json()[0].revoked).toBe(true);
  });

  it('returns 404 for an unknown key id', async () => {
    const admin = await registerUser('admin6@example.com', 'apikey-team6');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;

    const res = await app.inject({ method: 'DELETE', url: `/teams/${teamId}/api-keys/00000000-0000-0000-0000-000000000000`, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(404);
  });
});

// ─── Auth middleware: team API keys ───────────────────────────────────────────

describe('team API key authentication', () => {
  it('a valid team key scopes the request to that team without a session cookie', async () => {
    const admin = await registerUser('admin7@example.com', 'apikey-team7');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;

    const created = await app.inject({ method: 'POST', url: `/teams/${teamId}/api-keys`, payload: { name: 'scoped-key' }, headers: { cookie: adminCookie } });
    const rawKey = created.json().key as string;

    // Create a webhook scoped to this team via the session, then fetch it via the API key alone.
    await app.inject({ method: 'POST', url: '/webhooks', payload: { url: 'https://hooks.example.com/a' }, headers: { cookie: adminCookie } });

    const res = await app.inject({ method: 'GET', url: '/webhooks', headers: { 'x-api-key': rawKey } });
    expect(res.statusCode).toBe(200);
    expect(res.json().webhooks).toHaveLength(1);
    expect(res.json().webhooks[0].url).toBe('https://hooks.example.com/a');
  });

  it('rejects a revoked team key', async () => {
    const admin = await registerUser('admin8@example.com', 'apikey-team8');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;

    const created = await app.inject({ method: 'POST', url: `/teams/${teamId}/api-keys`, payload: { name: 'revoked-key' }, headers: { cookie: adminCookie } });
    const rawKey = created.json().key as string;
    const keyId = created.json().id as string;

    await app.inject({ method: 'DELETE', url: `/teams/${teamId}/api-keys/${keyId}`, headers: { cookie: adminCookie } });

    const res = await app.inject({ method: 'GET', url: '/webhooks', headers: { 'x-api-key': rawKey } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an unknown key', async () => {
    const res = await app.inject({ method: 'GET', url: '/webhooks', headers: { 'x-api-key': 'not-a-real-key' } });
    expect(res.statusCode).toBe(401);
  });
});
