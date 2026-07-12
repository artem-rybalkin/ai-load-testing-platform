import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase, truncateAll } from '../../../../test-support/sharedPostgres';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { createSchema } from '../db';
import {
  getStaleRunningMinutes, getStalePendingMinutes,
  getLiveMetricsRetentionDays, getTestResultsRetentionDays, getAuditLogRetentionDays,
  getRateLimitMax, getAiRateLimitMax,
  getCapacityAbortP95Ms, getCapacityAbortErrorRatePct, getCapacityAbortDelaySec,
  setOperationalSetting,
} from '../settings';

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
  await truncateAll(pool, 'TRUNCATE test_results, test_scripts, webhooks, schedules, test_presets, log_sources, sessions, team_api_keys, org_members, organizations, team_members, users, projects, app_settings CASCADE');
});

// ─── settings.ts getters — defaults and DB overrides ───────────────────────────

describe('operational setting getters', () => {
  it('return hardcoded defaults when no row and no env var is set', async () => {
    expect(await getStaleRunningMinutes(pool)).toBe(15);
    expect(await getStalePendingMinutes(pool)).toBe(30);
    expect(await getLiveMetricsRetentionDays(pool)).toBe(30);
    expect(await getTestResultsRetentionDays(pool)).toBe(0);
    expect(await getAuditLogRetentionDays(pool)).toBe(180);
    expect(await getRateLimitMax(pool)).toBe(600);
    expect(await getAiRateLimitMax(pool)).toBe(20);
    expect(await getCapacityAbortP95Ms(pool)).toBe(2000);
    expect(await getCapacityAbortErrorRatePct(pool)).toBe(5);
    expect(await getCapacityAbortDelaySec(pool)).toBe(10);
  });

  it('a DB override takes priority over the default', async () => {
    await setOperationalSetting(pool, 'staleRunningMinutes', 45);
    expect(await getStaleRunningMinutes(pool)).toBe(45);
  });

  it('ignores an invalid stored value and falls back to the default', async () => {
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('rate_limit_max', 'not-a-number')`);
    expect(await getRateLimitMax(pool)).toBe(600);
  });

  it('rejects a non-positive stored value for a positive-only setting', async () => {
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('stale_running_minutes', '0')`);
    expect(await getStaleRunningMinutes(pool)).toBe(15);
  });

  it('accepts 0 as a valid stored value for a non-negative setting (disables auto-purge)', async () => {
    await setOperationalSetting(pool, 'testResultsRetentionDays', 0);
    expect(await getTestResultsRetentionDays(pool)).toBe(0);
  });
});

describe('setOperationalSetting', () => {
  it('upserts on a second call rather than erroring', async () => {
    await setOperationalSetting(pool, 'rateLimitMax', 100);
    await setOperationalSetting(pool, 'rateLimitMax', 200);
    expect(await getRateLimitMax(pool)).toBe(200);

    const { rows } = await pool.query(`SELECT COUNT(*) FROM app_settings WHERE key = 'rate_limit_max'`);
    expect(Number(rows[0].count)).toBe(1);
  });
});

// ─── GET /system/operational-settings ──────────────────────────────────────────

