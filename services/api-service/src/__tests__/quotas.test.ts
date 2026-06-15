import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase } from '../../../../test-support/sharedPostgres';
import { DEFAULT_TEAM_QUOTA } from '@alt/shared';
import { getTeamQuota, checkTestQuota } from '../quotas';

let pool: Pool;
let dropDb: () => Promise<void>;
let teamId: string;

const createSchema = async (p: Pool): Promise<void> => {
  await p.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await p.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name       TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS team_quotas (
      id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      team_id                    UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
      max_concurrent_tests       INTEGER NOT NULL,
      max_vus_per_test           INTEGER NOT NULL,
      max_test_duration_seconds  INTEGER NOT NULL,
      max_scheduled_tests        INTEGER NOT NULL,
      max_gemini_calls_per_day   INTEGER NOT NULL,
      created_at                 TIMESTAMPTZ DEFAULT NOW(),
      updated_at                 TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS test_results (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      test_id    UUID NOT NULL UNIQUE,
      type       VARCHAR(20) NOT NULL,
      target_url TEXT NOT NULL,
      status     VARCHAR(20) NOT NULL,
      project_id UUID,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
};

const insertTestResult = async (p: Pool, status: string, projectId: string | null): Promise<void> => {
  await p.query(
    `INSERT INTO test_results (test_id, type, target_url, status, project_id) VALUES (gen_random_uuid(), 'backend', 'http://example.com', $1, $2)`,
    [status, projectId]
  );
};

beforeAll(async () => {
  ({ pool, drop: dropDb } = await createTestDatabase());
  await createSchema(pool);
}, 120_000);

afterAll(async () => {
  await dropDb();
});

beforeEach(async () => {
  await pool.query('TRUNCATE test_results, team_quotas, projects CASCADE');
  const teamResult = await pool.query<{ id: string }>(`INSERT INTO projects (name) VALUES ('team-a') RETURNING id`);
  teamId = teamResult.rows[0].id;
});

describe('getTeamQuota', () => {
  it('returns DEFAULT_TEAM_QUOTA when no row exists', async () => {
    const quota = await getTeamQuota(pool, teamId);
    expect(quota).toEqual(DEFAULT_TEAM_QUOTA);
  });

  it('returns the team-specific overrides when a row exists', async () => {
    await pool.query(
      `INSERT INTO team_quotas (team_id, max_concurrent_tests, max_vus_per_test, max_test_duration_seconds, max_scheduled_tests, max_gemini_calls_per_day)
       VALUES ($1, 1, 50, 60, 2, 5)`,
      [teamId]
    );
    const quota = await getTeamQuota(pool, teamId);
    expect(quota).toEqual({
      maxConcurrentTests: 1,
      maxVusPerTest: 50,
      maxTestDurationSeconds: 60,
      maxScheduledTests: 2,
      maxGeminiCallsPerDay: 5,
    });
  });
});

describe('checkTestQuota', () => {
  it('bypasses all checks when teamId is undefined', async () => {
    const result = await checkTestQuota(pool, undefined, {
      type: 'backend',
      options: { vus: 999999, duration: '10h' },
      durationSeconds: 999999,
    });
    expect(result).toBeNull();
  });

  it('returns null when within all limits', async () => {
    const result = await checkTestQuota(pool, teamId, {
      type: 'backend',
      options: { vus: 10, duration: '1m' },
      durationSeconds: 60,
    });
    expect(result).toBeNull();
  });

  it('returns an error when VUs exceed maxVusPerTest', async () => {
    await pool.query(
      `INSERT INTO team_quotas (team_id, max_concurrent_tests, max_vus_per_test, max_test_duration_seconds, max_scheduled_tests, max_gemini_calls_per_day)
       VALUES ($1, 5, 50, 3600, 10, 100)`,
      [teamId]
    );
    const result = await checkTestQuota(pool, teamId, {
      type: 'backend',
      options: { vus: 100, duration: '1m' },
      durationSeconds: 60,
    });
    expect(result).toMatch(/VUs/);
  });

  it('uses sessions for client-side tests', async () => {
    await pool.query(
      `INSERT INTO team_quotas (team_id, max_concurrent_tests, max_vus_per_test, max_test_duration_seconds, max_scheduled_tests, max_gemini_calls_per_day)
       VALUES ($1, 5, 10, 3600, 10, 100)`,
      [teamId]
    );
    const result = await checkTestQuota(pool, teamId, {
      type: 'client-side',
      options: { sessions: 20, duration: '1m', collectWebVitals: false },
      durationSeconds: 60,
    });
    expect(result).toMatch(/VUs\/sessions/);
  });

  it('returns an error when duration exceeds maxTestDurationSeconds', async () => {
    await pool.query(
      `INSERT INTO team_quotas (team_id, max_concurrent_tests, max_vus_per_test, max_test_duration_seconds, max_scheduled_tests, max_gemini_calls_per_day)
       VALUES ($1, 5, 1000, 120, 10, 100)`,
      [teamId]
    );
    const result = await checkTestQuota(pool, teamId, {
      type: 'backend',
      options: { vus: 10, duration: '5m' },
      durationSeconds: 300,
    });
    expect(result).toMatch(/duration/);
  });

  it('returns an error when concurrent tests reach maxConcurrentTests', async () => {
    await pool.query(
      `INSERT INTO team_quotas (team_id, max_concurrent_tests, max_vus_per_test, max_test_duration_seconds, max_scheduled_tests, max_gemini_calls_per_day)
       VALUES ($1, 1, 1000, 3600, 10, 100)`,
      [teamId]
    );
    await insertTestResult(pool, 'running', teamId);

    const result = await checkTestQuota(pool, teamId, {
      type: 'backend',
      options: { vus: 10, duration: '1m' },
      durationSeconds: 60,
    });
    expect(result).toMatch(/concurrent test limit/);
  });

  it('does not count other teams concurrent tests', async () => {
    const otherTeam = await pool.query<{ id: string }>(`INSERT INTO projects (name) VALUES ('team-b') RETURNING id`);
    await pool.query(
      `INSERT INTO team_quotas (team_id, max_concurrent_tests, max_vus_per_test, max_test_duration_seconds, max_scheduled_tests, max_gemini_calls_per_day)
       VALUES ($1, 1, 1000, 3600, 10, 100)`,
      [teamId]
    );
    await insertTestResult(pool, 'running', otherTeam.rows[0].id);

    const result = await checkTestQuota(pool, teamId, {
      type: 'backend',
      options: { vus: 10, duration: '1m' },
      durationSeconds: 60,
    });
    expect(result).toBeNull();
  });
});
