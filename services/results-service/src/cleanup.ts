import { Pool } from 'pg';
import { log } from './logger';
import { broadcast } from './ws';

const CLEANUP_INTERVAL_MS = 60_000;

export const runStaleCleanup = async (
  pool: Pool,
  runningMinutes: number,
  pendingMinutes: number
): Promise<{ runningFixed: number; pendingFixed: number }> => {
  const { rows: running } = await pool.query(
    `UPDATE test_results SET status = 'failed'
     WHERE status = 'running'
       AND started_at < NOW() - ($1 || ' minutes')::INTERVAL
     RETURNING test_id`,
    [runningMinutes]
  );

  const { rows: pending } = await pool.query(
    `UPDATE test_results SET status = 'failed'
     WHERE status = 'pending'
       AND created_at < NOW() - ($1 || ' minutes')::INTERVAL
     RETURNING test_id`,
    [pendingMinutes]
  );

  if (running.length > 0) {
    log.warn({ count: running.length, testIds: running.map((r: { test_id: string }) => r.test_id) }, 'Marked stale running tests as failed');
    for (const r of running) broadcast({ type: 'test:status', testId: r.test_id, status: 'failed', perfStatus: null });
  }
  if (pending.length > 0) {
    log.warn({ count: pending.length, testIds: pending.map((r: { test_id: string }) => r.test_id) }, 'Marked stale pending tests as failed');
    for (const r of pending) broadcast({ type: 'test:status', testId: r.test_id, status: 'failed', perfStatus: null });
  }
  if (running.length > 0 || pending.length > 0) broadcast({ type: 'tests:changed' });

  return { runningFixed: running.length, pendingFixed: pending.length };
};

export const startStaleCleanup = (pool: Pool, runningMinutes: number, pendingMinutes: number): void => {
  setInterval(async () => {
    try {
      await runStaleCleanup(pool, runningMinutes, pendingMinutes);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'Stale test cleanup failed');
    }
  }, CLEANUP_INTERVAL_MS);

  log.info({ staleRunningMinutes: runningMinutes, stalePendingMinutes: pendingMinutes }, 'Stale test cleanup started');
};
