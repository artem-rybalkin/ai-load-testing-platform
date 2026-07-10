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
  (res.headers['set-cookie'] as string).split(';')[0];

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

// ─── POST /orgs ─────────────────────────────────────────────────────────────

describe('POST /orgs', () => {
  it('creates an org and makes the requester an owner', async () => {
    const reg = await registerUser('owner@example.com', 'org-owner-team');
    const cookie = sessionCookie(reg);

    const res = await app.inject({ method: 'POST', url: '/orgs', payload: { name: 'acme-corp' }, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('owner');
    expect(res.json().name).toBe('acme-corp');

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.json().orgs).toEqual([{ id: res.json().id, name: 'acme-corp', role: 'owner' }]);
  });

  it('returns 400 when name is missing', async () => {
    const reg = await registerUser('owner2@example.com', 'org-owner-team2');
    const res = await app.inject({ method: 'POST', url: '/orgs', payload: {}, headers: { cookie: sessionCookie(reg) } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 when the org name is already taken', async () => {
    const reg = await registerUser('owner3@example.com', 'org-owner-team3');
    const cookie = sessionCookie(reg);
    await app.inject({ method: 'POST', url: '/orgs', payload: { name: 'dup-org' }, headers: { cookie } });
    const res = await app.inject({ method: 'POST', url: '/orgs', payload: { name: 'dup-org' }, headers: { cookie } });
    expect(res.statusCode).toBe(409);
  });

  it('returns 403 in dev mode (no SESSION_SECRET)', async () => {
    delete process.env.SESSION_SECRET;
    const devApp = await buildApp(pool);
    const res = await devApp.inject({ method: 'POST', url: '/orgs', payload: { name: 'dev-org' } });
    expect(res.statusCode).toBe(403);
    await devApp.close();
    process.env.SESSION_SECRET = SESSION_SECRET;
  });
});

// ─── GET /orgs/:id ────────────────────────────────────────────────────────────

describe('GET /orgs/:id', () => {
  it('returns org details with members and teams for a member', async () => {
    const reg = await registerUser('owner4@example.com', 'org-team4');
    const cookie = sessionCookie(reg);
    const orgId = (await app.inject({ method: 'POST', url: '/orgs', payload: { name: 'org-detail' }, headers: { cookie } })).json().id as string;

    const res = await app.inject({ method: 'GET', url: `/orgs/${orgId}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.org.name).toBe('org-detail');
    expect(body.role).toBe('owner');
    expect(body.members).toHaveLength(1);
    expect(body.members[0].email).toBe('owner4@example.com');
    expect(body.teams).toEqual([]);
  });

  it('returns 403 for a user who is not a member of the org', async () => {
    const reg = await registerUser('owner5@example.com', 'org-team5');
    const cookie = sessionCookie(reg);
    const orgId = (await app.inject({ method: 'POST', url: '/orgs', payload: { name: 'org-private' }, headers: { cookie } })).json().id as string;

    const other = await registerUser('outsider5@example.com', 'org-team5-outsider');
    const res = await app.inject({ method: 'GET', url: `/orgs/${orgId}`, headers: { cookie: sessionCookie(other) } });
    expect(res.statusCode).toBe(403);
  });

  it('includes teams created under the org with quota/usage summaries', async () => {
    const reg = await registerUser('owner6@example.com', 'org-team6');
    const cookie = sessionCookie(reg);
    const orgId = (await app.inject({ method: 'POST', url: '/orgs', payload: { name: 'org-with-teams' }, headers: { cookie } })).json().id as string;

    await app.inject({ method: 'POST', url: `/orgs/${orgId}/teams`, payload: { name: 'sub-team-a' }, headers: { cookie } });

    const res = await app.inject({ method: 'GET', url: `/orgs/${orgId}`, headers: { cookie } });
    const body = res.json();
    expect(body.teams).toHaveLength(1);
    expect(body.teams[0].name).toBe('sub-team-a');
    expect(body.teams[0].quota.maxConcurrentTests).toBeGreaterThan(0);
    expect(body.teams[0].usage).toEqual({ concurrentTests: 0, scheduledTests: 0, geminiCallsToday: 0 });
  });
});

// ─── POST /orgs/:id/members ───────────────────────────────────────────────────

describe('POST /orgs/:id/members', () => {
  it('owner can add an existing user as a member', async () => {
    const owner = await registerUser('owner7@example.com', 'org-team7');
    const ownerCookie = sessionCookie(owner);
    const orgId = (await app.inject({ method: 'POST', url: '/orgs', payload: { name: 'org-add' }, headers: { cookie: ownerCookie } })).json().id as string;

    await registerUser('newmember7@example.com', 'newmember7-own-team');

    const res = await app.inject({ method: 'POST', url: `/orgs/${orgId}/members`, payload: { email: 'newmember7@example.com', role: 'admin' }, headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    const detail = await app.inject({ method: 'GET', url: `/orgs/${orgId}`, headers: { cookie: ownerCookie } });
    expect(detail.json().members).toHaveLength(2);
  });

  it('defaults to "member" role when role is omitted', async () => {
    const owner = await registerUser('owner8@example.com', 'org-team8');
    const ownerCookie = sessionCookie(owner);
    const orgId = (await app.inject({ method: 'POST', url: '/orgs', payload: { name: 'org-add2' }, headers: { cookie: ownerCookie } })).json().id as string;
    await registerUser('newmember8@example.com', 'newmember8-own-team');

    await app.inject({ method: 'POST', url: `/orgs/${orgId}/members`, payload: { email: 'newmember8@example.com' }, headers: { cookie: ownerCookie } });

    const detail = await app.inject({ method: 'GET', url: `/orgs/${orgId}`, headers: { cookie: ownerCookie } });
    const added = detail.json().members.find((m: { email: string }) => m.email === 'newmember8@example.com');
    expect(added.role).toBe('member');
  });

  it('returns 404 when the email does not belong to any user', async () => {
    const owner = await registerUser('owner9@example.com', 'org-team9');
    const ownerCookie = sessionCookie(owner);
    const orgId = (await app.inject({ method: 'POST', url: '/orgs', payload: { name: 'org-add3' }, headers: { cookie: ownerCookie } })).json().id as string;

    const res = await app.inject({ method: 'POST', url: `/orgs/${orgId}/members`, payload: { email: 'ghost9@example.com' }, headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when the user is already a member', async () => {
    const owner = await registerUser('owner10@example.com', 'org-team10');
    const ownerCookie = sessionCookie(owner);
    const orgId = (await app.inject({ method: 'POST', url: '/orgs', payload: { name: 'org-add4' }, headers: { cookie: ownerCookie } })).json().id as string;
    await registerUser('member10@example.com', 'member10-own-team');

    await app.inject({ method: 'POST', url: `/orgs/${orgId}/members`, payload: { email: 'member10@example.com' }, headers: { cookie: ownerCookie } });
    const res = await app.inject({ method: 'POST', url: `/orgs/${orgId}/members`, payload: { email: 'member10@example.com' }, headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(409);
  });

  it('returns 403 when a non-owner/admin member tries to add a member', async () => {
    const owner = await registerUser('owner11@example.com', 'org-team11');
    const ownerCookie = sessionCookie(owner);
    const orgId = (await app.inject({ method: 'POST', url: '/orgs', payload: { name: 'org-add5' }, headers: { cookie: ownerCookie } })).json().id as string;

    const memberReg = await registerUser('member11@example.com', 'member11-own-team');
    const memberId = memberReg.json().id as string;
    await pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, memberId]);

    await registerUser('target11@example.com', 'target11-own-team');
    const res = await app.inject({ method: 'POST', url: `/orgs/${orgId}/members`, payload: { email: 'target11@example.com' }, headers: { cookie: sessionCookie(memberReg) } });
    expect(res.statusCode).toBe(403);
  });
});

// ─── PUT /orgs/:id/members/:userId ────────────────────────────────────────────

describe('PUT /orgs/:id/members/:userId', () => {
  it('owner can change a member\'s role', async () => {
    const owner = await registerUser('owner12@example.com', 'org-team12');
    const ownerCookie = sessionCookie(owner);
    const orgId = (await app.inject({ method: 'POST', url: '/orgs', payload: { name: 'org-role' }, headers: { cookie: ownerCookie } })).json().id as string;

    const memberReg = await registerUser('member12@example.com', 'member12-own-team');
    const memberId = memberReg.json().id as string;
    await pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, memberId]);

    const res = await app.inject({ method: 'PUT', url: `/orgs/${orgId}/members/${memberId}`, payload: { role: 'admin' }, headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(200);

    const detail = await app.inject({ method: 'GET', url: `/orgs/${orgId}`, headers: { cookie: ownerCookie } });
    const updated = detail.json().members.find((m: { userId: string }) => m.userId === memberId);
    expect(updated.role).toBe('admin');
  });

  it('returns 400 for an invalid role', async () => {
    const owner = await registerUser('owner13@example.com', 'org-team13');
    const ownerCookie = sessionCookie(owner);
    const ownerId = owner.json().id as string;
    const orgId = (await app.inject({ method: 'POST', url: '/orgs', payload: { name: 'org-role2' }, headers: { cookie: ownerCookie } })).json().id as string;

    const res = await app.inject({ method: 'PUT', url: `/orgs/${orgId}/members/${ownerId}`, payload: { role: 'superowner' }, headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for a user who is not a member', async () => {
    const owner = await registerUser('owner14@example.com', 'org-team14');
    const ownerCookie = sessionCookie(owner);
    const orgId = (await app.inject({ method: 'POST', url: '/orgs', payload: { name: 'org-role3' }, headers: { cookie: ownerCookie } })).json().id as string;
    const other = await registerUser('other14@example.com', 'other14-own-team');
    const otherId = other.json().id as string;

    const res = await app.inject({ method: 'PUT', url: `/orgs/${orgId}/members/${otherId}`, payload: { role: 'member' }, headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when demoting the last owner', async () => {
    const owner = await registerUser('owner15@example.com', 'org-team15');
    const ownerCookie = sessionCookie(owner);
    const ownerId = owner.json().id as string;
    const orgId = (await app.inject({ method: 'POST', url: '/orgs', payload: { name: 'org-role4' }, headers: { cookie: ownerCookie } })).json().id as string;

    const res = await app.inject({ method: 'PUT', url: `/orgs/${orgId}/members/${ownerId}`, payload: { role: 'admin' }, headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(409);
  });

  it('allows demoting an owner when another owner remains', async () => {
    const owner = await registerUser('owner16@example.com', 'org-team16');
    const ownerCookie = sessionCookie(owner);
    const ownerId = owner.json().id as string;
    const orgId = (await app.inject({ method: 'POST', url: '/orgs', payload: { name: 'org-role5' }, headers: { cookie: ownerCookie } })).json().id as string;

    const second = await registerUser('second16@example.com', 'second16-own-team');
    const secondId = second.json().id as string;
    await pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [orgId, secondId]);

    const res = await app.inject({ method: 'PUT', url: `/orgs/${orgId}/members/${ownerId}`, payload: { role: 'admin' }, headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(200);
  });
});

// ─── DELETE /orgs/:id/members/:userId ─────────────────────────────────────────

describe('DELETE /orgs/:id/members/:userId', () => {
  it('owner can remove a member', async () => {
    const owner = await registerUser('owner17@example.com', 'org-team17');
    const ownerCookie = sessionCookie(owner);
    const orgId = (await app.inject({ method: 'POST', url: '/orgs', payload: { name: 'org-del' }, headers: { cookie: ownerCookie } })).json().id as string;

    const memberReg = await registerUser('member17@example.com', 'member17-own-team');
    const memberId = memberReg.json().id as string;
    await pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, memberId]);

    const res = await app.inject({ method: 'DELETE', url: `/orgs/${orgId}/members/${memberId}`, headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(200);

    const detail = await app.inject({ method: 'GET', url: `/orgs/${orgId}`, headers: { cookie: ownerCookie } });
    expect(detail.json().members).toHaveLength(1);
  });

  it('returns 409 when removing the last owner', async () => {
    const owner = await registerUser('owner18@example.com', 'org-team18');
    const ownerCookie = sessionCookie(owner);
    const ownerId = owner.json().id as string;
    const orgId = (await app.inject({ method: 'POST', url: '/orgs', payload: { name: 'org-del2' }, headers: { cookie: ownerCookie } })).json().id as string;

    const res = await app.inject({ method: 'DELETE', url: `/orgs/${orgId}/members/${ownerId}`, headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(409);
  });
});

// ─── POST /orgs/:id/teams ──────────────────────────────────────────────────────

describe('POST /orgs/:id/teams', () => {
  it('owner/admin can create a new team under the org', async () => {
    const owner = await registerUser('owner19@example.com', 'org-team19');
    const ownerCookie = sessionCookie(owner);
    const orgId = (await app.inject({ method: 'POST', url: '/orgs', payload: { name: 'org-newteam' }, headers: { cookie: ownerCookie } })).json().id as string;

    const res = await app.inject({ method: 'POST', url: `/orgs/${orgId}/teams`, payload: { name: 'sub-team-b' }, headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('admin');
    expect(res.json().name).toBe('sub-team-b');

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: ownerCookie } });
    expect(me.json().teams.map((t: { name: string }) => t.name)).toContain('sub-team-b');
  });

  it('returns 409 when team name is already taken', async () => {
    const owner = await registerUser('owner20@example.com', 'org-team20');
    const ownerCookie = sessionCookie(owner);
    const orgId = (await app.inject({ method: 'POST', url: '/orgs', payload: { name: 'org-newteam2' }, headers: { cookie: ownerCookie } })).json().id as string;

    await app.inject({ method: 'POST', url: `/orgs/${orgId}/teams`, payload: { name: 'org-team20' }, headers: { cookie: ownerCookie } });
    const res = await app.inject({ method: 'POST', url: `/orgs/${orgId}/teams`, payload: { name: 'org-team20' }, headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(409);
  });

  it('returns 403 for a non-owner/admin org member', async () => {
    const owner = await registerUser('owner21@example.com', 'org-team21');
    const ownerCookie = sessionCookie(owner);
    const orgId = (await app.inject({ method: 'POST', url: '/orgs', payload: { name: 'org-newteam3' }, headers: { cookie: ownerCookie } })).json().id as string;

    const memberReg = await registerUser('member21@example.com', 'member21-own-team');
    const memberId = memberReg.json().id as string;
    await pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, memberId]);

    const res = await app.inject({ method: 'POST', url: `/orgs/${orgId}/teams`, payload: { name: 'sub-team-c' }, headers: { cookie: sessionCookie(memberReg) } });
    expect(res.statusCode).toBe(403);
  });
});
