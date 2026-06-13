import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { DEFAULT_TEAM_QUOTA } from '@alt/shared';
import { createSchema } from '../db';
import {
  getTeamQuota, upsertTeamQuota, checkScheduleQuota,
  checkGeminiQuota, incrementGeminiUsage, getTeamUsage,
} from '../quotas';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let teamId: string;

const insertTestResult = async (status: string, projectId: string): Promise<void> => {
  await pool.query(
    `INSERT INTO test_results (test_id, type, target_url, status, project_id) VALUES (gen_random_uuid(), 'backend', 'http://example.com', $1, $2)`,
    [status, projectId]
  );
};

const insertSchedule = async (projectId: string, enabled: boolean): Promise<void> => {
  await pool.query(
    `INSERT INTO schedules (name, cron, type, target_url, options, enabled, project_id) VALUES ('s', '* * * * *', 'backend', 'http://example.com', '{}', $1, $2)`,
    [enabled, projectId]
  );
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await createSchema(pool);
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE gemini_usage, team_quotas, schedules, test_results, projects CASCADE');
  const teamResult = await pool.query<{ id: string }>(`INSERT INTO projects (name) VALUES ('team-a') RETURNING id`);
  teamId = teamResult.rows[0].id;
});

describe('getTeamQuota', () => {
  it('returns DEFAULT_TEAM_QUOTA when no row exists', async () => {
    expect(await getTeamQuota(pool, teamId)).toEqual(DEFAULT_TEAM_QUOTA);
  });

  it('returns the team-specific overrides when a row exists', async () => {
    await pool.query(
      `INSERT INTO team_quotas (team_id, max_concurrent_tests, max_vus_per_test, max_test_duration_seconds, max_scheduled_tests, max_gemini_calls_per_day)
       VALUES ($1, 1, 50, 60, 2, 5)`,
      [teamId]
    );
    expect(await getTeamQuota(pool, teamId)).toEqual({
      maxConcurrentTests: 1,
      maxVusPerTest: 50,
      maxTestDurationSeconds: 60,
      maxScheduledTests: 2,
      maxGeminiCallsPerDay: 5,
    });
  });
});

describe('upsertTeamQuota', () => {
  it('creates a row with merged defaults when none exists', async () => {
    const result = await upsertTeamQuota(pool, teamId, { maxConcurrentTests: 2 });
    expect(result).toEqual({ ...DEFAULT_TEAM_QUOTA, maxConcurrentTests: 2 });
    expect(await getTeamQuota(pool, teamId)).toEqual(result);
  });

  it('merges partial updates over the existing row', async () => {
    await upsertTeamQuota(pool, teamId, { maxConcurrentTests: 2, maxVusPerTest: 200 });
    const result = await upsertTeamQuota(pool, teamId, { maxVusPerTest: 500 });
    expect(result).toEqual({ ...DEFAULT_TEAM_QUOTA, maxConcurrentTests: 2, maxVusPerTest: 500 });
    expect(await getTeamQuota(pool, teamId)).toEqual(result);
  });
});

describe('checkScheduleQuota', () => {
  it('bypasses when teamId is undefined', async () => {
    expect(await checkScheduleQuota(pool, undefined)).toBeNull();
  });

  it('returns null when within the enabled-schedule limit', async () => {
    await upsertTeamQuota(pool, teamId, { maxScheduledTests: 2 });
    await insertSchedule(teamId, true);
    expect(await checkScheduleQuota(pool, teamId)).toBeNull();
  });

  it('returns an error when enabled schedules reach maxScheduledTests', async () => {
    await upsertTeamQuota(pool, teamId, { maxScheduledTests: 1 });
    await insertSchedule(teamId, true);
    const result = await checkScheduleQuota(pool, teamId);
    expect(result).toMatch(/enabled-schedule limit/);
  });

  it('does not count disabled schedules', async () => {
    await upsertTeamQuota(pool, teamId, { maxScheduledTests: 1 });
    await insertSchedule(teamId, false);
    expect(await checkScheduleQuota(pool, teamId)).toBeNull();
  });
});

describe('checkGeminiQuota / incrementGeminiUsage', () => {
  it('bypasses when teamId is undefined', async () => {
    expect(await checkGeminiQuota(pool, undefined)).toBeNull();
    await incrementGeminiUsage(pool, undefined);
  });

  it('returns null and tracks usage as calls are made', async () => {
    await upsertTeamQuota(pool, teamId, { maxGeminiCallsPerDay: 2 });

    expect(await checkGeminiQuota(pool, teamId)).toBeNull();
    await incrementGeminiUsage(pool, teamId);

    expect(await checkGeminiQuota(pool, teamId)).toBeNull();
    await incrementGeminiUsage(pool, teamId);

    const result = await checkGeminiQuota(pool, teamId);
    expect(result).toMatch(/daily AI quota/);
  });

  it('rolls over per-day usage (does not count usage from other dates)', async () => {
    await upsertTeamQuota(pool, teamId, { maxGeminiCallsPerDay: 1 });
    await pool.query(
      `INSERT INTO gemini_usage (team_id, usage_date, call_count) VALUES ($1, CURRENT_DATE - INTERVAL '1 day', 5)`,
      [teamId]
    );
    expect(await checkGeminiQuota(pool, teamId)).toBeNull();
  });
});

describe('getTeamUsage', () => {
  it('returns zeroed usage for a fresh team', async () => {
    expect(await getTeamUsage(pool, teamId)).toEqual({
      concurrentTests: 0,
      scheduledTests: 0,
      geminiCallsToday: 0,
    });
  });

  it('aggregates concurrent tests, enabled schedules, and gemini calls today', async () => {
    await insertTestResult('running', teamId);
    await insertTestResult('pending', teamId);
    await insertTestResult('completed', teamId);
    await insertSchedule(teamId, true);
    await insertSchedule(teamId, false);
    await incrementGeminiUsage(pool, teamId);
    await incrementGeminiUsage(pool, teamId);

    expect(await getTeamUsage(pool, teamId)).toEqual({
      concurrentTests: 2,
      scheduledTests: 1,
      geminiCallsToday: 2,
    });
  });

  it('does not count other teams usage', async () => {
    const otherTeam = await pool.query<{ id: string }>(`INSERT INTO projects (name) VALUES ('team-b') RETURNING id`);
    await insertTestResult('running', otherTeam.rows[0].id);
    await insertSchedule(otherTeam.rows[0].id, true);
    await incrementGeminiUsage(pool, otherTeam.rows[0].id);

    expect(await getTeamUsage(pool, teamId)).toEqual({
      concurrentTests: 0,
      scheduledTests: 0,
      geminiCallsToday: 0,
    });
  });
});
