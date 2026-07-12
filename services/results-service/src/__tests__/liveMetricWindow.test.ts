import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase, truncateAll } from '../../../../test-support/sharedPostgres';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { createSchema } from '../db';
import { getLiveMetricWindowSetting, setLiveMetricWindowSetting } from '../settings';

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

// ─── settings.ts — getLiveMetricWindowSetting / setLiveMetricWindowSetting ────

describe('getLiveMetricWindowSetting', () => {
  it('returns the default (30) when no row exists', async () => {
    expect(await getLiveMetricWindowSetting(pool)).toBe(30);
  });

  it('returns the stored value after set', async () => {
    await setLiveMetricWindowSetting(pool, 10);
    expect(await getLiveMetricWindowSetting(pool)).toBe(10);
  });

  it('falls back to the default for a corrupted/invalid stored value', async () => {
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('live_metric_window_sec', 'not-a-number')`
    );
    expect(await getLiveMetricWindowSetting(pool)).toBe(30);
  });

  it('falls back to the default for a stored value outside the allowed set', async () => {
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('live_metric_window_sec', '45')`
    );
    expect(await getLiveMetricWindowSetting(pool)).toBe(30);
  });
});

describe('setLiveMetricWindowSetting', () => {
  it('upserts on a second call rather than erroring', async () => {
    await setLiveMetricWindowSetting(pool, 10);
    await setLiveMetricWindowSetting(pool, 60);
    expect(await getLiveMetricWindowSetting(pool)).toBe(60);

    const { rows } = await pool.query(`SELECT COUNT(*) FROM app_settings WHERE key = 'live_metric_window_sec'`);
    expect(Number(rows[0].count)).toBe(1);
  });
});

// ─── GET /system/live-metric-window ───────────────────────────────────────────

describe('GET /system/live-metric-window', () => {
  it('returns the default with no session and no prior setting', async () => {
    const res = await app.inject({ method: 'GET', url: '/system/live-metric-window' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ windowSec: 30 });
  });

  it('reflects a previously saved value', async () => {
    await setLiveMetricWindowSetting(pool, 30);
    const res = await app.inject({ method: 'GET', url: '/system/live-metric-window' });
    expect(res.json()).toEqual({ windowSec: 30 });
  });
});

// ─── PUT /system/live-metric-window ───────────────────────────────────────────

describe('PUT /system/live-metric-window', () => {
  it('admin can update the window', async () => {
    const admin = await registerUser('lmw-admin1@example.com', 'lmw-team1');
    const adminCookie = sessionCookie(admin);

    const res = await app.inject({
      method: 'PUT', url: '/system/live-metric-window',
      payload: { windowSec: 60 },
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ windowSec: 60 });

    const get = await app.inject({ method: 'GET', url: '/system/live-metric-window' });
    expect(get.json()).toEqual({ windowSec: 60 });
  });

  it('returns 400 for a value outside the allowed set (10/30/60)', async () => {
    const admin = await registerUser('lmw-admin2@example.com', 'lmw-team2');
    const adminCookie = sessionCookie(admin);

    const res = await app.inject({
      method: 'PUT', url: '/system/live-metric-window',
      payload: { windowSec: 45 },
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 for a non-admin member', async () => {
    const admin = await registerUser('lmw-admin3@example.com', 'lmw-team3');
    const teamId = admin.json().currentTeamId as string;

    const memberReg = await registerUser('lmw-member3@example.com', 'lmw-member3-own-team');
    const memberId = memberReg.json().id as string;
    await pool.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, [teamId, memberId]);
    const switched = await app.inject({ method: 'POST', url: '/auth/switch-team', payload: { teamId }, headers: { cookie: sessionCookie(memberReg) } });

    const res = await app.inject({
      method: 'PUT', url: '/system/live-metric-window',
      payload: { windowSec: 60 },
      headers: { cookie: sessionCookie(switched) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 401 with no session', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/system/live-metric-window',
      payload: { windowSec: 60 },
    });
    expect(res.statusCode).toBe(401);
  });
});
