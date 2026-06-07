import { Pool } from 'pg';
import { log } from './logger';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL environment variable is required');

/** Primary pool — all writes + migrations go here. */
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Read replica pool — GET-heavy queries are routed here when READ_DATABASE_URL
 * is set. Falls back to the primary when the env var is absent so single-node
 * deployments need no config change.
 */
export const readPool: Pool = process.env.READ_DATABASE_URL
  ? new Pool({ connectionString: process.env.READ_DATABASE_URL })
  : pool;

// ── Migration registry ────────────────────────────────────────────────────────
// Each entry runs exactly once, identified by its version number.
// NEVER change the SQL of an existing migration — add a new one instead.

const MIGRATIONS: Array<{ version: number; name: string; up: (p: Pool) => Promise<void> }> = [
  {
    version: 1,
    name: 'initial_schema',
    up: async (p) => {
      await p.query(`
        CREATE TABLE IF NOT EXISTS test_scripts (
          id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          target_url   TEXT NOT NULL,
          test_type    VARCHAR(20) NOT NULL,
          script       TEXT NOT NULL,
          description  TEXT,
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
      // Rename legacy table if still present
      await p.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'test_templates') THEN
            ALTER TABLE test_templates RENAME TO test_presets;
          END IF;
        END $$
      `);
      await p.query(`
        CREATE TABLE IF NOT EXISTS test_presets (
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
        CREATE TABLE IF NOT EXISTS log_sources (
          id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name         TEXT NOT NULL,
          platform     VARCHAR(30),
          url_template TEXT NOT NULL,
          created_at   TIMESTAMPTZ DEFAULT NOW()
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
      await p.query(`CREATE INDEX IF NOT EXISTS live_metrics_test_id_idx ON live_metrics(test_id)`);
      await p.query(`CREATE INDEX IF NOT EXISTS idx_test_results_status ON test_results(status)`);
      await p.query(`CREATE INDEX IF NOT EXISTS idx_test_results_url_type_status ON test_results(target_url, type, status)`);
      await p.query(`CREATE INDEX IF NOT EXISTS idx_test_results_active ON test_results(created_at DESC) WHERE status IN ('pending', 'running')`);
    },
  },
  {
    version: 2,
    name: 'add_column_extensions',
    up: async (p) => {
      await p.query(`ALTER TABLE test_results  ADD COLUMN IF NOT EXISTS is_baseline     BOOLEAN DEFAULT FALSE`);
      await p.query(`ALTER TABLE test_results  ADD COLUMN IF NOT EXISTS duration_seconds INTEGER`);
      await p.query(`ALTER TABLE live_metrics  ADD COLUMN IF NOT EXISTS step_metrics    JSONB`);
      await p.query(`ALTER TABLE test_scripts  ADD COLUMN IF NOT EXISTS description     TEXT`);
      await p.query(`ALTER TABLE test_results  ADD COLUMN IF NOT EXISTS status_message  TEXT`);
      await p.query(`ALTER TABLE test_results  ADD COLUMN IF NOT EXISTS steps           JSONB`);
      await p.query(`ALTER TABLE test_results  ADD COLUMN IF NOT EXISTS test_data       JSONB`);
    },
  },
  {
    version: 3,
    name: 'log_sources_metrics_endpoint',
    up: async (p) => {
      await p.query(`ALTER TABLE log_sources ADD COLUMN IF NOT EXISTS metrics_endpoint_template TEXT`);
      await p.query(`ALTER TABLE log_sources ADD COLUMN IF NOT EXISTS auth_header               TEXT`);
    },
  },
  {
    version: 4,
    name: 'webhooks_format',
    up: async (p) => {
      // format: 'generic' (default JSON POST) | 'slack' | 'pagerduty' | 'opsgenie'
      await p.query(`ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS format VARCHAR(20) DEFAULT 'generic'`);
    },
  },
  {
    version: 5,
    name: 'projects_and_project_id',
    up: async (p) => {
      await p.query(`
        CREATE TABLE IF NOT EXISTS projects (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name       TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await p.query(`ALTER TABLE test_results  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id)`);
      await p.query(`ALTER TABLE test_scripts  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id)`);
      await p.query(`ALTER TABLE test_presets  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id)`);
      await p.query(`ALTER TABLE schedules     ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id)`);
      await p.query(`ALTER TABLE webhooks      ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id)`);
      await p.query(`ALTER TABLE log_sources   ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id)`);
      await p.query(`CREATE INDEX IF NOT EXISTS idx_test_results_project_id ON test_results(project_id)`);
      await p.query(`CREATE INDEX IF NOT EXISTS idx_test_scripts_project_id ON test_scripts(project_id)`);
    },
  },
];

// ── Migration engine ──────────────────────────────────────────────────────────

export const createSchema = async (p: Pool): Promise<void> => {
  await p.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const { rows } = await p.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version');
  const applied = new Set(rows.map(r => r.version));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    log.info({ version: migration.version, name: migration.name }, 'Applying migration');
    await migration.up(p);
    await p.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [migration.version, migration.name]);
    log.info({ version: migration.version }, 'Migration applied');
  }
};

export const initDb = async (): Promise<void> => {
  await createSchema(pool);
  log.info('Database initialized');
};

export const findOrCreateProject = async (name: string, p: Pool = pool): Promise<string> => {
  const { rows } = await p.query(
    `INSERT INTO projects (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [name.trim().toLowerCase()]
  );
  return rows[0].id as string;
};
