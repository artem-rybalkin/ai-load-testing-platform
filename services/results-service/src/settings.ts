import { Pool } from 'pg';
import { AiProviderSetting, AiProviderName, AI_PROVIDER_NAMES, DEFAULT_AI_PROVIDER_SETTING, LiveMetricWindowSec, DEFAULT_LIVE_METRIC_WINDOW_SEC } from '@alt/shared';

const LIVE_METRIC_WINDOW_VALUES: LiveMetricWindowSec[] = [10, 30, 60];

export async function getAiProviderSetting(pool: Pool): Promise<AiProviderSetting> {
  const { rows } = await pool.query<{ value: string }>(
    `SELECT value FROM app_settings WHERE key = 'ai_provider'`
  );
  if (rows.length === 0) return DEFAULT_AI_PROVIDER_SETTING;
  try {
    const parsed = JSON.parse(rows[0].value) as { provider?: unknown; fallbacks?: unknown };
    const provider: AiProviderName = AI_PROVIDER_NAMES.includes(parsed.provider as AiProviderName) ? (parsed.provider as AiProviderName) : 'gemini';
    const fallbacks: AiProviderName[] = Array.isArray(parsed.fallbacks)
      ? parsed.fallbacks.filter((f: unknown): f is AiProviderName => AI_PROVIDER_NAMES.includes(f as AiProviderName))
      : [];
    return { provider, fallbacks };
  } catch {
    return DEFAULT_AI_PROVIDER_SETTING;
  }
}

export async function setAiProviderSetting(pool: Pool, setting: AiProviderSetting): Promise<void> {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('ai_provider', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [JSON.stringify(setting)]
  );
}

export async function getTeamAiProviderSetting(pool: Pool, teamId: string): Promise<AiProviderSetting | null> {
  const { rows } = await pool.query<{ provider: string; fallbacks: string[] }>(
    `SELECT provider, fallbacks FROM team_ai_providers WHERE team_id = $1`,
    [teamId]
  );
  if (rows.length === 0) return null;
  const provider: AiProviderName = AI_PROVIDER_NAMES.includes(rows[0].provider as AiProviderName)
    ? (rows[0].provider as AiProviderName)
    : 'gemini';
  const fallbacks: AiProviderName[] = Array.isArray(rows[0].fallbacks)
    ? rows[0].fallbacks.filter((f): f is AiProviderName => AI_PROVIDER_NAMES.includes(f as AiProviderName))
    : [];
  return { provider, fallbacks };
}

export async function setTeamAiProviderSetting(pool: Pool, teamId: string, setting: AiProviderSetting): Promise<void> {
  await pool.query(
    `INSERT INTO team_ai_providers (team_id, provider, fallbacks, updated_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (team_id) DO UPDATE SET provider = $2, fallbacks = $3, updated_at = NOW()`,
    [teamId, setting.provider, setting.fallbacks]
  );
}

export async function clearTeamAiProviderSetting(pool: Pool, teamId: string): Promise<void> {
  await pool.query(`DELETE FROM team_ai_providers WHERE team_id = $1`, [teamId]);
}

export async function getEffectiveAiProviderSetting(pool: Pool, teamId?: string | null): Promise<AiProviderSetting> {
  if (teamId) {
    const teamSetting = await getTeamAiProviderSetting(pool, teamId);
    if (teamSetting) return teamSetting;
  }
  return getAiProviderSetting(pool);
}

/** Global live-metrics chart aggregation window (admin-configurable, applies to new tests only). */
export async function getLiveMetricWindowSetting(pool: Pool): Promise<LiveMetricWindowSec> {
  const { rows } = await pool.query<{ value: string }>(
    `SELECT value FROM app_settings WHERE key = 'live_metric_window_sec'`
  );
  if (rows.length === 0) return DEFAULT_LIVE_METRIC_WINDOW_SEC;
  const parsed = Number(rows[0].value);
  return LIVE_METRIC_WINDOW_VALUES.includes(parsed as LiveMetricWindowSec)
    ? (parsed as LiveMetricWindowSec)
    : DEFAULT_LIVE_METRIC_WINDOW_SEC;
}

