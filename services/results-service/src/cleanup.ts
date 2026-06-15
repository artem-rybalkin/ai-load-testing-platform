import { Pool } from 'pg';
import { log } from './logger';
import { broadcast } from './ws';

const CLEANUP_INTERVAL_MS = 60_000;
const LIVE_METRICS_RETENTION_DAYS = parseInt(process.env.LIVE_METRICS_RETENTION_DAYS ?? '30');
// GDPR data retention: 0 (default) disables auto-purge of test_results
const TEST_RESULTS_RETENTION_DAYS = parseInt(process.env.TEST_RESULTS_RETENTION_DAYS ?? '0');

export const runStaleCleanup = async (
  pool: Pool,
  runningMinutes: number,
  pendingMinutes: number
): Promise<{ runningFixed: number; pendingFixed: number; liveMetricsDeleted: number; testResultsDeleted: number }> => {
  const { rows: running } = await pool.query(
    `UPDATE test_results SET status = 'failed', status_message = 'Test timed out and was marked as failed'
     WHERE status = 'running'
       AND started_at < NOW() - ($1 || ' minutes')::INTERVAL
     RETURNING test_id`,
    [runningMinutes]
  );

  const { rows: pending } = await pool.query(
    `UPDATE test_results SET status = 'failed', status_message = 'Test timed out and was marked as failed'
     WHERE status = 'pending'
       AND created_at < NOW() - ($1 || ' minutes')::INTERVAL
     RETURNING test_id`,
    [pendingMinutes]
  );

  const retentionDays = Number.isFinite(LIVE_METRICS_RETENTION_DAYS) && LIVE_METRICS_RETENTION_DAYS > 0
    ? LIVE_METRICS_RETENTION_DAYS : 30;
  const { rowCount: liveDeleted } = await pool.query(
    `DELETE FROM live_metrics WHERE timestamp < NOW() - ($1 || ' days')::INTERVAL`,
    [retentionDays]
  );
  const liveMetricsDeleted = liveDeleted ?? 0;

  let testResultsDeleted = 0;
  if (Number.isFinite(TEST_RESULTS_RETENTION_DAYS) && TEST_RESULTS_RETENTION_DAYS > 0) {
    const { rows: expired } = await pool.query(
      `DELETE FROM test_results WHERE created_at < NOW() - ($1 || ' days')::INTERVAL RETURNING test_id`,
      [TEST_RESULTS_RETENTION_DAYS]
    );
    if (expired.length > 0) {
      await pool.query(
        `DELETE FROM live_metrics WHERE test_id = ANY($1::uuid[])`,
        [expired.map((r: { test_id: string }) => r.test_id)]
      );
    }
    testResultsDeleted = expired.length;
    if (testResultsDeleted > 0) {
      log.info({ testResultsDeleted, retentionDays: TEST_RESULTS_RETENTION_DAYS }, 'Deleted expired test_results rows');
    }
  }

  if (running.length > 0) {
    log.warn({ count: running.length, testIds: running.map((r: { test_id: string }) => r.test_id) }, 'Marked stale running tests as failed');
    for (const r of running) broadcast({ type: 'test:status', testId: r.test_id, status: 'failed', perfStatus: null });
  }
  if (pending.length > 0) {
    log.warn({ count: pending.length, testIds: pending.map((r: { test_id: string }) => r.test_id) }, 'Marked stale pending tests as failed');
    for (const r of pending) broadcast({ type: 'test:status', testId: r.test_id, status: 'failed', perfStatus: null });
  }
  if (running.length > 0 || pending.length > 0) broadcast({ type: 'tests:changed' });
  if (liveMetricsDeleted > 0) log.info({ liveMetricsDeleted, retentionDays }, 'Deleted old live_metrics rows');

  return { runningFixed: running.length, pendingFixed: pending.length, liveMetricsDeleted, testResultsDeleted };
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
