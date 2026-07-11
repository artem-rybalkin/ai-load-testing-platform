import { Pool } from 'pg';
import { log } from './logger';
import { broadcast } from './ws';
import {
  getStaleRunningMinutes, getStalePendingMinutes,
  getLiveMetricsRetentionDays, getTestResultsRetentionDays, getAuditLogRetentionDays,
} from './settings';

const CLEANUP_INTERVAL_MS = 60_000;

export const runStaleCleanup = async (
  pool: Pool,
  runningMinutes: number,
  pendingMinutes: number
): Promise<{
  runningFixed: number; pendingFixed: number; liveMetricsDeleted: number; testResultsDeleted: number;
  sessionsDeleted: number; auditLogDeleted: number;
}> => {
  const { rows: running } = await pool.query<{ test_id: string }>(
    `UPDATE test_results SET status = 'failed', status_message = 'Test timed out and was marked as failed'
     WHERE status = 'running'
       AND started_at < NOW() - ($1 || ' minutes')::INTERVAL
     RETURNING test_id`,
    [runningMinutes]
  );

  const { rows: pending } = await pool.query<{ test_id: string }>(
    `UPDATE test_results SET status = 'failed', status_message = 'Test timed out and was marked as failed'
     WHERE status = 'pending'
       AND created_at < NOW() - ($1 || ' minutes')::INTERVAL
     RETURNING test_id`,
    [pendingMinutes]
  );

  const retentionDays = await getLiveMetricsRetentionDays(pool);
  const { rowCount: liveDeleted } = await pool.query(
    `DELETE FROM live_metrics WHERE timestamp < NOW() - ($1 || ' days')::INTERVAL`,
    [retentionDays]
  );
  const liveMetricsDeleted = liveDeleted ?? 0;

  let testResultsDeleted = 0;
  const testResultsRetentionDays = await getTestResultsRetentionDays(pool);
  if (testResultsRetentionDays > 0) {
    const { rows: expired } = await pool.query<{ test_id: string }>(
      `DELETE FROM test_results WHERE created_at < NOW() - ($1 || ' days')::INTERVAL RETURNING test_id`,
      [testResultsRetentionDays]
    );
    if (expired.length > 0) {
      await pool.query(
        `DELETE FROM live_metrics WHERE test_id = ANY($1::uuid[])`,
        [expired.map((r: { test_id: string }) => r.test_id)]
      );
    }
    testResultsDeleted = expired.length;
    if (testResultsDeleted > 0) {
      log.info({ testResultsDeleted, retentionDays: testResultsRetentionDays }, 'Deleted expired test_results rows');
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

  // sessions is pure auth plumbing (not an audit trail) — an expired or revoked
  // session row has zero future purpose, so purge unconditionally, no grace period.
  const { rowCount: sessionsDeletedCount } = await pool.query(
    `DELETE FROM sessions WHERE expires_at < NOW() OR revoked_at IS NOT NULL`
  );
  const sessionsDeleted = sessionsDeletedCount ?? 0;
  if (sessionsDeleted > 0) log.info({ sessionsDeleted }, 'Deleted expired/revoked sessions rows');

  let auditLogDeleted = 0;
  const auditLogRetentionDays = await getAuditLogRetentionDays(pool);
  if (auditLogRetentionDays > 0) {
    const { rowCount } = await pool.query(
      `DELETE FROM audit_log WHERE created_at < NOW() - ($1 || ' days')::INTERVAL`,
      [auditLogRetentionDays]
    );
    auditLogDeleted = rowCount ?? 0;
    if (auditLogDeleted > 0) log.info({ auditLogDeleted, retentionDays: auditLogRetentionDays }, 'Deleted expired audit_log rows');
  }

  return {
    runningFixed: running.length, pendingFixed: pending.length, liveMetricsDeleted, testResultsDeleted,
    sessionsDeleted, auditLogDeleted,
  };
};

/**
 * Starts the periodic stale-test sweep. Thresholds are re-read (DB override,
 * falling back to env var, falling back to a hardcoded default — see
 * settings.ts) on every tick rather than fixed at startup, so an admin
 * editing them via the Settings page takes effect on the next tick instead
 * of requiring a redeploy.
 */
export const startStaleCleanup = (pool: Pool): void => {
  setInterval(() => {
    void (async (): Promise<void> => {
      try {
        const [runningMinutes, pendingMinutes] = await Promise.all([
          getStaleRunningMinutes(pool), getStalePendingMinutes(pool),
        ]);
        await runStaleCleanup(pool, runningMinutes, pendingMinutes);
      } catch (err) {
        log.error({ err: (err as Error).message }, 'Stale test cleanup failed');
      }
    })();
  }, CLEANUP_INTERVAL_MS);

  log.info('Stale test cleanup started (admin-configurable via Settings)');
};