export async function setLiveMetricWindowSetting(pool: Pool, windowSec: LiveMetricWindowSec): Promise<void> {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('live_metric_window_sec', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [String(windowSec)]
  );
}

// ── Operational knobs (retention/GDPR + rate limits) ────────────────────────
// Previously env-var-only, requiring a redeploy to change. Same
// app_settings-backed pattern as the live-metric-window setting above: a DB
// override takes priority, falling back to the env var (so existing
// deployments need no config change), falling back to a hardcoded default.

const OPERATIONAL_SETTING_KEYS = {
  staleRunningMinutes: 'stale_running_minutes',
  stalePendingMinutes: 'stale_pending_minutes',
  liveMetricsRetentionDays: 'live_metrics_retention_days',
  testResultsRetentionDays: 'test_results_retention_days',
  auditLogRetentionDays: 'audit_log_retention_days',
  rateLimitMax: 'rate_limit_max',
  aiRateLimitMax: 'ai_rate_limit_max',
  capacityAbortP95Ms: 'capacity_abort_p95_ms',
  capacityAbortErrorRatePct: 'capacity_abort_error_rate_pct',
  capacityAbortDelaySec: 'capacity_abort_delay_sec',
} as const;

export type OperationalSettingKey = keyof typeof OPERATIONAL_SETTING_KEYS;

const POSITIVE = (n: number): boolean => Number.isFinite(n) && n > 0;
const NON_NEGATIVE = (n: number): boolean => Number.isFinite(n) && n >= 0;

