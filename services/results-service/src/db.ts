import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://alt_user:alt_password@localhost:5432/alt_db'
});

export const initDb = async (): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS test_results (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      test_id     UUID NOT NULL UNIQUE,
      type        VARCHAR(20) NOT NULL,
      target_url  TEXT NOT NULL,
      status      VARCHAR(20) NOT NULL,
      metrics     JSONB,
      started_at  TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log('Database initialized');
};