import { Pool } from 'pg';

import { TeamQuota, DEFAULT_TEAM_QUOTA, BackendTestOptions, ClientTestOptions, TestType } from '@alt/shared';
import { realisticProfileMaxVus } from './options';

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

interface TestQuotaCheckInput {
  type: TestType;
  options: BackendTestOptions | ClientTestOptions;
  durationSeconds?: number;
}

/** Returns an error message if the requested test would exceed the team's quota, or null if OK. */
export const checkTestQuota = async (
  pool: Pool,
  teamId: string | undefined,
  { type, options, durationSeconds }: TestQuotaCheckInput
): Promise<string | null> => {
  if (!teamId) return null;

  const quota = await getTeamQuota(pool, teamId);

  const vus = type === 'client-side'
    ? (options as ClientTestOptions).sessions
    : (() => {
        const beOpts = options as BackendTestOptions;
        // 'realistic' submits a req/s rate, not a VU count — check against the
        // arrival-rate executor's actual VU-pool ceiling instead (see options.ts).
        if (beOpts.profile === 'realistic') return realisticProfileMaxVus(beOpts.vus);
        return beOpts.peakVus ?? beOpts.vus;
      })();

  if (vus > quota.maxVusPerTest) {
    return `Requested VUs/sessions (${vus}) exceeds team quota (max ${quota.maxVusPerTest})`;
  }

  if (durationSeconds !== undefined && durationSeconds > quota.maxTestDurationSeconds) {
    return `Requested duration (${durationSeconds}s) exceeds team quota (max ${quota.maxTestDurationSeconds}s)`;
  }

  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) FROM test_results WHERE project_id = $1 AND status IN ('pending','running')`,
    [teamId]
  );
  const concurrent = parseInt(rows[0].count, 10);
  if (concurrent >= quota.maxConcurrentTests) {
    return `Team has reached its concurrent test limit (max ${quota.maxConcurrentTests})`;
  }

  return null;
};
