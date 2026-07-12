import { Pool } from 'pg';
import { log } from './logger';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL environment variable is required');

// results-service fronts nearly the entire REST API surface (results, teams,
// orgs, webhooks, schedules, presets, auth, AI endpoints, workspaces, system
// health) — the highest concurrent-request service, hence the largest pool.
// connectionTimeoutMillis: node-postgres defaults to 0 (wait forever) for a
// pool slot — a bounded timeout fails fast instead of a request hanging
// indefinitely when the pool is exhausted or Postgres is unreachable.
const POOL_MAX = 20;
const IDLE_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 5_000;

/** Primary pool — all writes + migrations go here. */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: POOL_MAX,
  idleTimeoutMillis: IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
});
// Pool extends EventEmitter — an idle client that hits a backend error (Postgres
// restart, network blip, connection drop) emits an unhandled 'error' event, which
// Node treats as an uncaught exception and crashes the whole process. Without this
// handler, a single idle-connection hiccup takes down the entire service, not just
// the one query.
pool.on('error', (err) => log.error({ err }, 'Idle Postgres client error (primary pool)'));

/**
 * Read replica pool — GET-heavy queries are routed here when READ_DATABASE_URL
 * is set. Falls back to the primary when the env var is absent so single-node
 * deployments need no config change.
 */
export const readPool: Pool = process.env.READ_DATABASE_URL
  ? new Pool({
      connectionString: process.env.READ_DATABASE_URL,
      max: POOL_MAX,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    })
  : pool;
// Only a distinct object (READ_DATABASE_URL set) needs its own handler — otherwise
// readPool === pool and it already has one, registering twice would just double-log.
if (readPool !== pool) {
  readPool.on('error', (err) => log.error({ err }, 'Idle Postgres client error (read pool)'));
}

// ── Migration registry ────────────────────────────────────────────────────────
// Each entry runs exactly once, identified by its version number.
// NEVER change the SQL of an existing migration — add a new one instead.