describe('GET /system/operational-settings', () => {
  it('returns 401 with no session', async () => {
    const res = await app.inject({ method: 'GET', url: '/system/operational-settings' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for a non-admin member', async () => {
    const admin = await registerUser('opset-admin1@example.com', 'opset-team1');
    const teamId = admin.json().currentTeamId as string;
    const memberReg = await registerUser('opset-member1@example.com', 'opset-member1-own-team');
    const memberId = memberReg.json().id as string;
    await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, [teamId, memberId]);
    const switched = await app.inject({ method: 'POST', url: '/auth/switch-team', payload: { teamId }, headers: { cookie: sessionCookie(memberReg) } });

    const res = await app.inject({ method: 'GET', url: '/system/operational-settings', headers: { cookie: sessionCookie(switched) } });
    expect(res.statusCode).toBe(403);
  });

  it('returns the defaults for an admin with no prior overrides', async () => {
    const admin = await registerUser('opset-admin2@example.com', 'opset-team2');
    const res = await app.inject({ method: 'GET', url: '/system/operational-settings', headers: { cookie: sessionCookie(admin) } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      staleRunningMinutes: 15, stalePendingMinutes: 30, liveMetricsRetentionDays: 30,
      testResultsRetentionDays: 0, auditLogRetentionDays: 180, rateLimitMax: 600, aiRateLimitMax: 20,
      capacityAbortP95Ms: 2000, capacityAbortErrorRatePct: 5, capacityAbortDelaySec: 10,
    });
  });
});

// ─── PUT /system/operational-settings ──────────────────────────────────────────

describe('PUT /system/operational-settings', () => {
  it('admin can update a subset of settings, leaving the rest at their defaults', async () => {
    const admin = await registerUser('opset-admin3@example.com', 'opset-team3');
    const adminCookie = sessionCookie(admin);

    const res = await app.inject({
      method: 'PUT', url: '/system/operational-settings',
      payload: { staleRunningMinutes: 45, rateLimitMax: 1000 },
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ staleRunningMinutes: 45, rateLimitMax: 1000, stalePendingMinutes: 30 });

    const get = await app.inject({ method: 'GET', url: '/system/operational-settings', headers: { cookie: adminCookie } });
    expect(get.json()).toMatchObject({ staleRunningMinutes: 45, rateLimitMax: 1000 });
  });

  it('returns 400 for a negative value', async () => {
    const admin = await registerUser('opset-admin4@example.com', 'opset-team4');
    const res = await app.inject({
      method: 'PUT', url: '/system/operational-settings',
      payload: { staleRunningMinutes: -5 },
      headers: { cookie: sessionCookie(admin) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for a non-integer value', async () => {
    const admin = await registerUser('opset-admin5@example.com', 'opset-team5');
    const res = await app.inject({
      method: 'PUT', url: '/system/operational-settings',
      payload: { rateLimitMax: 12.5 },
      headers: { cookie: sessionCookie(admin) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for an unknown setting key', async () => {
    const admin = await registerUser('opset-admin6@example.com', 'opset-team6');
    const res = await app.inject({
      method: 'PUT', url: '/system/operational-settings',
      payload: { notARealSetting: 5 },
      headers: { cookie: sessionCookie(admin) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts 0 for testResultsRetentionDays (disables auto-purge)', async () => {
    const admin = await registerUser('opset-admin7@example.com', 'opset-team7');
    const adminCookie = sessionCookie(admin);
    await app.inject({ method: 'PUT', url: '/system/operational-settings', payload: { testResultsRetentionDays: 90 }, headers: { cookie: adminCookie } });

    const res = await app.inject({
      method: 'PUT', url: '/system/operational-settings',
      payload: { testResultsRetentionDays: 0 },
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().testResultsRetentionDays).toBe(0);
  });

  it('returns 403 for a non-admin member', async () => {
    const admin = await registerUser('opset-admin8@example.com', 'opset-team8');
    const teamId = admin.json().currentTeamId as string;
    const memberReg = await registerUser('opset-member8@example.com', 'opset-member8-own-team');
    const memberId = memberReg.json().id as string;
    await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, [teamId, memberId]);
    const switched = await app.inject({ method: 'POST', url: '/auth/switch-team', payload: { teamId }, headers: { cookie: sessionCookie(memberReg) } });

    const res = await app.inject({
      method: 'PUT', url: '/system/operational-settings',
      payload: { rateLimitMax: 100 },
      headers: { cookie: sessionCookie(switched) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 401 with no session', async () => {
    const res = await app.inject({ method: 'PUT', url: '/system/operational-settings', payload: { rateLimitMax: 100 } });
    expect(res.statusCode).toBe(401);
  });

  it('admin can update the capacity-abort thresholds', async () => {
    const admin = await registerUser('opset-admin9@example.com', 'opset-team9');
    const adminCookie = sessionCookie(admin);

    const res = await app.inject({
      method: 'PUT', url: '/system/operational-settings',
      payload: { capacityAbortP95Ms: 3000, capacityAbortErrorRatePct: 8, capacityAbortDelaySec: 20 },
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ capacityAbortP95Ms: 3000, capacityAbortErrorRatePct: 8, capacityAbortDelaySec: 20 });
  });

  it('accepts 0 for capacityAbortErrorRatePct and capacityAbortDelaySec', async () => {
    const admin = await registerUser('opset-admin10@example.com', 'opset-team10');
    const res = await app.inject({
      method: 'PUT', url: '/system/operational-settings',
      payload: { capacityAbortErrorRatePct: 0, capacityAbortDelaySec: 0 },
      headers: { cookie: sessionCookie(admin) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ capacityAbortErrorRatePct: 0, capacityAbortDelaySec: 0 });
  });

  it('returns 400 for a capacityAbortErrorRatePct above 100', async () => {
    const admin = await registerUser('opset-admin11@example.com', 'opset-team11');
    const res = await app.inject({
      method: 'PUT', url: '/system/operational-settings',
      payload: { capacityAbortErrorRatePct: 150 },
      headers: { cookie: sessionCookie(admin) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for a non-positive capacityAbortP95Ms', async () => {
    const admin = await registerUser('opset-admin12@example.com', 'opset-team12');
    const res = await app.inject({
      method: 'PUT', url: '/system/operational-settings',
      payload: { capacityAbortP95Ms: 0 },
      headers: { cookie: sessionCookie(admin) },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── GET /system/capacity-abort ─────────────────────────────────────────────────
// No session required — ai-service (script generation) and api-service
// (cache-hit re-injection) both read this server-to-server.

describe('GET /system/capacity-abort', () => {
  it('returns the hardcoded defaults with no session and no prior setting', async () => {
    const res = await app.inject({ method: 'GET', url: '/system/capacity-abort' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ p95Ms: 2000, errorRatePct: 5, delaySec: 10 });
  });

  it('reflects a previously saved value, still without a session', async () => {
    const admin = await registerUser('opset-admin13@example.com', 'opset-team13');
    await app.inject({
      method: 'PUT', url: '/system/operational-settings',
      payload: { capacityAbortP95Ms: 2500 },
      headers: { cookie: sessionCookie(admin) },
    });

    const res = await app.inject({ method: 'GET', url: '/system/capacity-abort' });
    expect(res.json()).toEqual({ p95Ms: 2500, errorRatePct: 5, delaySec: 10 });
  });
});
