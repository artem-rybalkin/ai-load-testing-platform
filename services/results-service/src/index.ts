import { initDb, pool } from './db';
import { startConsumer } from './consumer';
import { buildApp } from './app';
import { startScheduler } from './scheduler';
import { log } from './logger';

const STALE_RUNNING_MINUTES = parseInt(process.env.STALE_RUNNING_MINUTES ?? '15');
const STALE_PENDING_MINUTES = parseInt(process.env.STALE_PENDING_MINUTES ?? '30');
const CLEANUP_INTERVAL_MS   = 60_000;

const startStaleCleanup = (): void => {
  setInterval(async () => {
    try {
      const { rows: running } = await pool.query(`
        UPDATE test_results SET status = 'failed'
        WHERE status = 'running'
          AND started_at < NOW() - ($1 || ' minutes')::INTERVAL
        RETURNING test_id
      `, [STALE_RUNNING_MINUTES]);

      const { rows: pending } = await pool.query(`
        UPDATE test_results SET status = 'failed'
        WHERE status = 'pending'
          AND created_at < NOW() - ($1 || ' minutes')::INTERVAL
        RETURNING test_id
      `, [STALE_PENDING_MINUTES]);

      if (running.length > 0)
        log.warn({ count: running.length, testIds: running.map((r: { test_id: string }) => r.test_id) }, 'Marked stale running tests as failed');
      if (pending.length > 0)
        log.warn({ count: pending.length, testIds: pending.map((r: { test_id: string }) => r.test_id) }, 'Marked stale pending tests as failed');
    } catch (err) {
      log.error({ err: (err as Error).message }, 'Stale test cleanup failed');
    }
  }, CLEANUP_INTERVAL_MS);

  log.info({ staleRunningMinutes: STALE_RUNNING_MINUTES, stalePendingMinutes: STALE_PENDING_MINUTES }, 'Stale test cleanup started');
};

const start = async (): Promise<void> => {
  try {
    await initDb();
    await startConsumer();
    await startScheduler(pool);
    startStaleCleanup();
    const app = await buildApp(pool, { logger: true });
    const port = Number(process.env.PORT) || 3004;
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    log.error({ err: (err as Error) }, 'results-service startup failed');
    process.exit(1);
  }
};

start();
