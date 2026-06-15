import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from '../../../../test-support/sharedPostgres';
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
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.AUTH_RATE_LIMIT_MAX;
  delete process.env.SESSION_SECRET;
  await app.close();
  await dropDb();
});

beforeEach(async () => {
  await pool.query('TRUNCATE test_results, test_scripts, webhooks, schedules, test_presets, log_sources, sessions, team_members, users, projects CASCADE');
});

// ─── POST /teams ──────────────────────────────────────────────────────────────

describe('POST /teams', () => {
  it('creates a new team and makes the requester an admin', async () => {
    const reg = await registerUser('owner@example.com', 'team-owner');
    const cookie = sessionCookie(reg);

    const res = await app.inject({ method: 'POST', url: '/teams', payload: { name: 'second-team' }, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('admin');
    expect(res.json().name).toBe('second-team');

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.json().teams).toHaveLength(2);
  });

  it('returns 400 when name is missing', async () => {
    const reg = await registerUser('owner2@example.com', 'team-owner2');
    const res = await app.inject({ method: 'POST', url: '/teams', payload: {}, headers: { cookie: sessionCookie(reg) } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 when the team name is already taken', async () => {
    const reg = await registerUser('owner3@example.com', 'team-owner3');
    const cookie = sessionCookie(reg);
    await app.inject({ method: 'POST', url: '/teams', payload: { name: 'dup-team' }, headers: { cookie } });
    const res = await app.inject({ method: 'POST', url: '/teams', payload: { name: 'dup-team' }, headers: { cookie } });
    expect(res.statusCode).toBe(409);
  });
});

// ─── GET /teams/:id/members ───────────────────────────────────────────────────

describe('GET /teams/:id/members', () => {
  it('returns the member list for the caller\'s current team', async () => {
    const reg = await registerUser('alice@example.com', 'team-list');
    const cookie = sessionCookie(reg);
    const teamId = reg.json().currentTeamId as string;

    const res = await app.inject({ method: 'GET', url: `/teams/${teamId}/members`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const members = res.json();
    expect(members).toHaveLength(1);
    expect(members[0].email).toBe('alice@example.com');
    expect(members[0].role).toBe('admin');
  });

  it('returns 403 for a team that is not the caller\'s current team', async () => {
    const regA = await registerUser('a@example.com', 'team-a-list');
    const regB = await registerUser('b@example.com', 'team-b-list');
    const teamIdB = regB.json().currentTeamId as string;

    const res = await app.inject({ method: 'GET', url: `/teams/${teamIdB}/members`, headers: { cookie: sessionCookie(regA) } });
    expect(res.statusCode).toBe(403);
  });
});

// ─── POST /teams/:id/members ──────────────────────────────────────────────────

describe('POST /teams/:id/members', () => {
  it('admin can add an existing user as a member', async () => {
    const admin = await registerUser('admin@example.com', 'team-add');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;

    await registerUser('newmember@example.com', 'newmember-own-team');

    const res = await app.inject({ method: 'POST', url: `/teams/${teamId}/members`, payload: { email: 'newmember@example.com', role: 'member' }, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    const members = await app.inject({ method: 'GET', url: `/teams/${teamId}/members`, headers: { cookie: adminCookie } });
    expect(members.json()).toHaveLength(2);
  });

  it('defaults to "member" role when role is omitted', async () => {
    const admin = await registerUser('admin2@example.com', 'team-add2');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;
    await registerUser('newmember2@example.com', 'newmember2-own-team');

    await app.inject({ method: 'POST', url: `/teams/${teamId}/members`, payload: { email: 'newmember2@example.com' }, headers: { cookie: adminCookie } });

    const members = await app.inject({ method: 'GET', url: `/teams/${teamId}/members`, headers: { cookie: adminCookie } });
    const added = members.json().find((m: { email: string }) => m.email === 'newmember2@example.com');
    expect(added.role).toBe('member');
  });

  it('returns 404 when the email does not belong to any user', async () => {
    const admin = await registerUser('admin3@example.com', 'team-add3');
    const teamId = admin.json().currentTeamId as string;

    const res = await app.inject({ method: 'POST', url: `/teams/${teamId}/members`, payload: { email: 'ghost@example.com' }, headers: { cookie: sessionCookie(admin) } });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when the user is already a member', async () => {
    const admin = await registerUser('admin4@example.com', 'team-add4');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;
    await registerUser('member4@example.com', 'member4-own-team');

    await app.inject({ method: 'POST', url: `/teams/${teamId}/members`, payload: { email: 'member4@example.com' }, headers: { cookie: adminCookie } });
    const res = await app.inject({ method: 'POST', url: `/teams/${teamId}/members`, payload: { email: 'member4@example.com' }, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(409);
  });

  it('returns 403 when a non-admin (member) tries to add a member', async () => {
    const admin = await registerUser('admin5@example.com', 'team-add5');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;

    const memberReg = await registerUser('member5@example.com', 'member5-own-team');
    const memberId = memberReg.json().id as string;
    await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, [teamId, memberId]);
    await app.inject({ method: 'POST', url: '/auth/switch-team', payload: { teamId }, headers: { cookie: sessionCookie(memberReg) } });

    await registerUser('target5@example.com', 'target5-own-team');
    const res = await app.inject({ method: 'POST', url: `/teams/${teamId}/members`, payload: { email: 'target5@example.com' }, headers: { cookie: sessionCookie(memberReg) } });
    expect(res.statusCode).toBe(403);

    void adminCookie;
  });
});

// ─── PUT /teams/:id/members/:userId ───────────────────────────────────────────

describe('PUT /teams/:id/members/:userId', () => {
  it('admin can change a member\'s role', async () => {
    const admin = await registerUser('admin6@example.com', 'team-role');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;

    const memberReg = await registerUser('member6@example.com', 'member6-own-team');
    const memberId = memberReg.json().id as string;
    await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, [teamId, memberId]);

    const res = await app.inject({ method: 'PUT', url: `/teams/${teamId}/members/${memberId}`, payload: { role: 'viewer' }, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);

    const members = await app.inject({ method: 'GET', url: `/teams/${teamId}/members`, headers: { cookie: adminCookie } });
    const updated = members.json().find((m: { userId: string }) => m.userId === memberId);
    expect(updated.role).toBe('viewer');
  });

  it('returns 400 for an invalid role', async () => {
    const admin = await registerUser('admin7@example.com', 'team-role2');
    const teamId = admin.json().currentTeamId as string;
    const userId = admin.json().id as string;

    const res = await app.inject({ method: 'PUT', url: `/teams/${teamId}/members/${userId}`, payload: { role: 'superadmin' }, headers: { cookie: sessionCookie(admin) } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for a user who is not a member', async () => {
    const admin = await registerUser('admin8@example.com', 'team-role3');
    const teamId = admin.json().currentTeamId as string;
    const other = await registerUser('other8@example.com', 'other8-own-team');
    const otherId = other.json().id as string;

    const res = await app.inject({ method: 'PUT', url: `/teams/${teamId}/members/${otherId}`, payload: { role: 'member' }, headers: { cookie: sessionCookie(admin) } });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when demoting the last admin', async () => {
    const admin = await registerUser('admin9@example.com', 'team-role4');
    const teamId = admin.json().currentTeamId as string;
    const adminId = admin.json().id as string;

    const res = await app.inject({ method: 'PUT', url: `/teams/${teamId}/members/${adminId}`, payload: { role: 'member' }, headers: { cookie: sessionCookie(admin) } });
    expect(res.statusCode).toBe(409);
  });

  it('allows demoting an admin when another admin remains', async () => {
    const admin = await registerUser('admin10@example.com', 'team-role5');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;
    const adminId = admin.json().id as string;

    const second = await registerUser('second10@example.com', 'second10-own-team');
    const secondId = second.json().id as string;
    await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'admin')`, [teamId, secondId]);

    const res = await app.inject({ method: 'PUT', url: `/teams/${teamId}/members/${adminId}`, payload: { role: 'member' }, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
  });

  it('returns 403 when a viewer attempts to change roles', async () => {
    const admin = await registerUser('admin11@example.com', 'team-role6');
    const teamId = admin.json().currentTeamId as string;

    const viewerReg = await registerUser('viewer11@example.com', 'viewer11-own-team');
    const viewerId = viewerReg.json().id as string;
    await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'viewer')`, [teamId, viewerId]);
    await app.inject({ method: 'POST', url: '/auth/switch-team', payload: { teamId }, headers: { cookie: sessionCookie(viewerReg) } });

    const res = await app.inject({ method: 'PUT', url: `/teams/${teamId}/members/${viewerId}`, payload: { role: 'member' }, headers: { cookie: sessionCookie(viewerReg) } });
    expect(res.statusCode).toBe(403);
  });
});

// ─── DELETE /teams/:id/members/:userId ────────────────────────────────────────

describe('DELETE /teams/:id/members/:userId', () => {
  it('admin can remove a member', async () => {
    const admin = await registerUser('admin12@example.com', 'team-del');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;

    const memberReg = await registerUser('member12@example.com', 'member12-own-team');
    const memberId = memberReg.json().id as string;
    await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, [teamId, memberId]);

    const res = await app.inject({ method: 'DELETE', url: `/teams/${teamId}/members/${memberId}`, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);

    const members = await app.inject({ method: 'GET', url: `/teams/${teamId}/members`, headers: { cookie: adminCookie } });
    expect(members.json()).toHaveLength(1);
  });

  it('returns 404 for a user who is not a member', async () => {
    const admin = await registerUser('admin13@example.com', 'team-del2');
    const teamId = admin.json().currentTeamId as string;
    const other = await registerUser('other13@example.com', 'other13-own-team');
    const otherId = other.json().id as string;

    const res = await app.inject({ method: 'DELETE', url: `/teams/${teamId}/members/${otherId}`, headers: { cookie: sessionCookie(admin) } });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when removing the last admin', async () => {
    const admin = await registerUser('admin14@example.com', 'team-del3');
    const teamId = admin.json().currentTeamId as string;
    const adminId = admin.json().id as string;

    const res = await app.inject({ method: 'DELETE', url: `/teams/${teamId}/members/${adminId}`, headers: { cookie: sessionCookie(admin) } });
    expect(res.statusCode).toBe(409);
  });

  it('allows removing an admin when another admin remains', async () => {
    const admin = await registerUser('admin15@example.com', 'team-del4');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;

    const second = await registerUser('second15@example.com', 'second15-own-team');
    const secondId = second.json().id as string;
    await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'admin')`, [teamId, secondId]);

    const res = await app.inject({ method: 'DELETE', url: `/teams/${teamId}/members/${secondId}`, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
  });

  it('returns 403 when a member (non-admin) attempts to remove a member', async () => {
    const admin = await registerUser('admin16@example.com', 'team-del5');
    const teamId = admin.json().currentTeamId as string;

    const memberReg = await registerUser('member16@example.com', 'member16-own-team');
    const memberId = memberReg.json().id as string;
    await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, [teamId, memberId]);
    await app.inject({ method: 'POST', url: '/auth/switch-team', payload: { teamId }, headers: { cookie: sessionCookie(memberReg) } });

    const res = await app.inject({ method: 'DELETE', url: `/teams/${teamId}/members/${memberId}`, headers: { cookie: sessionCookie(memberReg) } });
    expect(res.statusCode).toBe(403);
  });
});

// ─── GET/PUT /teams/:id/quotas ─────────────────────────────────────────────────

describe('GET/PUT /teams/:id/quotas', () => {
  it('any member can view quota and usage', async () => {
    const admin = await registerUser('admin-quota1@example.com', 'quota-team1');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;

    const memberReg = await registerUser('member-quota1@example.com', 'member-quota1-own-team');
    const memberId = memberReg.json().id as string;
    await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, [teamId, memberId]);
    await app.inject({ method: 'POST', url: '/auth/switch-team', payload: { teamId }, headers: { cookie: sessionCookie(memberReg) } });

    const res = await app.inject({ method: 'GET', url: `/teams/${teamId}/quotas`, headers: { cookie: sessionCookie(memberReg) } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.quota.maxConcurrentTests).toBeGreaterThan(0);
    expect(body.usage).toEqual({ concurrentTests: 0, scheduledTests: 0, geminiCallsToday: 0 });

    // also accessible to the admin
    const adminRes = await app.inject({ method: 'GET', url: `/teams/${teamId}/quotas`, headers: { cookie: adminCookie } });
    expect(adminRes.statusCode).toBe(200);
  });

  it('returns 403 when requesting quotas for a team the caller is not currently in', async () => {
    const admin = await registerUser('admin-quota2@example.com', 'quota-team2');
    const otherTeamId = admin.json().currentTeamId as string;

    const other = await registerUser('other-quota2@example.com', 'other-quota2-team');
    const res = await app.inject({ method: 'GET', url: `/teams/${otherTeamId}/quotas`, headers: { cookie: sessionCookie(other) } });
    expect(res.statusCode).toBe(403);
  });

  it('admin can update quota limits', async () => {
    const admin = await registerUser('admin-quota3@example.com', 'quota-team3');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;

    const res = await app.inject({
      method: 'PUT', url: `/teams/${teamId}/quotas`,
      payload: { maxConcurrentTests: 2, maxVusPerTest: 250 },
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().quota).toMatchObject({ maxConcurrentTests: 2, maxVusPerTest: 250 });

    const get = await app.inject({ method: 'GET', url: `/teams/${teamId}/quotas`, headers: { cookie: adminCookie } });
    expect(get.json().quota).toMatchObject({ maxConcurrentTests: 2, maxVusPerTest: 250 });
  });

  it('returns 400 for non-positive-integer quota values', async () => {
    const admin = await registerUser('admin-quota4@example.com', 'quota-team4');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;

    const res = await app.inject({
      method: 'PUT', url: `/teams/${teamId}/quotas`,
      payload: { maxConcurrentTests: -1 },
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 when a non-admin member attempts to update quotas', async () => {
    const admin = await registerUser('admin-quota5@example.com', 'quota-team5');
    const teamId = admin.json().currentTeamId as string;

    const memberReg = await registerUser('member-quota5@example.com', 'member-quota5-own-team');
    const memberId = memberReg.json().id as string;
    await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, [teamId, memberId]);
    await app.inject({ method: 'POST', url: '/auth/switch-team', payload: { teamId }, headers: { cookie: sessionCookie(memberReg) } });

    const res = await app.inject({
      method: 'PUT', url: `/teams/${teamId}/quotas`,
      payload: { maxConcurrentTests: 2 },
      headers: { cookie: sessionCookie(memberReg) },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── GET /teams/:id/audit-log ──────────────────────────────────────────────────

describe('GET /teams/:id/audit-log', () => {
  it('admin can view audit log entries for their team', async () => {
    const admin = await registerUser('admin-audit1@example.com', 'audit-team1');
    const adminCookie = sessionCookie(admin);
    const adminId = admin.json().id as string;
    const teamId = admin.json().currentTeamId as string;

    await pool.query(
      `INSERT INTO audit_log (team_id, user_id, action, resource_type, resource_id) VALUES ($1, $2, 'export_pdf', 'test_result', 'test-1')`,
      [teamId, adminId]
    );

    const res = await app.inject({ method: 'GET', url: `/teams/${teamId}/audit-log`, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const { entries } = res.json();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'export_pdf', resourceType: 'test_result', resourceId: 'test-1', userEmail: 'admin-audit1@example.com' });
  });

  it('returns 403 for a non-admin member', async () => {
    const admin = await registerUser('admin-audit2@example.com', 'audit-team2');
    const teamId = admin.json().currentTeamId as string;

    const memberReg = await registerUser('member-audit2@example.com', 'member-audit2-own-team');
    const memberId = memberReg.json().id as string;
    await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, [teamId, memberId]);
    await app.inject({ method: 'POST', url: '/auth/switch-team', payload: { teamId }, headers: { cookie: sessionCookie(memberReg) } });

    const res = await app.inject({ method: 'GET', url: `/teams/${teamId}/audit-log`, headers: { cookie: sessionCookie(memberReg) } });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 when requesting audit log for a team the caller is not currently in', async () => {
    const admin = await registerUser('admin-audit3@example.com', 'audit-team3');
    const otherTeamId = admin.json().currentTeamId as string;

    const other = await registerUser('other-audit3@example.com', 'other-audit3-team');
    const res = await app.inject({ method: 'GET', url: `/teams/${otherTeamId}/audit-log`, headers: { cookie: sessionCookie(other) } });
    expect(res.statusCode).toBe(403);
  });

  it('records an audit entry when a CSV report is exported', async () => {
    const admin = await registerUser('admin-audit4@example.com', 'audit-team4');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;

    const testId = '00000000-0000-0000-0000-0000000a4000';
    await pool.query(
      `INSERT INTO test_results (test_id, project_id, type, target_url, status, metrics)
       VALUES ($1, $2, 'backend', 'http://example.com', 'completed', $3)`,
      [testId, teamId, JSON.stringify({ type: 'backend', requestsTotal: 1, requestsFailed: 0, avgResponseTime: 1, p50ResponseTime: 1, p95ResponseTime: 1, p99ResponseTime: 1, rps: 1 })]
    );

    const res = await app.inject({ method: 'GET', url: `/results/${testId}/report.csv`, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);

    const logRes = await app.inject({ method: 'GET', url: `/teams/${teamId}/audit-log`, headers: { cookie: adminCookie } });
    const { entries } = logRes.json();
    expect(entries).toMatchObject([{ action: 'export_csv', resourceType: 'test_result', resourceId: testId }]);
  });
});

// ─── DELETE /teams/:id/data (right to erasure) ─────────────────────────────────

describe('DELETE /teams/:id/data', () => {
  it('admin can erase all team data', async () => {
    const admin = await registerUser('admin-erase1@example.com', 'erase-team1');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;

    const testId = '00000000-0000-0000-0000-0000000e1000';
    await pool.query(
      `INSERT INTO test_results (test_id, project_id, type, target_url, status, metrics)
       VALUES ($1, $2, 'backend', 'http://example.com', 'completed', $3)`,
      [testId, teamId, JSON.stringify({ type: 'backend', requestsTotal: 1, requestsFailed: 0, avgResponseTime: 1, p50ResponseTime: 1, p95ResponseTime: 1, p99ResponseTime: 1, rps: 1 })]
    );
    await pool.query(
      `INSERT INTO live_metrics (test_id, vus, rps, avg_response_time, error_rate) VALUES ($1, 0, 0, 0, 0)`,
      [testId]
    );
    await pool.query(
      `INSERT INTO test_scripts (target_url, test_type, script, project_id) VALUES ('http://example.com', 'backend', 'k6 script', $1)`,
      [teamId]
    );

    const res = await app.inject({ method: 'DELETE', url: `/teams/${teamId}/data`, payload: { confirm: true }, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.deleted).toMatchObject({ testResults: 1, scripts: 1 });

    const { rows: results } = await pool.query('SELECT * FROM test_results WHERE project_id = $1', [teamId]);
    expect(results).toHaveLength(0);
    const { rows: live } = await pool.query('SELECT * FROM live_metrics WHERE test_id = $1', [testId]);
    expect(live).toHaveLength(0);
    const { rows: scripts } = await pool.query('SELECT * FROM test_scripts WHERE project_id = $1', [teamId]);
    expect(scripts).toHaveLength(0);
  });

  it('returns 400 without confirm: true', async () => {
    const admin = await registerUser('admin-erase2@example.com', 'erase-team2');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;

    const res = await app.inject({ method: 'DELETE', url: `/teams/${teamId}/data`, payload: {}, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 for a non-admin member', async () => {
    const admin = await registerUser('admin-erase3@example.com', 'erase-team3');
    const teamId = admin.json().currentTeamId as string;

    const memberReg = await registerUser('member-erase3@example.com', 'member-erase3-own-team');
    const memberId = memberReg.json().id as string;
    await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, [teamId, memberId]);
    await app.inject({ method: 'POST', url: '/auth/switch-team', payload: { teamId }, headers: { cookie: sessionCookie(memberReg) } });

    const res = await app.inject({ method: 'DELETE', url: `/teams/${teamId}/data`, payload: { confirm: true }, headers: { cookie: sessionCookie(memberReg) } });
    expect(res.statusCode).toBe(403);
  });

  it('records an erasure audit entry that survives the erase (logged after clearing)', async () => {
    const admin = await registerUser('admin-erase4@example.com', 'erase-team4');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;

    await app.inject({ method: 'DELETE', url: `/teams/${teamId}/data`, payload: { confirm: true }, headers: { cookie: adminCookie } });

    const logRes = await app.inject({ method: 'GET', url: `/teams/${teamId}/audit-log`, headers: { cookie: adminCookie } });
    const { entries } = logRes.json();
    expect(entries).toMatchObject([{ action: 'erase_team_data', resourceType: 'team_data', resourceId: teamId }]);
  });
});

// ─── POST /schedules — quota enforcement ───────────────────────────────────────

describe('POST /schedules — quota enforcement', () => {
  const schedulePayload = {
    name: 'Hourly smoke',
    cron: '0 * * * *',
    type: 'backend',
    target_url: 'http://smoke.com',
    options: { vus: 5, duration: '30s' },
  };

  it('returns 429 once the team reaches its enabled-schedule limit', async () => {
    const admin = await registerUser('admin-sched1@example.com', 'sched-quota-team1');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;

    await pool.query(
      `INSERT INTO team_quotas (team_id, max_concurrent_tests, max_vus_per_test, max_test_duration_seconds, max_scheduled_tests, max_gemini_calls_per_day)
       VALUES ($1, 5, 1000, 3600, 1, 100)`,
      [teamId]
    );

    const first = await app.inject({ method: 'POST', url: '/schedules', payload: schedulePayload, headers: { cookie: adminCookie } });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({ method: 'POST', url: '/schedules', payload: schedulePayload, headers: { cookie: adminCookie } });
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toMatch(/enabled-schedule limit/);
  });
});
