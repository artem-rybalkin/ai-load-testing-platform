import { initDb, pool } from './db';
import { startConsumer } from './consumer';
import { buildApp } from './app';
import { startScheduler } from './scheduler';
import { startStaleCleanup } from './cleanup';
import { log } from './logger';

const STALE_RUNNING_MINUTES = parseInt(process.env.STALE_RUNNING_MINUTES ?? '15');
const STALE_PENDING_MINUTES = parseInt(process.env.STALE_PENDING_MINUTES ?? '30');

const start = async (): Promise<void> => {
  try {
    await initDb();
    await startConsumer();
    await startScheduler(pool);
    startStaleCleanup(pool, STALE_RUNNING_MINUTES, STALE_PENDING_MINUTES);
    const app = await buildApp(pool, { logger: true });
    const port = Number(process.env.PORT) || 3004;
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    log.error({ err: (err as Error) }, 'results-service startup failed');
    process.exit(1);
  }
};

start();
