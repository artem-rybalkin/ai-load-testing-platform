import { Pool } from 'pg';

import { TestType, TestScript, BackendTestOptions } from '@alt/shared';
import { buildK6Options, replaceK6Options } from './options';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://alt_user:alt_password@localhost:5432/alt_db'
});

export const findExistingScript = async (
  targetUrl: string,
  testType: TestType,
  options?: BackendTestOptions,
  dbPool: Pool = pool
): Promise<TestScript | null> => {
  const { rows } = await dbPool.query(
    'SELECT * FROM test_scripts WHERE target_url = $1 AND test_type = $2',
    [targetUrl, testType]
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
    console.log(`Injected new options (profile=${options.profile ?? 'load'}, vus=${options.vus}, duration=${options.duration}) into cached script`);
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
