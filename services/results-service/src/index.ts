import { initDb, pool } from './db';
import { startConsumer } from './consumer';
import { buildApp } from './app';

const start = async (): Promise<void> => {
  try {
    await initDb();
    await startConsumer();
    const app = await buildApp(pool);
    const port = Number(process.env.PORT) || 3004;
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

start();
