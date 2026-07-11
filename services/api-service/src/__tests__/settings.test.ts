import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Pool } from 'pg';
import { getRateLimitMax, getCapacityAbortConfig } from '../settings';

// Lightweight mocked-pool unit tests — the fail-open path in particular needs
// a pool whose .query() throws synchronously (not just rejects), which is
// awkward to provoke against a real Testcontainers Postgres instance.
const makePool = (rowsByKey: Record<string, string> = {}): Pool => ({
  query: vi.fn().mockImplementation(async (_sql: string, params?: unknown[]) => {
    const key = params?.[0] as string | undefined;
    return { rows: key && key in rowsByKey ? [{ value: rowsByKey[key] }] : [] };
  }),
} as unknown as Pool);

afterEach(() => {
  delete process.env.RATE_LIMIT_MAX;
  delete process.env.CAPACITY_ABORT_P95_MS;
  delete process.env.CAPACITY_ABORT_ERROR_RATE_PCT;
  delete process.env.CAPACITY_ABORT_DELAY_SEC;
});

describe('getRateLimitMax', () => {
  it('returns the hardcoded default (600) when no row and no env var is set', async () => {
    expect(await getRateLimitMax(makePool())).toBe(600);
  });

  it('returns the stored DB value when present', async () => {
    expect(await getRateLimitMax(makePool({ rate_limit_max: '1000' }))).toBe(1000);
  });

  it('falls back to the env var when no DB row exists', async () => {
    process.env.RATE_LIMIT_MAX = '300';
    expect(await getRateLimitMax(makePool())).toBe(300);
  });

  it('fails open to the default when pool.query throws synchronously', async () => {
    const pool = { query: () => { throw new Error('pool.query is not a function'); } } as unknown as Pool;
    expect(await getRateLimitMax(pool)).toBe(600);
  });

  it('fails open to the default when pool.query rejects', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('connection lost')) } as unknown as Pool;
    expect(await getRateLimitMax(pool)).toBe(600);
  });
});

describe('getCapacityAbortConfig', () => {
  it('returns the hardcoded defaults when no rows and no env vars are set', async () => {
    expect(await getCapacityAbortConfig(makePool())).toEqual({ p95Ms: 2000, errorRatePct: 5, delaySec: 10 });
  });

  it('returns stored DB values for all three fields', async () => {
    const pool = makePool({
      capacity_abort_p95_ms: '3000',
      capacity_abort_error_rate_pct: '8',
      capacity_abort_delay_sec: '20',
    });
    expect(await getCapacityAbortConfig(pool)).toEqual({ p95Ms: 3000, errorRatePct: 8, delaySec: 20 });
  });

  it('allows 0 for errorRatePct and delaySec (abort on any failure / no grace period)', async () => {
    const pool = makePool({ capacity_abort_error_rate_pct: '0', capacity_abort_delay_sec: '0' });
    const config = await getCapacityAbortConfig(pool);
    expect(config.errorRatePct).toBe(0);
    expect(config.delaySec).toBe(0);
  });

  it('fails open to defaults when pool.query throws synchronously (e.g. app_settings table missing)', async () => {
    const pool = { query: () => { throw new Error('relation "app_settings" does not exist'); } } as unknown as Pool;
    expect(await getCapacityAbortConfig(pool)).toEqual({ p95Ms: 2000, errorRatePct: 5, delaySec: 10 });
  });
});
