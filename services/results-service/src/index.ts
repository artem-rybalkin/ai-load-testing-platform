import './tracing';
import { initDb, pool, readPool } from './db';
import { startConsumer } from './consumer';
import { buildApp } from './app';
import { startScheduler } from './scheduler';
import { startStaleCleanup } from './cleanup';
import { log } from './logger';

const parseMinutes = (env: string | undefined, fallback: number): number => {
  const n = parseInt(env ?? '');
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const STALE_RUNNING_MINUTES = parseMinutes(process.env.STALE_RUNNING_MINUTES, 15);
const STALE_PENDING_MINUTES = parseMinutes(process.env.STALE_PENDING_MINUTES, 30);

const start = async (): Promise<void> => {
  try {
    await initDb();
    await startConsumer();
    await startScheduler(pool);
    startStaleCleanup(pool, STALE_RUNNING_MINUTES, STALE_PENDING_MINUTES);
    const app = await buildApp(pool, { logger: true, readPool });
    const port = Number(process.env.PORT) || 3004;
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    log.error({ err: (err as Error) }, 'results-service startup failed');
    process.exit(1);
  }
};

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, 'Shutdown signal received — draining');
  try {
    await pool.end();
    log.info('DB pool closed');
  } catch (err) {
    log.error({ err: (err as Error).message }, 'Error closing DB pool');
  }
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

start();
