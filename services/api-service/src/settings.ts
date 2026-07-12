import { Pool } from 'pg';

/**
 * Reads the same app_settings row results-service's Settings page writes to
 * (both services share one Postgres DB) — falls back to envVar, then
 * fallback, so an unconfigured deployment is unaffected. A transient DB
 * hiccup (or, in tests, a mocked pool with no real .query()) must not 500 an
 * otherwise-normal request — fail open instead, same as @fastify/rate-limit's
 * own skipOnError. A plain try/catch (not a .catch() chained onto the query
 * call) is required to also cover a synchronous throw from pool.query itself.
 * See results-service/src/settings.ts for the write side.
 */
const getNumberSetting = async (pool: Pool, key: string, envVar: string | undefined, fallback: number, isValid: (n: number) => boolean): Promise<number> => {
  try {
    const { rows } = await pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = $1`, [key]);
    if (rows.length > 0) {
      const n = Number(rows[0]!.value); // guarded by rows.length > 0 above
      if (isValid(n)) return n;
    }
  } catch { /* fall through to env var / default below */ }
  const envN = Number(envVar);
  return isValid(envN) ? envN : fallback;
};

const POSITIVE = (n: number): boolean => Number.isFinite(n) && n > 0;
const NON_NEGATIVE = (n: number): boolean => Number.isFinite(n) && n >= 0;

/** Admin-configurable request cap for @fastify/rate-limit (requests/min/IP). */
export const getRateLimitMax = (pool: Pool): Promise<number> =>
  getNumberSetting(pool, 'rate_limit_max', process.env.RATE_LIMIT_MAX, 600, POSITIVE);

export interface CapacityAbortConfig {
  p95Ms: number;
  errorRatePct: number;
  delaySec: number;
}

/**
 * Capacity/stress profile's abortOnFail thresholds — read at cache-hit
 * re-injection time (buildK6Options) so an admin-edited value takes effect
 * on the next test without a redeploy. See results-service/src/settings.ts
 * (getCapacityAbortP95Ms/ErrorRatePct/DelaySec) for the defaults/write side —
 * kept in sync here since api-service has its own DB pool, not an HTTP call.
 */
export const getCapacityAbortConfig = async (pool: Pool): Promise<CapacityAbortConfig> => {
  const [p95Ms, errorRatePct, delaySec] = await Promise.all([
    getNumberSetting(pool, 'capacity_abort_p95_ms', process.env.CAPACITY_ABORT_P95_MS, 2000, POSITIVE),
    getNumberSetting(pool, 'capacity_abort_error_rate_pct', process.env.CAPACITY_ABORT_ERROR_RATE_PCT, 5, NON_NEGATIVE),
    getNumberSetting(pool, 'capacity_abort_delay_sec', process.env.CAPACITY_ABORT_DELAY_SEC, 10, NON_NEGATIVE),
  ]);
  return { p95Ms, errorRatePct, delaySec };
};
