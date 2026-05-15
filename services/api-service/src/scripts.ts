import { createHash } from 'crypto';
import { Pool } from 'pg';

import { TestType, TestScript, BackendTestOptions, FlowStep } from '@alt/shared';
import { buildK6Options, replaceK6Options } from './options';
import { log } from './logger';

export const stepsToKey = (steps: FlowStep[]): string => {
  const hash = createHash('sha256').update(JSON.stringify(steps)).digest('hex').slice(0, 16);
  return `flow:${hash}`;
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://alt_user:alt_password@localhost:5432/alt_db'
});

export const checkDbHealth = (): Promise<void> => pool.query('SELECT 1').then(() => undefined);

export const findExistingScript = async (
  targetUrl: string,
  testType: TestType,
  options?: BackendTestOptions,
  dbPool: Pool = pool,
  cacheKey?: string
): Promise<TestScript | null> => {
  const lookupKey = cacheKey ?? targetUrl;
  const lookupType = testType === 'flow' ? 'backend' : testType;
  const { rows } = await dbPool.query(
    'SELECT * FROM test_scripts WHERE target_url = $1 AND test_type = $2',
    [lookupKey, lookupType]
  );

  if (rows.length === 0) return null;

  await dbPool.query(
    'UPDATE test_scripts SET used_count = used_count + 1, updated_at = NOW() WHERE id = $1',
    [rows[0].id]
  );

  let script: string = rows[0].script;

  if (testType === 'backend' && options) {
    const newOptions = buildK6Options(options);
    script = replaceK6Options(script, newOptions);
    log.info({ profile: options.profile ?? 'load', vus: options.vus, duration: options.duration }, 'Injected new options into cached script');
  }

  return {
    id: rows[0].id,
    targetUrl: rows[0].target_url,
    testType: rows[0].test_type,
    script,
    usedCount: rows[0].used_count,
    createdAt: rows[0].created_at,
    updatedAt: rows[0].updated_at
  };
};
