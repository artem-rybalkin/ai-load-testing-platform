import { createHash } from 'crypto';
import { Pool } from 'pg';

import { TestType, TestScript, BackendTestOptions, FlowStep } from '@alt/shared';
import { buildK6Options, replaceK6Options } from './options';
import { log } from './logger';

interface TestScriptRow {
  id: string;
  target_url: string;
  test_type: string;
  script: string;
  description: string | null;
  used_count: number;
  created_at: Date;
  updated_at: Date;
  project_id: string | null;
  workspace_id: string | null;
}

const canonicalStep = (s: FlowStep): unknown => ({
  name: s.name, url: s.url, method: s.method,
  ...(s.body    !== undefined ? { body: s.body }       : {}),
  ...(s.headers !== undefined ? { headers: s.headers } : {}),
  ...(s.extract !== undefined ? { extract: s.extract } : {}),
});

// setupFirstStep changes the generated script's structure (step 1 moves into
// k6's setup()), so it must be folded into the cache key — otherwise a script
// cached under the old structure could be served for a request that now wants
// the new one. Only mixed into the hash payload when true, so the key is
// byte-for-byte identical to before for the (default) false/unset case —
// existing cached flow scripts stay valid.
export const stepsToKey = (steps: FlowStep[], setupFirstStep?: boolean): string => {
  const payload = setupFirstStep ? { steps: steps.map(canonicalStep), setupFirstStep: true } : steps.map(canonicalStep);
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
  return `flow:${hash}`;
};

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL environment variable is required');
// Moderate traffic (test creation + script-cache lookups) — smaller than
// results-service's pool, which fronts the rest of the REST API surface.
// connectionTimeoutMillis: node-postgres defaults to 0 (wait forever) for a
// pool slot — a bounded timeout fails fast instead of a request hanging
// indefinitely when the pool is exhausted or Postgres is unreachable.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});
// Pool extends EventEmitter — an idle client that hits a backend error (Postgres
// restart, network blip, connection drop) emits an unhandled 'error' event, which
// Node treats as an uncaught exception and crashes the whole process. Without this
// handler, a single idle-connection hiccup takes down the entire service, not just
// the one query.
pool.on('error', (err) => log.error({ err }, 'Idle Postgres client error'));

export const checkDbHealth = (): Promise<void> => pool.query('SELECT 1').then(() => undefined);

export const incrementUsedCount = (id: string, dbPool: Pool = pool): Promise<void> =>
  dbPool.query('UPDATE test_scripts SET used_count = used_count + 1, updated_at = NOW() WHERE id = $1', [id]).then(() => undefined);

export const findExistingScript = async (
  targetUrl: string,
  testType: TestType,
  options?: BackendTestOptions,
  dbPool: Pool = pool,
  cacheKey?: string,
  projectId?: string,
): Promise<TestScript | null> => {
  const lookupKey = cacheKey ?? targetUrl;
  const lookupType = testType === 'flow' ? 'backend' : testType;
  const { rows } = await dbPool.query<TestScriptRow>(
    `SELECT * FROM test_scripts WHERE target_url = $1 AND test_type = $2
       AND ($3::uuid IS NULL OR project_id = $3::uuid)`,
    [lookupKey, lookupType, projectId ?? null]
  );

  if (rows.length === 0) return null;

  let script: string = rows[0].script;

  if (testType === 'backend' && options) {
    const newOptions = buildK6Options(options);
    script = replaceK6Options(script, newOptions);
    log.info({ profile: options.profile ?? 'load', vus: options.vus, duration: options.duration }, 'Injected new options into cached script');
  }

  return {
    id: rows[0].id,
    targetUrl: rows[0].target_url,
    testType: rows[0].test_type as TestType,
    script,
    description: rows[0].description ?? null,
    usedCount: rows[0].used_count,
    createdAt: rows[0].created_at.toISOString(),
    updatedAt: rows[0].updated_at.toISOString()
  };
};
