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

const registerUser = (email: string, teamName: string, password = 'password123') =>
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const addMemberWithRole = async (teamId: string, adminCookie: string, role: 'member' | 'viewer') => {
  const email = `${role}-${Date.now()}@example.com`;
  await registerUser(email, `own-team-${Date.now()}`);
  await app.inject({
    method: 'POST', url: `/teams/${teamId}/members`,
    payload: { email, role },
    headers: { cookie: adminCookie },
  });
  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'password123' } });
  // switch to the shared team; switch-team rotates the token, so the caller must use
  // the cookie from this response, not the pre-switch login cookie.
  const switched = await app.inject({ method: 'POST', url: '/auth/switch-team', payload: { teamId }, headers: { cookie: sessionCookie(login) } });
  return sessionCookie(switched);
};

// ─── GET /workspaces ──────────────────────────────────────────────────────────

describe('GET /workspaces', () => {
  it('returns 403 when user has no current team', async () => {
    // Register a user; manually clear their team to simulate teamless state
    const reg = await registerUser('teamless@example.com', 'tl-team');
    const cookie = sessionCookie(reg);
    const teamId = reg.json().currentTeamId as string;
    // switch to null team — not directly possible via API; test via direct DB update
    await pool.query(`UPDATE sessions SET team_id = NULL WHERE token_hash IS NOT NULL`);
    const res = await app.inject({ method: 'GET', url: '/workspaces', headers: { cookie } });
    // with no team_id in session → projectId is null → workspaces route returns 403
    expect(res.statusCode).toBe(403);
    // cleanup
    await pool.query(`UPDATE sessions SET team_id = $1 WHERE token_hash IS NOT NULL`, [teamId]);
  });

  it('returns empty array when team has no workspaces', async () => {
    const reg = await registerUser('alice@example.com', 'team-ws-empty');
    const res = await app.inject({ method: 'GET', url: '/workspaces', headers: { cookie: sessionCookie(reg) } });
    expect(res.statusCode).toBe(200);
    expect(res.json().workspaces).toEqual([]);
  });

  it('returns workspaces for the current team in alphabetical order', async () => {
    const reg = await registerUser('bob@example.com', 'team-ws-list');
    const cookie = sessionCookie(reg);
    await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'Zebra' }, headers: { cookie } });
    await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'Alpha', description: 'first' }, headers: { cookie } });
    const res = await app.inject({ method: 'GET', url: '/workspaces', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const names = res.json().workspaces.map((w: { name: string }) => w.name);
    expect(names).toEqual(['Alpha', 'Zebra']);
  });

  it('does not return workspaces from other teams', async () => {
    const regA = await registerUser('a@example.com', 'team-iso-a');
    const regB = await registerUser('b@example.com', 'team-iso-b');
    await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'A-workspace' }, headers: { cookie: sessionCookie(regA) } });
    const res = await app.inject({ method: 'GET', url: '/workspaces', headers: { cookie: sessionCookie(regB) } });
    expect(res.json().workspaces).toEqual([]);
  });

  it('returns workspaces with correct shape', async () => {
    const reg = await registerUser('shape@example.com', 'team-shape');
    const cookie = sessionCookie(reg);
    await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'My Project', description: 'Testing' }, headers: { cookie } });
    const res = await app.inject({ method: 'GET', url: '/workspaces', headers: { cookie } });
    const ws = res.json().workspaces[0];
    expect(ws).toMatchObject({ name: 'My Project', description: 'Testing' });
    expect(ws.id).toBeDefined();
    expect(ws.teamId).toBeDefined();
    expect(ws.createdAt).toBeDefined();
  });
});

// ─── POST /workspaces ─────────────────────────────────────────────────────────

