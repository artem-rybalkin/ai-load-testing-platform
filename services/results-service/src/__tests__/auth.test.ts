import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { createSchema } from '../db';
import { signSession } from '../session';

vi.mock('../scheduler', () => ({
  reloadSchedule: vi.fn().mockResolvedValue(undefined),
  removeSchedule: vi.fn(),
  startScheduler: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../consumer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../consumer')>();
  return { ...actual, isConsumerConnected: vi.fn().mockReturnValue(true) };
});

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: FastifyInstance;

const SESSION_SECRET = 'test-session-secret-32-chars-min!';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await createSchema(pool);
  process.env.SESSION_SECRET = SESSION_SECRET;
  app = await buildApp(pool);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.SESSION_SECRET;
  await app.close();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE test_results, test_scripts, webhooks, schedules, test_presets, log_sources, projects CASCADE');
});

// ─── POST /auth/login ─────────────────────────────────────────────────────────

describe('POST /auth/login', () => {
  it('returns 400 when username is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { projectName: 'proj' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/username/i);
  });

  it('returns 400 when projectName is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'alice' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/projectName/i);
  });

  it('returns 400 when both fields are whitespace', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: '  ', projectName: '  ' } });
    expect(res.statusCode).toBe(400);
  });

  it('returns the session payload on success', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { username: 'alice', projectName: 'team-alpha' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.username).toBe('alice');
    expect(body.projectName).toBe('team-alpha');
    expect(typeof body.projectId).toBe('string');
    expect(body.projectId.length).toBeGreaterThan(0);
  });

  it('sets an HttpOnly alt_session cookie', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { username: 'bob', projectName: 'demo' },
    });
    const setCookie = res.headers['set-cookie'] as string;
    expect(setCookie).toBeDefined();
    expect(setCookie).toMatch(/alt_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
  });

  it('creates the project once and reuses it on second login', async () => {
    await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'u1', projectName: 'shared-proj' } });
    const res2 = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: 'u2', projectName: 'shared-proj' } });
    const rows = await pool.query(`SELECT id FROM projects WHERE name = 'shared-proj'`);
    expect(rows.rowCount).toBe(1);
    expect(res2.json().projectId).toBe(rows.rows[0].id);
  });
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────

describe('POST /auth/logout', () => {
  it('returns 200 with ok: true', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('clears the alt_session cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/logout' });
    const setCookie = res.headers['set-cookie'] as string;
    expect(setCookie).toMatch(/alt_session=/);
    // Cleared cookie has empty value or MaxAge=0
    expect(setCookie).toMatch(/alt_session=;|Max-Age=0/i);
  });
});

// ─── GET /auth/me ─────────────────────────────────────────────────────────────

describe('GET /auth/me', () => {
  it('returns 401 when no cookie is present', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/Not authenticated/i);
  });

  it('returns the session payload when a valid cookie is present', async () => {
    // Log in to get a real cookie
    const loginRes = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { username: 'carol', projectName: 'my-team' },
    });
    const cookie = (loginRes.headers['set-cookie'] as string).split(';')[0]; // "alt_session=<value>"

    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().username).toBe('carol');
    expect(res.json().projectName).toBe('my-team');
  });

  it('returns 401 when cookie contains a tampered signature', async () => {
    const tampered = 'alt_session=data.badsignature';
    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: tampered } });
    expect(res.statusCode).toBe(401);
  });
});

// ─── Session middleware guards protected routes ───────────────────────────────

describe('Session middleware', () => {
  it('returns 401 on GET /results when SESSION_SECRET is set and no cookie', async () => {
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
      payload: { testId: crypto.randomUUID(), type: 'backend', targetUrl: 'http://x.com' },
    });
    expect(res.statusCode).not.toBe(401);
  });

  it('allows GET /results with a valid session cookie', async () => {
    const loginRes = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { username: 'dave', projectName: 'proj-d' },
    });
    const cookie = (loginRes.headers['set-cookie'] as string).split(';')[0];
    const res = await app.inject({ method: 'GET', url: '/results', headers: { cookie } });
    expect(res.statusCode).toBe(200);
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

  it('POST /auth/login returns a dummy session without setting a cookie', async () => {
    const res = await devApp.inject({
      method: 'POST', url: '/auth/login',
      payload: { username: 'devuser', projectName: 'devproject' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().username).toBe('devuser');
    // No cookie should be set in dev mode
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('GET /auth/me returns a static dev response', async () => {
    const res = await devApp.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(200);
    expect(res.json().username).toBe('dev');
  });

  it('GET /results is accessible without auth in dev mode', async () => {
    const res = await devApp.inject({ method: 'GET', url: '/results' });
    expect(res.statusCode).toBe(200);
  });
});
