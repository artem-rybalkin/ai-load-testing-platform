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
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('ai_provider', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [JSON.stringify({ provider: 'gemini', fallbacks: [] })]
  );
});

// ─── GET /system/ai-provider ──────────────────────────────────────────────────

describe('GET /system/ai-provider', () => {
  it('returns the default provider setting with no session', async () => {
    const savedKeys = {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const res = await app.inject({ method: 'GET', url: '/system/ai-provider' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.provider).toBe('gemini');
      expect(body.fallbacks).toEqual([]);
      expect(body.available).toEqual({ gemini: false, openai: false, anthropic: false });
    } finally {
      for (const [key, value] of Object.entries(savedKeys)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('reflects available providers based on configured API keys', async () => {
    process.env.GEMINI_API_KEY = 'g-key';
    process.env.OPENAI_API_KEY = 'o-key';
    const res = await app.inject({ method: 'GET', url: '/system/ai-provider' });
    expect(res.json().available).toEqual({ gemini: true, openai: true, anthropic: false });
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });
});

// ─── PUT /system/ai-provider ──────────────────────────────────────────────────

describe('PUT /system/ai-provider', () => {
  it('admin can update the provider and fallback chain', async () => {
    const admin = await registerUser('admin1@example.com', 'ai-provider-team1');
    const adminCookie = sessionCookie(admin);

    const res = await app.inject({
      method: 'PUT', url: '/system/ai-provider',
      payload: { provider: 'openai', fallbacks: ['gemini', 'anthropic'] },
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ provider: 'openai', fallbacks: ['gemini', 'anthropic'] });

    const get = await app.inject({ method: 'GET', url: '/system/ai-provider' });
    expect(get.json().provider).toBe('openai');
    expect(get.json().fallbacks).toEqual(['gemini', 'anthropic']);
  });

  it('strips the primary provider out of the fallback list', async () => {
    const admin = await registerUser('admin2@example.com', 'ai-provider-team2');
    const adminCookie = sessionCookie(admin);

    const res = await app.inject({
      method: 'PUT', url: '/system/ai-provider',
      payload: { provider: 'gemini', fallbacks: ['gemini', 'openai'] },
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ provider: 'gemini', fallbacks: ['openai'] });
  });

  it('returns 400 for an invalid provider name', async () => {
    const admin = await registerUser('admin3@example.com', 'ai-provider-team3');
    const adminCookie = sessionCookie(admin);

    const res = await app.inject({
      method: 'PUT', url: '/system/ai-provider',
      payload: { provider: 'not-a-provider' },
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 for a non-admin member', async () => {
    const admin = await registerUser('admin4@example.com', 'ai-provider-team4');
    const teamId = admin.json().currentTeamId as string;

    const memberReg = await registerUser('member4@example.com', 'member4-own-team');
    const memberId = memberReg.json().id as string;
    await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, [teamId, memberId]);
    await app.inject({ method: 'POST', url: '/auth/switch-team', payload: { teamId }, headers: { cookie: sessionCookie(memberReg) } });

    const res = await app.inject({
      method: 'PUT', url: '/system/ai-provider',
      payload: { provider: 'openai' },
      headers: { cookie: sessionCookie(memberReg) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 401 with no session', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/system/ai-provider',
      payload: { provider: 'openai' },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ─── GET /system/ai-provider?teamId= (per-team override, AI-15 Phase C) ───────

describe('GET /system/ai-provider?teamId=', () => {
  it('returns the global default with isOverride=false when no team override exists', async () => {
    const admin = await registerUser('teamcfg1@example.com', 'ai-provider-teamcfg1');
    const teamId = admin.json().currentTeamId as string;

    const res = await app.inject({ method: 'GET', url: `/system/ai-provider?teamId=${teamId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe('gemini');
    expect(body.fallbacks).toEqual([]);
    expect(body.isOverride).toBe(false);
  });

  it('returns the team override with isOverride=true when one exists', async () => {
    const admin = await registerUser('teamcfg2@example.com', 'ai-provider-teamcfg2');
    const teamId = admin.json().currentTeamId as string;
    const adminCookie = sessionCookie(admin);

    await app.inject({
      method: 'PUT', url: `/teams/${teamId}/ai-provider`,
      payload: { provider: 'anthropic', fallbacks: ['openai'] },
      headers: { cookie: adminCookie },
    });

    const res = await app.inject({ method: 'GET', url: `/system/ai-provider?teamId=${teamId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe('anthropic');
    expect(body.fallbacks).toEqual(['openai']);
    expect(body.isOverride).toBe(true);
  });
});

// ─── PUT/DELETE /teams/:id/ai-provider (AI-15 Phase C) ─────────────────────────

describe('PUT /teams/:id/ai-provider', () => {
  it('admin can set a per-team override', async () => {
    const admin = await registerUser('teamai1@example.com', 'ai-provider-teamai1');
    const teamId = admin.json().currentTeamId as string;
    const adminCookie = sessionCookie(admin);

    const res = await app.inject({
      method: 'PUT', url: `/teams/${teamId}/ai-provider`,
      payload: { provider: 'openai', fallbacks: ['gemini', 'openai'] },
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.provider).toBe('openai');
    expect(body.fallbacks).toEqual(['gemini']); // primary stripped out of fallbacks
    expect(body.isOverride).toBe(true);
  });

  it('returns 400 for an invalid provider name', async () => {
    const admin = await registerUser('teamai2@example.com', 'ai-provider-teamai2');
    const teamId = admin.json().currentTeamId as string;
    const adminCookie = sessionCookie(admin);

    const res = await app.inject({
      method: 'PUT', url: `/teams/${teamId}/ai-provider`,
      payload: { provider: 'not-a-provider' },
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 for a non-admin member', async () => {
    const admin = await registerUser('teamai3@example.com', 'ai-provider-teamai3');
    const teamId = admin.json().currentTeamId as string;

    const memberReg = await registerUser('memberai3@example.com', 'memberai3-own-team');
    const memberId = memberReg.json().id as string;
    await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, [teamId, memberId]);
    await app.inject({ method: 'POST', url: '/auth/switch-team', payload: { teamId }, headers: { cookie: sessionCookie(memberReg) } });

    const res = await app.inject({
      method: 'PUT', url: `/teams/${teamId}/ai-provider`,
      payload: { provider: 'openai' },
      headers: { cookie: sessionCookie(memberReg) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 403 when :id is not the caller\'s current team', async () => {
    const admin1 = await registerUser('teamai4a@example.com', 'ai-provider-teamai4a');
    const admin2 = await registerUser('teamai4b@example.com', 'ai-provider-teamai4b');
    const otherTeamId = admin2.json().currentTeamId as string;

    const res = await app.inject({
      method: 'PUT', url: `/teams/${otherTeamId}/ai-provider`,
      payload: { provider: 'openai' },
      headers: { cookie: sessionCookie(admin1) },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('DELETE /teams/:id/ai-provider', () => {
  it('admin can clear the team override, reverting to the global default', async () => {
    const admin = await registerUser('teamai5@example.com', 'ai-provider-teamai5');
    const teamId = admin.json().currentTeamId as string;
    const adminCookie = sessionCookie(admin);

    await app.inject({
      method: 'PUT', url: `/teams/${teamId}/ai-provider`,
      payload: { provider: 'anthropic' },
      headers: { cookie: adminCookie },
    });

    const del = await app.inject({
      method: 'DELETE', url: `/teams/${teamId}/ai-provider`,
      headers: { cookie: adminCookie },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ success: true });

    const get = await app.inject({ method: 'GET', url: `/system/ai-provider?teamId=${teamId}` });
    const body = get.json();
    expect(body.provider).toBe('gemini');
    expect(body.isOverride).toBe(false);
  });

  it('returns 403 for a non-admin member', async () => {
    const admin = await registerUser('teamai6@example.com', 'ai-provider-teamai6');
    const teamId = admin.json().currentTeamId as string;

    const memberReg = await registerUser('memberai6@example.com', 'memberai6-own-team');
    const memberId = memberReg.json().id as string;
    await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, [teamId, memberId]);
    await app.inject({ method: 'POST', url: '/auth/switch-team', payload: { teamId }, headers: { cookie: sessionCookie(memberReg) } });

    const res = await app.inject({
      method: 'DELETE', url: `/teams/${teamId}/ai-provider`,
      headers: { cookie: sessionCookie(memberReg) },
    });
    expect(res.statusCode).toBe(403);
  });
});