describe('POST /workspaces', () => {
  it('creates a workspace with name and description', async () => {
    const reg = await registerUser('create@example.com', 'team-create');
    const cookie = sessionCookie(reg);
    const res = await app.inject({
      method: 'POST', url: '/workspaces',
      payload: { name: 'Production', description: 'Prod tests' },
      headers: { cookie },
    });
    expect(res.statusCode).toBe(201);
    const ws = res.json();
    expect(ws.name).toBe('Production');
    expect(ws.description).toBe('Prod tests');
    expect(ws.id).toBeDefined();
  });

  it('creates a workspace with name only (description is optional)', async () => {
    const reg = await registerUser('noDesc@example.com', 'team-no-desc');
    const res = await app.inject({
      method: 'POST', url: '/workspaces',
      payload: { name: 'Staging' },
      headers: { cookie: sessionCookie(reg) },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().description).toBeNull();
  });

  it('returns 400 when name is missing', async () => {
    const reg = await registerUser('noname@example.com', 'team-no-name');
    const res = await app.inject({
      method: 'POST', url: '/workspaces',
      payload: {},
      headers: { cookie: sessionCookie(reg) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/name/i);
  });

  it('returns 400 when name is blank', async () => {
    const reg = await registerUser('blank@example.com', 'team-blank');
    const res = await app.inject({
      method: 'POST', url: '/workspaces',
      payload: { name: '   ' },
      headers: { cookie: sessionCookie(reg) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 on duplicate name within the same team', async () => {
    const reg = await registerUser('dup@example.com', 'team-dup');
    const cookie = sessionCookie(reg);
    await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'Dupe' }, headers: { cookie } });
    const res = await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'Dupe' }, headers: { cookie } });
    expect(res.statusCode).toBe(409);
  });

  it('allows the same name in different teams', async () => {
    const regA = await registerUser('team-a@example.com', 'team-dup-a');
    const regB = await registerUser('team-b@example.com', 'team-dup-b');
    const resA = await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'Shared Name' }, headers: { cookie: sessionCookie(regA) } });
    const resB = await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'Shared Name' }, headers: { cookie: sessionCookie(regB) } });
    expect(resA.statusCode).toBe(201);
    expect(resB.statusCode).toBe(201);
  });

  it('returns 403 for viewer role', async () => {
    const admin = await registerUser('admin-ws@example.com', 'team-viewer-create');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;
    const viewerCookie = await addMemberWithRole(teamId, adminCookie, 'viewer');
    const res = await app.inject({
      method: 'POST', url: '/workspaces',
      payload: { name: 'Viewer Attempt' },
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows member role to create a workspace', async () => {
    const admin = await registerUser('admin-m@example.com', 'team-member-create');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;
    const memberCookie = await addMemberWithRole(teamId, adminCookie, 'member');
    const res = await app.inject({
      method: 'POST', url: '/workspaces',
      payload: { name: 'Member Project' },
      headers: { cookie: memberCookie },
    });
    expect(res.statusCode).toBe(201);
  });
});

// ─── PUT /workspaces/:id ──────────────────────────────────────────────────────

