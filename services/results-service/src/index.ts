import './tracing';
import { shutdownTracing } from '@alt/tracing';
import { initDb, pool, readPool } from './db';
import { startConsumer } from './consumer';
import { buildApp } from './app';
import { startScheduler } from './scheduler';
import { startStaleCleanup } from './cleanup';
import { log } from './logger';

const start = async (): Promise<void> => {
  try {
    await initDb();
    await startConsumer();
    await startScheduler(pool);
    startStaleCleanup(pool);
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
  await shutdownTracing();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT',  () => void shutdown('SIGINT'));

void start();