async function getNumberSetting(
  pool: Pool,
  key: string,
  envVar: string | undefined,
  fallback: number,
  isValid: (n: number) => boolean,
): Promise<number> {
  // A transient DB hiccup here (e.g. this happens on the hot path of
  // @fastify/rate-limit's async `max`) must not 500 an otherwise-normal
  // request — fail open to the env var / hardcoded default instead. A plain
  // try/catch (not a .catch() chained onto the query call) is required to
  // also cover a synchronous throw from pool.query itself.
  try {
    const { rows } = await pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = $1`, [key]);
    if (rows.length > 0) {
      const n = Number(rows[0].value);
      if (isValid(n)) return n;
    }
  } catch { /* fall through to env var / default below */ }
  const envN = Number(envVar);
  return isValid(envN) ? envN : fallback;
}

export const getStaleRunningMinutes = (pool: Pool): Promise<number> =>
  getNumberSetting(pool, OPERATIONAL_SETTING_KEYS.staleRunningMinutes, process.env.STALE_RUNNING_MINUTES, 15, POSITIVE);
export const getStalePendingMinutes = (pool: Pool): Promise<number> =>
  getNumberSetting(pool, OPERATIONAL_SETTING_KEYS.stalePendingMinutes, process.env.STALE_PENDING_MINUTES, 30, POSITIVE);
/** Live-metrics row retention, in days. */
export const getLiveMetricsRetentionDays = (pool: Pool): Promise<number> =>
  getNumberSetting(pool, OPERATIONAL_SETTING_KEYS.liveMetricsRetentionDays, process.env.LIVE_METRICS_RETENTION_DAYS, 30, POSITIVE);
/** GDPR auto-purge of test_results, in days. 0 disables auto-purge (the default). */
export const getTestResultsRetentionDays = (pool: Pool): Promise<number> =>
  getNumberSetting(pool, OPERATIONAL_SETTING_KEYS.testResultsRetentionDays, process.env.TEST_RESULTS_RETENTION_DAYS, 0, NON_NEGATIVE);
/** audit_log row retention, in days. 0 disables auto-purge. */
export const getAuditLogRetentionDays = (pool: Pool): Promise<number> =>
  getNumberSetting(pool, OPERATIONAL_SETTING_KEYS.auditLogRetentionDays, process.env.AUDIT_LOG_RETENTION_DAYS, 180, NON_NEGATIVE);
/** Global @fastify/rate-limit request cap, requests/min/IP. */
export const getRateLimitMax = (pool: Pool): Promise<number> =>
  getNumberSetting(pool, OPERATIONAL_SETTING_KEYS.rateLimitMax, process.env.RATE_LIMIT_MAX, 600, POSITIVE);
/** Per-route rate-limit cap for the /ai/ and suggest- (and diagnose) endpoints, requests/min. */
export const getAiRateLimitMax = (pool: Pool): Promise<number> =>
  getNumberSetting(pool, OPERATIONAL_SETTING_KEYS.aiRateLimitMax, process.env.AI_RATE_LIMIT_MAX, 20, POSITIVE);
/** Capacity/stress profile: p95 latency (ms) that triggers k6's abortOnFail. p90/p99 are derived from this via deriveMultiPercentileThresholds, same as every other profile's thresholds. */
export const getCapacityAbortP95Ms = (pool: Pool): Promise<number> =>
  getNumberSetting(pool, OPERATIONAL_SETTING_KEYS.capacityAbortP95Ms, process.env.CAPACITY_ABORT_P95_MS, 2000, POSITIVE);
/** Capacity/stress profile: http_req_failed rate (%) that triggers abortOnFail. 0 is valid (abort on any failure). */
export const getCapacityAbortErrorRatePct = (pool: Pool): Promise<number> =>
  getNumberSetting(pool, OPERATIONAL_SETTING_KEYS.capacityAbortErrorRatePct, process.env.CAPACITY_ABORT_ERROR_RATE_PCT, 5, NON_NEGATIVE);
/** Capacity/stress profile: delayAbortEval grace period (seconds) — gives each new ramp level time to produce samples before a breach can trigger an abort. 0 means abort immediately on first breach. */
export const getCapacityAbortDelaySec = (pool: Pool): Promise<number> =>
  getNumberSetting(pool, OPERATIONAL_SETTING_KEYS.capacityAbortDelaySec, process.env.CAPACITY_ABORT_DELAY_SEC, 10, NON_NEGATIVE);

export interface OperationalSettings {
  staleRunningMinutes: number;
  stalePendingMinutes: number;
  liveMetricsRetentionDays: number;
  testResultsRetentionDays: number;
  auditLogRetentionDays: number;
  rateLimitMax: number;
  aiRateLimitMax: number;
  capacityAbortP95Ms: number;
  capacityAbortErrorRatePct: number;
  capacityAbortDelaySec: number;
}

export async function getOperationalSettings(pool: Pool): Promise<OperationalSettings> {
  const [
    staleRunningMinutes, stalePendingMinutes, liveMetricsRetentionDays,
    testResultsRetentionDays, auditLogRetentionDays, rateLimitMax, aiRateLimitMax,
    capacityAbortP95Ms, capacityAbortErrorRatePct, capacityAbortDelaySec,
  ] = await Promise.all([
    getStaleRunningMinutes(pool), getStalePendingMinutes(pool), getLiveMetricsRetentionDays(pool),
    getTestResultsRetentionDays(pool), getAuditLogRetentionDays(pool), getRateLimitMax(pool), getAiRateLimitMax(pool),
    getCapacityAbortP95Ms(pool), getCapacityAbortErrorRatePct(pool), getCapacityAbortDelaySec(pool),
  ]);
  return {
    staleRunningMinutes, stalePendingMinutes, liveMetricsRetentionDays, testResultsRetentionDays, auditLogRetentionDays,
    rateLimitMax, aiRateLimitMax, capacityAbortP95Ms, capacityAbortErrorRatePct, capacityAbortDelaySec,
  };
}

export async function setOperationalSetting(pool: Pool, key: OperationalSettingKey, value: number): Promise<void> {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
    [OPERATIONAL_SETTING_KEYS[key], String(value)]
  );
}
