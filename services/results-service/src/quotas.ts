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

  const row = rows[0]!; // guarded by rows.length === 0 above
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
  const enabled = parseInt(rows[0]!.count, 10); // COUNT(*) with no GROUP BY always returns exactly one row
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
 * Atomically check the daily Gemini quota AND record usage in a single SQL
 * statement.  Returns null when the call is allowed (usage already recorded),
 * or an error string when the team has reached its limit.
 *
 * Use this instead of the two-step checkGeminiQuota + incrementGeminiUsage
 * pattern in concurrent /ai/* request handlers — separating the two queries
 * creates a check-then-act race that lets concurrent requests all read the
 * same pre-increment count and all slip through together.
 */
export const checkAndIncrementGeminiUsage = async (pool: Pool, teamId: string | undefined): Promise<string | null> => {
  if (!teamId) return null;

  const quota = await getTeamQuota(pool, teamId);
  const limit = quota.maxGeminiCallsPerDay;

  // INSERT the first row of the day (call_count=1).
  // On conflict, increment ONLY when the current count is still under the
  // limit — the conditional WHERE means no row is returned when the limit
  // is already reached, which we treat as the over-quota signal.
  const { rows } = await pool.query<{ call_count: number }>(
    `INSERT INTO gemini_usage (team_id, usage_date, call_count)
     VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (team_id, usage_date) DO UPDATE
       SET call_count = gemini_usage.call_count + 1
       WHERE gemini_usage.call_count < $2
     RETURNING call_count`,
    [teamId, limit],
  );

  if (rows.length === 0) {
    // ON CONFLICT path: WHERE condition failed — already at or over the limit.
    return `Team has reached its daily AI quota (max ${limit} calls/day)`;
  }

  // INSERT path (first call of the day): call_count is now 1.
  // Guard against the edge case where the configured limit is 0.
  if (rows[0]!.call_count > limit) { // guarded by the rows.length === 0 check above
    return `Team has reached its daily AI quota (max ${limit} calls/day)`;
  }

  return null;
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
    concurrentTests: parseInt(concurrentRes.rows[0]!.count, 10), // COUNT(*) with no GROUP BY always returns exactly one row
    scheduledTests: parseInt(scheduledRes.rows[0]!.count, 10), // COUNT(*) with no GROUP BY always returns exactly one row
    geminiCallsToday: geminiRes.rows[0]?.call_count ?? 0,
  };
};