describe('PUT /workspaces/:id', () => {
  it('updates name and description', async () => {
    const reg = await registerUser('update@example.com', 'team-update');
    const cookie = sessionCookie(reg);
    const created = await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'Old Name' }, headers: { cookie } });
    const id = created.json().id as string;

    const res = await app.inject({
      method: 'PUT', url: `/workspaces/${id}`,
      payload: { name: 'New Name', description: 'Updated desc' },
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('New Name');
    expect(res.json().description).toBe('Updated desc');
  });

  it('returns 404 for unknown workspace id', async () => {
    const reg = await registerUser('notfound@example.com', 'team-notfound');
    const res = await app.inject({
      method: 'PUT', url: '/workspaces/00000000-0000-0000-0000-000000000099',
      payload: { name: 'x' },
      headers: { cookie: sessionCookie(reg) },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when trying to update another team\'s workspace', async () => {
    const regA = await registerUser('owner-a@example.com', 'team-cross-a');
    const regB = await registerUser('owner-b@example.com', 'team-cross-b');
    const created = await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'A Only' }, headers: { cookie: sessionCookie(regA) } });
    const id = created.json().id as string;
    const res = await app.inject({
      method: 'PUT', url: `/workspaces/${id}`,
      payload: { name: 'Hijacked' },
      headers: { cookie: sessionCookie(regB) },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 on name collision within the same team', async () => {
    const reg = await registerUser('coll@example.com', 'team-coll');
    const cookie = sessionCookie(reg);
    await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'Existing' }, headers: { cookie } });
    const second = await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'Second' }, headers: { cookie } });
    const res = await app.inject({
      method: 'PUT', url: `/workspaces/${second.json().id}`,
      payload: { name: 'Existing' },
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
  });

  it('returns 400 when body has no updatable fields', async () => {
    const reg = await registerUser('empty-update@example.com', 'team-empty-update');
    const cookie = sessionCookie(reg);
    const created = await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'Base' }, headers: { cookie } });
    const res = await app.inject({
      method: 'PUT', url: `/workspaces/${created.json().id}`,
      payload: {},
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 for viewer', async () => {
    const admin = await registerUser('admin-put@example.com', 'team-put-viewer');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;
    const created = await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'To Edit' }, headers: { cookie: adminCookie } });
    const viewerCookie = await addMemberWithRole(teamId, adminCookie, 'viewer');
    const res = await app.inject({
      method: 'PUT', url: `/workspaces/${created.json().id}`,
      payload: { name: 'Viewer Edit' },
      headers: { cookie: viewerCookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── DELETE /workspaces/:id ───────────────────────────────────────────────────

describe('DELETE /workspaces/:id', () => {
  it('admin can delete a workspace', async () => {
    const reg = await registerUser('delete@example.com', 'team-delete');
    const cookie = sessionCookie(reg);
    const created = await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'To Delete' }, headers: { cookie } });
    const id = created.json().id as string;

    const res = await app.inject({ method: 'DELETE', url: `/workspaces/${id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    const list = await app.inject({ method: 'GET', url: '/workspaces', headers: { cookie } });
    expect(list.json().workspaces).toHaveLength(0);
  });

  it('returns 403 for member role', async () => {
    const admin = await registerUser('admin-del@example.com', 'team-del-member');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;
    const created = await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'Protected' }, headers: { cookie: adminCookie } });
    const memberCookie = await addMemberWithRole(teamId, adminCookie, 'member');
    const res = await app.inject({ method: 'DELETE', url: `/workspaces/${created.json().id}`, headers: { cookie: memberCookie } });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 for viewer role', async () => {
    const admin = await registerUser('admin-del-v@example.com', 'team-del-viewer');
    const adminCookie = sessionCookie(admin);
    const teamId = admin.json().currentTeamId as string;
    const created = await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'Protected2' }, headers: { cookie: adminCookie } });
    const viewerCookie = await addMemberWithRole(teamId, adminCookie, 'viewer');
    const res = await app.inject({ method: 'DELETE', url: `/workspaces/${created.json().id}`, headers: { cookie: viewerCookie } });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for unknown workspace', async () => {
    const reg = await registerUser('del-miss@example.com', 'team-del-miss');
    const res = await app.inject({
      method: 'DELETE', url: '/workspaces/00000000-0000-0000-0000-000000000099',
      headers: { cookie: sessionCookie(reg) },
    });
    expect(res.statusCode).toBe(404);
  });

  it('sets workspace_id to null on child resources when workspace is deleted (ON DELETE SET NULL)', async () => {
    const reg = await registerUser('cascade@example.com', 'team-cascade');
    const cookie = sessionCookie(reg);
    const teamId = reg.json().currentTeamId as string;

    const wsRes = await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'Cascade Ws' }, headers: { cookie } });
    const wsId = wsRes.json().id as string;

    // Create a preset scoped to this workspace
    await pool.query(
      `INSERT INTO test_presets (name, type, options, project_id, workspace_id) VALUES ($1, $2, $3, $4, $5)`,
      ['Preset in WS', 'backend', JSON.stringify({ vus: 5, duration: '30s' }), teamId, wsId],
    );

    await app.inject({ method: 'DELETE', url: `/workspaces/${wsId}`, headers: { cookie } });

    const { rows } = await pool.query(`SELECT workspace_id FROM test_presets WHERE name = $1`, ['Preset in WS']);
    expect(rows[0].workspace_id).toBeNull();
  });
});

// ─── GET /results with workspace filter ───────────────────────────────────────

describe('GET /results?workspaceId= filter', () => {
  it('returns only results in the specified workspace', async () => {
    const reg = await registerUser('filter-r@example.com', 'team-filter-r');
    const cookie = sessionCookie(reg);
    const teamId = reg.json().currentTeamId as string;

    const wsRes = await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'Filter WS' }, headers: { cookie } });
    const wsId = wsRes.json().id as string;

    // Insert one result in workspace, one without
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status, project_id, workspace_id)
       VALUES ($1, 'backend', 'http://ws.example.com', 'completed', $2, $3)`,
      [crypto.randomUUID(), teamId, wsId],
    );
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status, project_id)
       VALUES ($1, 'backend', 'http://no-ws.example.com', 'completed', $2)`,
      [crypto.randomUUID(), teamId],
    );

    const res = await app.inject({ method: 'GET', url: `/results?workspaceId=${wsId}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const urls = res.json().results.map((r: { target_url: string }) => r.target_url);
    expect(urls).toContain('http://ws.example.com');
    expect(urls).not.toContain('http://no-ws.example.com');
  });

  it('returns all team results when no workspaceId filter', async () => {
    const reg = await registerUser('all-r@example.com', 'team-all-r');
    const cookie = sessionCookie(reg);
    const teamId = reg.json().currentTeamId as string;

    const wsRes = await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'Some WS' }, headers: { cookie } });
    const wsId = wsRes.json().id as string;

    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status, project_id, workspace_id)
       VALUES ($1, 'backend', 'http://in-ws.example.com', 'completed', $2, $3)`,
      [crypto.randomUUID(), teamId, wsId],
    );
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status, project_id)
       VALUES ($1, 'backend', 'http://no-ws.example.com', 'completed', $2)`,
      [crypto.randomUUID(), teamId],
    );

    const res = await app.inject({ method: 'GET', url: '/results', headers: { cookie } });
    const urls = res.json().results.map((r: { target_url: string }) => r.target_url);
    expect(urls).toContain('http://in-ws.example.com');
    expect(urls).toContain('http://no-ws.example.com');
  });
});

