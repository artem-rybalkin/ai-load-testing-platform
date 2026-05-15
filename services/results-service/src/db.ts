import { Pool } from 'pg';
import { log } from './logger';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://alt_user:alt_password@localhost:5432/alt_db'
});

export const createSchema = async (p: Pool): Promise<void> => {
  await p.query(`
    CREATE TABLE IF NOT EXISTS test_scripts (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      target_url   TEXT NOT NULL,
      test_type    VARCHAR(20) NOT NULL,
      script       TEXT NOT NULL,
      used_count   INTEGER DEFAULT 1,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(target_url, test_type)
    )
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS test_results (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      test_id       UUID NOT NULL UNIQUE,
      type          VARCHAR(20) NOT NULL,
      target_url    TEXT NOT NULL,
      status        VARCHAR(20) NOT NULL,
      metrics       JSONB,
      script_id     UUID REFERENCES test_scripts(id),
      reused_script BOOLEAN DEFAULT FALSE,
      perf_status   VARCHAR(20),
      analysis      JSONB,
      started_at    TIMESTAMPTZ,
      completed_at  TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS schedules (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name        TEXT NOT NULL,
      cron        TEXT NOT NULL,
      type        VARCHAR(20) NOT NULL,
      target_url  TEXT NOT NULL,
      description TEXT,
      options     JSONB NOT NULL,
      thresholds  JSONB,
      enabled     BOOLEAN DEFAULT TRUE,
      last_run_at TIMESTAMPTZ,
      next_run_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS test_templates (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name        TEXT NOT NULL,
      description TEXT,
      type        VARCHAR(20) NOT NULL,
      target_url  TEXT,
      options     JSONB NOT NULL,
      thresholds  JSONB,
      used_count  INTEGER DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      url        TEXT NOT NULL,
      events     TEXT[] NOT NULL DEFAULT '{failed,degraded}',
      secret     TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS live_metrics (
      id                SERIAL PRIMARY KEY,
      test_id           UUID NOT NULL,
      timestamp         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      vus               INTEGER NOT NULL DEFAULT 0,
      rps               FLOAT NOT NULL DEFAULT 0,
      avg_response_time FLOAT NOT NULL DEFAULT 0,
      error_rate        FLOAT NOT NULL DEFAULT 0
    )
  `);

  // Safe migrations for columns added after initial deploy
  await p.query(`ALTER TABLE test_results ADD COLUMN IF NOT EXISTS is_baseline BOOLEAN DEFAULT FALSE`);
  await p.query(`ALTER TABLE test_results ADD COLUMN IF NOT EXISTS duration_seconds INTEGER`);

  // Indexes
  await p.query(`CREATE INDEX IF NOT EXISTS live_metrics_test_id_idx
    ON live_metrics(test_id)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_test_results_status
    ON test_results(status)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_test_results_url_type_status
    ON test_results(target_url, type, status)`);
};

export const initDb = async (): Promise<void> => {
  await createSchema(pool);
  log.info('Database initialized');
};
