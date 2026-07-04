import { Pool } from 'pg';

import { TeamQuota, DEFAULT_TEAM_QUOTA, TeamUsage } from '@alt/shared';

export const getTeamQuota = async (pool: Pool, teamId: string): Promise<TeamQuota> => {
  const { rows } = await pool.query<{
    max_concurrent_tests: number;
    max_vus_per_test: number;
    max_test_duration_seconds: number;
    max_scheduled_tests: number;
    max_gemini_calls_per_day: number;
  }>('SELECT * FROM team_quotas WHERE team_id = $1', [teamId]);

  if (rows.length === 0) return { ...DEFAULT_TEAM_QUOTA };

  const row = rows[0];
  return {
    maxConcurrentTests: row.max_concurrent_tests,
    maxVusPerTest: row.max_vus_per_test,
    maxTestDurationSeconds: row.max_test_duration_seconds,
    maxScheduledTests: row.max_scheduled_tests,
    maxGeminiCallsPerDay: row.max_gemini_calls_per_day,
  };
};

export const upsertTeamQuota = async (pool: Pool, teamId: string, updates: Partial<TeamQuota>): Promise<TeamQuota> => {
  const current = await getTeamQuota(pool, teamId);
  const merged: TeamQuota = { ...current, ...updates };

  await pool.query(
    `INSERT INTO team_quotas (team_id, max_concurrent_tests, max_vus_per_test, max_test_duration_seconds, max_scheduled_tests, max_gemini_calls_per_day)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (team_id) DO UPDATE SET
       max_concurrent_tests = $2, max_vus_per_test = $3, max_test_duration_seconds = $4,
       max_scheduled_tests = $5, max_gemini_calls_per_day = $6, updated_at = NOW()`,
    [teamId, merged.maxConcurrentTests, merged.maxVusPerTest, merged.maxTestDurationSeconds, merged.maxScheduledTests, merged.maxGeminiCallsPerDay]
  );

  return merged;
};

/** Returns an error message if creating/enabling another schedule would exceed the team's quota, or null if OK. */
export const checkScheduleQuota = async (pool: Pool, teamId: string | undefined): Promise<string | null> => {
  if (!teamId) return null;

  const quota = await getTeamQuota(pool, teamId);
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) FROM schedules WHERE project_id = $1 AND enabled = TRUE`,
    [teamId]
  );
  const enabled = parseInt(rows[0].count, 10);
  if (enabled >= quota.maxScheduledTests) {
    return `Team has reached its enabled-schedule limit (max ${quota.maxScheduledTests})`;
  }
  return null;
};

/** Returns an error message if the team has exhausted its daily Gemini call quota, or null if OK. */
export const checkGeminiQuota = async (pool: Pool, teamId: string | undefined): Promise<string | null> => {
  if (!teamId) return null;

  const quota = await getTeamQuota(pool, teamId);
  const { rows } = await pool.query<{ call_count: number }>(
    `SELECT call_count FROM gemini_usage WHERE team_id = $1 AND usage_date = CURRENT_DATE`,
    [teamId]
  );
  const used = rows[0]?.call_count ?? 0;
  if (used >= quota.maxGeminiCallsPerDay) {
    return `Team has reached its daily AI quota (max ${quota.maxGeminiCallsPerDay} calls/day)`;
  }
  return null;
};

export const incrementGeminiUsage = async (pool: Pool, teamId: string | undefined): Promise<void> => {
  if (!teamId) return;
  await pool.query(
    `INSERT INTO gemini_usage (team_id, usage_date, call_count) VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (team_id, usage_date) DO UPDATE SET call_count = gemini_usage.call_count + 1`,
    [teamId]
  );
};

/**
 * Batched equivalent of calling getTeamQuota()+getTeamUsage() per team — used by
 * GET /orgs/:id, which previously issued 4 queries per team (N+1) instead of the
 * 4 total queries this does regardless of team count.
 */
export const getTeamQuotasAndUsageBatch = async (
  pool: Pool,
  teamIds: string[],
): Promise<Map<string, { quota: TeamQuota; usage: TeamUsage }>> => {
  if (teamIds.length === 0) return new Map();

  const [quotaRes, concurrentRes, scheduledRes, geminiRes] = await Promise.all([
    pool.query<{
      team_id: string; max_concurrent_tests: number; max_vus_per_test: number;
      max_test_duration_seconds: number; max_scheduled_tests: number; max_gemini_calls_per_day: number;
    }>('SELECT * FROM team_quotas WHERE team_id = ANY($1::uuid[])', [teamIds]),
    pool.query<{ project_id: string; count: string }>(
      `SELECT project_id, COUNT(*) FROM test_results WHERE project_id = ANY($1::uuid[]) AND status IN ('pending','running') GROUP BY project_id`,
      [teamIds],
    ),
    pool.query<{ project_id: string; count: string }>(
      `SELECT project_id, COUNT(*) FROM schedules WHERE project_id = ANY($1::uuid[]) AND enabled = TRUE GROUP BY project_id`,
      [teamIds],
    ),
    pool.query<{ team_id: string; call_count: number }>(
      `SELECT team_id, call_count FROM gemini_usage WHERE team_id = ANY($1::uuid[]) AND usage_date = CURRENT_DATE`,
      [teamIds],
    ),
  ]);

  const quotaByTeam = new Map(quotaRes.rows.map(r => [r.team_id, {
    maxConcurrentTests: r.max_concurrent_tests,
    maxVusPerTest: r.max_vus_per_test,
    maxTestDurationSeconds: r.max_test_duration_seconds,
    maxScheduledTests: r.max_scheduled_tests,
    maxGeminiCallsPerDay: r.max_gemini_calls_per_day,
  } satisfies TeamQuota]));
  const concurrentByTeam = new Map(concurrentRes.rows.map(r => [r.project_id, parseInt(r.count, 10)]));
  const scheduledByTeam  = new Map(scheduledRes.rows.map(r => [r.project_id, parseInt(r.count, 10)]));
  const geminiByTeam     = new Map(geminiRes.rows.map(r => [r.team_id, r.call_count]));

  const result = new Map<string, { quota: TeamQuota; usage: TeamUsage }>();
  for (const teamId of teamIds) {
    result.set(teamId, {
      quota: quotaByTeam.get(teamId) ?? { ...DEFAULT_TEAM_QUOTA },
      usage: {
        concurrentTests: concurrentByTeam.get(teamId) ?? 0,
        scheduledTests: scheduledByTeam.get(teamId) ?? 0,
        geminiCallsToday: geminiByTeam.get(teamId) ?? 0,
      },
    });
  }
  return result;
};

export const getTeamUsage = async (pool: Pool, teamId: string): Promise<TeamUsage> => {
  const [concurrentRes, scheduledRes, geminiRes] = await Promise.all([
    pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM test_results WHERE project_id = $1 AND status IN ('pending','running')`,
      [teamId]
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*) FROM schedules WHERE project_id = $1 AND enabled = TRUE`,
      [teamId]
    ),
    pool.query<{ call_count: number }>(
      `SELECT call_count FROM gemini_usage WHERE team_id = $1 AND usage_date = CURRENT_DATE`,
      [teamId]
    ),
  ]);

  return {
    concurrentTests: parseInt(concurrentRes.rows[0].count, 10),
    scheduledTests: parseInt(scheduledRes.rows[0].count, 10),
    geminiCallsToday: geminiRes.rows[0]?.call_count ?? 0,
  };
};