// ─── GET /presets with workspace filter ───────────────────────────────────────

describe('GET /presets?workspaceId= filter', () => {
  it('returns only presets in the specified workspace', async () => {
    const reg = await registerUser('filter-p@example.com', 'team-filter-p');
    const cookie = sessionCookie(reg);
    const teamId = reg.json().currentTeamId as string;

    const wsRes = await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'Preset WS' }, headers: { cookie } });
    const wsId = wsRes.json().id as string;

    await pool.query(
      `INSERT INTO test_presets (name, type, options, project_id, workspace_id) VALUES ('WS Preset', 'backend', '{}', $1, $2)`,
      [teamId, wsId],
    );
    await pool.query(
      `INSERT INTO test_presets (name, type, options, project_id) VALUES ('No WS Preset', 'backend', '{}', $1)`,
      [teamId],
    );

    const res = await app.inject({ method: 'GET', url: `/presets?workspaceId=${wsId}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const names = res.json().presets.map((p: { name: string }) => p.name);
    expect(names).toContain('WS Preset');
    expect(names).not.toContain('No WS Preset');
  });
});

// ─── GET /schedules with workspace filter ─────────────────────────────────────

describe('GET /schedules?workspaceId= filter', () => {
  it('returns only schedules in the specified workspace', async () => {
    const reg = await registerUser('filter-s@example.com', 'team-filter-s');
    const cookie = sessionCookie(reg);
    const teamId = reg.json().currentTeamId as string;

    const wsRes = await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'Sched WS' }, headers: { cookie } });
    const wsId = wsRes.json().id as string;

    await pool.query(
      `INSERT INTO schedules (name, cron, type, target_url, options, project_id, workspace_id)
       VALUES ('WS Schedule', '0 * * * *', 'backend', 'http://a.com', '{}', $1, $2)`,
      [teamId, wsId],
    );
    await pool.query(
      `INSERT INTO schedules (name, cron, type, target_url, options, project_id)
       VALUES ('No WS Schedule', '0 * * * *', 'backend', 'http://b.com', '{}', $1)`,
      [teamId],
    );

    const res = await app.inject({ method: 'GET', url: `/schedules?workspaceId=${wsId}`, headers: { cookie } });
    const names = res.json().schedules.map((s: { name: string }) => s.name);
    expect(names).toContain('WS Schedule');
    expect(names).not.toContain('No WS Schedule');
  });
});

// ─── GET /webhooks with workspace filter ──────────────────────────────────────

describe('GET /webhooks?workspaceId= filter', () => {
  it('returns only webhooks in the specified workspace', async () => {
    const reg = await registerUser('filter-w@example.com', 'team-filter-w');
    const cookie = sessionCookie(reg);
    const teamId = reg.json().currentTeamId as string;

    const wsRes = await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'Hook WS' }, headers: { cookie } });
    const wsId = wsRes.json().id as string;

    await pool.query(
      `INSERT INTO webhooks (url, project_id, workspace_id) VALUES ('https://ws-hook.example.com', $1, $2)`,
      [teamId, wsId],
    );
    await pool.query(
      `INSERT INTO webhooks (url, project_id) VALUES ('https://no-ws-hook.example.com', $1)`,
      [teamId],
    );

    const res = await app.inject({ method: 'GET', url: `/webhooks?workspaceId=${wsId}`, headers: { cookie } });
    const urls = res.json().webhooks.map((w: { url: string }) => w.url);
    expect(urls).toContain('https://ws-hook.example.com');
    expect(urls).not.toContain('https://no-ws-hook.example.com');
  });
});

// ─── POST /presets stores workspace_id ────────────────────────────────────────

describe('POST /presets stores workspace_id (contract: API body → DB column)', () => {
  it('stores workspace_id when provided in the request body', async () => {
    const reg = await registerUser('preset-ws@example.com', 'team-preset-ws');
    const cookie = sessionCookie(reg);
    const teamId = reg.json().currentTeamId as string;

    const wsRes = await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'Preset Contract WS' }, headers: { cookie } });
    const wsId = wsRes.json().id as string;

    await app.inject({
      method: 'POST', url: '/presets',
      payload: { name: 'WS Preset', type: 'backend', target_url: 'http://example.com', options: { vus: 5, duration: '30s' }, workspaceId: wsId },
      headers: { cookie },
    });

    const { rows } = await pool.query(`SELECT workspace_id FROM test_presets WHERE name = $1 AND project_id = $2`, ['WS Preset', teamId]);
    expect(rows[0].workspace_id).toBe(wsId);
  });

  it('stores null workspace_id when not provided', async () => {
    const reg = await registerUser('preset-null@example.com', 'team-preset-null');
    const cookie = sessionCookie(reg);
    const teamId = reg.json().currentTeamId as string;

    await app.inject({
      method: 'POST', url: '/presets',
      payload: { name: 'No WS Preset', type: 'backend', target_url: 'http://example.com', options: { vus: 5, duration: '30s' } },
      headers: { cookie },
    });

    const { rows } = await pool.query(`SELECT workspace_id FROM test_presets WHERE name = $1 AND project_id = $2`, ['No WS Preset', teamId]);
    expect(rows[0].workspace_id).toBeNull();
  });
});

// ─── POST /webhooks stores workspace_id ───────────────────────────────────────

describe('POST /webhooks stores workspace_id (contract: API body → DB column)', () => {
  it('stores workspace_id when provided', async () => {
    const reg = await registerUser('hook-ws@example.com', 'team-hook-ws');
    const cookie = sessionCookie(reg);
    const teamId = reg.json().currentTeamId as string;

    const wsRes = await app.inject({ method: 'POST', url: '/workspaces', payload: { name: 'Hook Contract WS' }, headers: { cookie } });
    const wsId = wsRes.json().id as string;

    await app.inject({
      method: 'POST', url: '/webhooks',
      payload: { url: 'https://contract-hook.example.com', workspaceId: wsId },
      headers: { cookie },
    });

    const { rows } = await pool.query(`SELECT workspace_id FROM webhooks WHERE url = $1 AND project_id = $2`, ['https://contract-hook.example.com', teamId]);
    expect(rows[0].workspace_id).toBe(wsId);
  });
});

// ─── POST /results/pending stores workspace_id ────────────────────────────────

describe('POST /results/pending stores workspace_id (contract: api-service → results-service)', () => {
  it('stores workspace_id when passed in the internal pending body', async () => {
    const reg = await registerUser('pending-ws@example.com', 'team-pending-ws');
    const teamId = reg.json().currentTeamId as string;

    const wsRes = await app.inject({
      method: 'POST', url: '/workspaces',
      payload: { name: 'Pending Contract WS' },
      headers: { cookie: sessionCookie(reg) },
    });
    const wsId = wsRes.json().id as string;

    const testId = crypto.randomUUID();
    const res = await app.inject({
      method: 'POST', url: '/results/pending',
      payload: { testId, type: 'backend', targetUrl: 'http://example.com', projectId: teamId, workspaceId: wsId },
    });
    expect(res.statusCode).toBe(200);

    const { rows } = await pool.query(`SELECT workspace_id FROM test_results WHERE test_id = $1`, [testId]);
    expect(rows[0].workspace_id).toBe(wsId);
  });

  it('stores null workspace_id when not passed', async () => {
    const testId = crypto.randomUUID();
    const res = await app.inject({
      method: 'POST', url: '/results/pending',
      payload: { testId, type: 'backend', targetUrl: 'http://example.com' },
    });
    expect(res.statusCode).toBe(200);

    const { rows } = await pool.query(`SELECT workspace_id FROM test_results WHERE test_id = $1`, [testId]);
    expect(rows[0].workspace_id).toBeNull();
  });
});