const MIGRATIONS: Array<{ version: number; name: string; up: (p: Pool) => Promise<void> }> = [
  {
    version: 1,
    name: 'initial_schema',
    up: async (p): Promise<void> => {
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
          script_id     UUID REFERENCES test_scripts(id) ON DELETE SET NULL,
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
    up: async (p): Promise<void> => {
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
    up: async (p): Promise<void> => {
      await p.query(`ALTER TABLE log_sources ADD COLUMN IF NOT EXISTS metrics_endpoint_template TEXT`);
      await p.query(`ALTER TABLE log_sources ADD COLUMN IF NOT EXISTS auth_header               TEXT`);
    },
  },
  {
    version: 4,
    name: 'webhooks_format',
    up: async (p): Promise<void> => {
      // format: 'generic' (default JSON POST) | 'slack' | 'pagerduty' | 'opsgenie'
      await p.query(`ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS format VARCHAR(20) DEFAULT 'generic'`);
    },
  },
  {
    version: 5,
    name: 'projects_and_project_id',
    up: async (p): Promise<void> => {
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
  {
    version: 6,
    name: 'users_team_members_sessions',
    up: async (p): Promise<void> => {
      await p.query(`
        CREATE TABLE IF NOT EXISTS users (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          email         TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          name          TEXT,
          created_at    TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await p.query(`
        CREATE TABLE IF NOT EXISTS team_members (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role       VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member','viewer')),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(team_id, user_id)
        )
      `);
      await p.query(`
        CREATE TABLE IF NOT EXISTS sessions (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash  TEXT NOT NULL UNIQUE,
          team_id     UUID REFERENCES projects(id) ON DELETE SET NULL,
          created_at  TIMESTAMPTZ DEFAULT NOW(),
          expires_at  TIMESTAMPTZ NOT NULL,
          revoked_at  TIMESTAMPTZ
        )
      `);
      await p.query(`CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id)`);
      await p.query(`CREATE INDEX IF NOT EXISTS sessions_token_hash_idx ON sessions(token_hash)`);
    },
  },
  {
    version: 7,
    name: 'team_quotas_and_gemini_usage',
    up: async (p): Promise<void> => {
      await p.query(`
        CREATE TABLE IF NOT EXISTS team_quotas (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_id                    UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
          max_concurrent_tests       INTEGER NOT NULL,
          max_vus_per_test           INTEGER NOT NULL,
          max_test_duration_seconds  INTEGER NOT NULL,
          max_scheduled_tests        INTEGER NOT NULL,
          max_gemini_calls_per_day   INTEGER NOT NULL,
          created_at                 TIMESTAMPTZ DEFAULT NOW(),
          updated_at                 TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await p.query(`
        CREATE TABLE IF NOT EXISTS gemini_usage (
          team_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
          call_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (team_id, usage_date)
        )
      `);
    },
  },
  {
    version: 8,
    name: 'organizations_and_team_api_keys',
    up: async (p): Promise<void> => {
      await p.query(`
        CREATE TABLE IF NOT EXISTS organizations (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name       TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await p.query(`
        CREATE TABLE IF NOT EXISTS org_members (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role       VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(org_id, user_id)
        )
      `);
      await p.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE SET NULL`);
      await p.query(`
        CREATE TABLE IF NOT EXISTS team_api_keys (
          id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name         TEXT NOT NULL,
          key_hash     TEXT NOT NULL UNIQUE,
          created_at   TIMESTAMPTZ DEFAULT NOW(),
          last_used_at TIMESTAMPTZ,
          revoked_at   TIMESTAMPTZ
        )
      `);
      await p.query(`CREATE INDEX IF NOT EXISTS team_api_keys_hash_idx ON team_api_keys(key_hash)`);
    },
  },
  {
    version: 9,
    name: 'audit_log',
    up: async (p): Promise<void> => {
      await p.query(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_id       UUID REFERENCES projects(id) ON DELETE CASCADE,
          user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
          action        VARCHAR(30) NOT NULL,
          resource_type VARCHAR(30) NOT NULL,
          resource_id   TEXT,
          created_at    TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await p.query(`CREATE INDEX IF NOT EXISTS audit_log_team_id_idx ON audit_log(team_id, created_at DESC)`);
    },
  },
  {
    version: 10,
    name: 'app_settings',
    up: async (p): Promise<void> => {
      await p.query(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      await p.query(
        `INSERT INTO app_settings (key, value) VALUES ('ai_provider', $1) ON CONFLICT (key) DO NOTHING`,
        [JSON.stringify({ provider: 'gemini', fallbacks: [] })]
      );
    },
  },
  {
    version: 11,
    name: 'team_ai_providers',
    up: async (p): Promise<void> => {
      await p.query(`
        CREATE TABLE IF NOT EXISTS team_ai_providers (
          team_id    UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          provider   VARCHAR(20) NOT NULL,
          fallbacks  TEXT[] NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
    },
  },
  {
    version: 12,
    name: 'execution_log',
    up: async (p): Promise<void> => {
      await p.query(`ALTER TABLE test_results ADD COLUMN IF NOT EXISTS execution_log TEXT`);
    },
  },
  {
    version: 13,
    name: 'script_id_on_delete_set_null',
    up: async (p): Promise<void> => {
      // test_results.script_id had no ON DELETE clause, so DELETE /scripts/:id always
      // 500'd with a raw FK-violation once a script had ever been used (i.e. always,
      // since a script row only exists after a test references it). Switch to
      // SET NULL so deleting a script unlinks it from historical results instead of
      // being permanently blocked by them.
      await p.query(`ALTER TABLE test_results DROP CONSTRAINT IF EXISTS test_results_script_id_fkey`);
      await p.query(`ALTER TABLE test_results ADD CONSTRAINT test_results_script_id_fkey FOREIGN KEY (script_id) REFERENCES test_scripts(id) ON DELETE SET NULL`);
    },
  },
  {
    version: 14,
    name: 'workspaces',
    up: async (p): Promise<void> => {
      await p.query(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name        TEXT NOT NULL,
          description TEXT,
          created_at  TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(team_id, name)
        )
      `);
      await p.query(`CREATE INDEX IF NOT EXISTS workspaces_team_id_idx ON workspaces(team_id)`);
      await p.query(`ALTER TABLE test_results  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL`);
      await p.query(`ALTER TABLE test_scripts  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL`);
      await p.query(`ALTER TABLE test_presets  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL`);
      await p.query(`ALTER TABLE schedules     ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL`);
      await p.query(`ALTER TABLE webhooks      ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL`);
    },
  },
  {
    version: 15,
    name: 'live_metrics_error_breakdown',
    up: async (p): Promise<void> => {
      await p.query(`ALTER TABLE live_metrics ADD COLUMN IF NOT EXISTS client_error_rate FLOAT NOT NULL DEFAULT 0`);
      await p.query(`ALTER TABLE live_metrics ADD COLUMN IF NOT EXISTS server_error_rate FLOAT NOT NULL DEFAULT 0`);
    },
  },
  {
    version: 16,
    name: 'perf_indexes',
    up: async (p): Promise<void> => {
      // team_members/org_members only had a UNIQUE(team_id/org_id, user_id) composite —
      // useless for a user_id-only lookup (login, switch-team, /auth/me), which forced a full scan.
      await p.query(`CREATE INDEX IF NOT EXISTS idx_team_members_user_id ON team_members(user_id)`);
      await p.query(`CREATE INDEX IF NOT EXISTS idx_org_members_user_id  ON org_members(user_id)`);

      // GET /results filters on project_id/workspace_id and sorts by created_at DESC — the old
      // single-column idx_test_results_project_id could satisfy the filter but not the sort.
      await p.query(`CREATE INDEX IF NOT EXISTS idx_test_results_project_created   ON test_results(project_id, created_at DESC)`);
      await p.query(`CREATE INDEX IF NOT EXISTS idx_test_results_workspace_created ON test_results(workspace_id, created_at DESC)`);
      await p.query(`DROP INDEX IF EXISTS idx_test_results_project_id`); // superseded — same leading column

      // consumer.ts's "find the previous completed result for this URL" query filters on
      // (target_url, type, status) and sorts by (is_baseline DESC, created_at DESC); the old
      // 3-column index covered the filter but forced a sort over every matching historical row.
      await p.query(`CREATE INDEX IF NOT EXISTS idx_test_results_url_type_status_created ON test_results(target_url, type, status, is_baseline DESC, created_at DESC)`);
      await p.query(`DROP INDEX IF EXISTS idx_test_results_url_type_status`); // superseded — same leading columns
    },
  },
];

// ── Migration engine ──────────────────────────────────────────────────────────

// The postgres docker image restarts its server once after initdb completes;
// a connection made during that window is reset. Retry the first query so
// Testcontainers-based tests don't fail on that transient restart.
export const queryWithRetry = async (p: Pool, sql: string, retries = 5, delayMs = 1000): Promise<void> => {
  for (let attempt = 1; ; attempt++) {
    try {
      await p.query(sql);
      return;
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
};

export const createSchema = async (p: Pool): Promise<void> => {
  await queryWithRetry(p, `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Acquire a session-level advisory lock before running migrations.
  // Use a fixed integer that represents this app's migration lock.
  const MIGRATION_LOCK_ID = 7_432_801; // arbitrary unique int for this app
  const lockClient = await p.connect();
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);

    const { rows } = await p.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version');
    const applied = new Set(rows.map(r => r.version));

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      log.info({ version: migration.version, name: migration.name }, 'Applying migration');
      await migration.up(p);
      await p.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [migration.version, migration.name]);
      log.info({ version: migration.version }, 'Migration applied');
    }
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    lockClient.release();
  }
};

export const initDb = async (): Promise<void> => {
  await createSchema(pool);
  log.info('Database initialized');
};

export const findOrCreateProject = async (name: string, p: Pool = pool): Promise<string> => {
  const { rows } = await p.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [name.trim().toLowerCase()]
  );
  return rows[0]!.id; // INSERT ... ON CONFLICT DO UPDATE ... RETURNING always returns exactly one row
};
