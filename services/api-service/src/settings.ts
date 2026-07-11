import { Pool } from 'pg';

/**
 * Admin-configurable request cap for @fastify/rate-limit (requests/min/IP).
 * Reads the same app_settings row results-service's Settings page writes to
 * (both services share one Postgres DB) — falls back to the RATE_LIMIT_MAX
 * env var, then a hardcoded default, so an unconfigured deployment is
 * unaffected. See results-service/src/settings.ts for the write side.
 */
export const getRateLimitMax = async (pool: Pool): Promise<number> => {
  // A transient DB hiccup (or, in tests, a mocked pool with no real .query())
  // must not 500 an otherwise-normal request — fail open to the env var /
  // hardcoded default instead, same as @fastify/rate-limit's own skipOnError.
  // A plain try/catch (not a .catch() chained onto the query call) is
  // required to also cover a synchronous throw from pool.query itself.
  try {
    const { rows } = await pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'rate_limit_max'`);
    if (rows.length > 0) {
      const n = Number(rows[0].value);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch { /* fall through to env var / default below */ }
  const envN = Number(process.env.RATE_LIMIT_MAX);
  return Number.isFinite(envN) && envN > 0 ? envN : 600;
};
