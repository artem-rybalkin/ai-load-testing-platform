import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { createSchema } from '../db';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await createSchema(pool);
  app = await buildApp(pool);
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE live_metrics, test_results, test_scripts CASCADE');
});

// ─── POST /results/pending ────────────────────────────────────────────────────

describe('POST /results/pending', () => {
  it('creates a record with status pending', async () => {
    const testId = '00000000-0000-0000-0000-000000000001';
    const res = await app.inject({
      method: 'POST',
      url: '/results/pending',
      payload: { testId, type: 'backend', targetUrl: 'http://example.com' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    const { rows } = await pool.query(
      'SELECT status FROM test_results WHERE test_id = $1',
      [testId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
  });

  it('is idempotent — duplicate testId does not throw', async () => {
    const testId = '00000000-0000-0000-0000-000000000002';
    const payload = { testId, type: 'backend', targetUrl: 'http://example.com' };

    await app.inject({ method: 'POST', url: '/results/pending', payload });
    const res = await app.inject({ method: 'POST', url: '/results/pending', payload });

    expect(res.statusCode).toBe(200);
  });
});

// ─── GET /results/active ──────────────────────────────────────────────────────

describe('GET /results/active', () => {
  it('returns only pending and running tests', async () => {
    const ids = {
      pending: '00000000-0000-0000-0000-000000000010',
      running: '00000000-0000-0000-0000-000000000011',
      completed: '00000000-0000-0000-0000-000000000012',
    };

    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status) VALUES
       ($1, 'backend', 'http://a.com', 'pending'),
       ($2, 'backend', 'http://b.com', 'running'),
       ($3, 'backend', 'http://c.com', 'completed')`,
      [ids.pending, ids.running, ids.completed]
    );

    const res = await app.inject({ method: 'GET', url: '/results/active' });

    expect(res.statusCode).toBe(200);
    const { active } = res.json();
    const returnedIds = active.map((r: { test_id: string }) => r.test_id);
    expect(returnedIds).toContain(ids.pending);
    expect(returnedIds).toContain(ids.running);
    expect(returnedIds).not.toContain(ids.completed);
  });
});

// ─── GET /results/:testId ─────────────────────────────────────────────────────

describe('GET /results/:testId', () => {
  it('returns 404 when testId does not exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/results/00000000-0000-0000-0000-000000000099',
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns the result when it exists', async () => {
    const testId = '00000000-0000-0000-0000-000000000020';
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status) VALUES ($1, 'backend', 'http://x.com', 'completed')`,
      [testId]
    );

    const res = await app.inject({ method: 'GET', url: `/results/${testId}` });

    expect(res.statusCode).toBe(200);
    expect(res.json().result.test_id).toBe(testId);
  });
});

// ─── POST /results/:testId/live ───────────────────────────────────────────────

describe('POST /results/:testId/live', () => {
  it('saves a live metric point', async () => {
    const testId = '00000000-0000-0000-0000-000000000030';
    const point = {
      timestamp: new Date().toISOString(),
      vus: 10,
      rps: 5.5,
      avgResponseTime: 120,
      errorRate: 0,
    };

    const res = await app.inject({
      method: 'POST',
      url: `/results/${testId}/live`,
      payload: point,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    const { rows } = await pool.query(
      'SELECT vus, rps FROM live_metrics WHERE test_id = $1',
      [testId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].vus).toBe(10);
    expect(parseFloat(rows[0].rps)).toBeCloseTo(5.5, 1);
  });
});

// ─── GET /results/:testId/live ────────────────────────────────────────────────

describe('GET /results/:testId/live', () => {
  it('returns points in chronological order', async () => {
    const testId = '00000000-0000-0000-0000-000000000040';
    const t1 = '2024-01-01T00:00:01.000Z';
    const t2 = '2024-01-01T00:00:02.000Z';
    const t3 = '2024-01-01T00:00:03.000Z';

    await pool.query(
      `INSERT INTO live_metrics (test_id, timestamp, vus, rps, avg_response_time, error_rate) VALUES
       ($1, $4, 5, 2, 100, 0),
       ($1, $2, 8, 4, 150, 0),
       ($1, $3, 10, 6, 200, 1)`,
      [testId, t2, t3, t1]
    );

    const res = await app.inject({ method: 'GET', url: `/results/${testId}/live` });

    expect(res.statusCode).toBe(200);
    const { points } = res.json();
    expect(points).toHaveLength(3);
    expect(new Date(points[0].timestamp) <= new Date(points[1].timestamp)).toBe(true);
    expect(new Date(points[1].timestamp) <= new Date(points[2].timestamp)).toBe(true);
  });
});

// ─── DELETE /scripts/:id ──────────────────────────────────────────────────────

describe('DELETE /scripts/:id', () => {
  it('deletes the script record', async () => {
    const { rows } = await pool.query(
      `INSERT INTO test_scripts (target_url, test_type, script)
       VALUES ('http://delete-me.com', 'backend', 'export default function(){}')
       RETURNING id`
    );
    const id: string = rows[0].id;

    const res = await app.inject({ method: 'DELETE', url: `/scripts/${id}` });

    expect(res.statusCode).toBe(204);

    const { rows: after } = await pool.query(
      'SELECT id FROM test_scripts WHERE id = $1',
      [id]
    );
    expect(after).toHaveLength(0);
  });
});
