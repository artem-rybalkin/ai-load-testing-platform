import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { findExistingScript, stepsToKey, incrementUsedCount } from '../scripts';
import type { FlowStep } from '@alt/shared';

let container: StartedPostgreSqlContainer;
let pool: Pool;

const createSchema = async (p: Pool): Promise<void> => {
  await p.query(`
    CREATE TABLE IF NOT EXISTS test_scripts (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      target_url  TEXT NOT NULL,
      test_type   VARCHAR(20) NOT NULL,
      script      TEXT NOT NULL,
      description TEXT,
      used_count  INTEGER DEFAULT 1,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(target_url, test_type)
    )
  `);
};

const insertScript = async (
  p: Pool,
  targetUrl: string,
  testType: string,
  script: string,
  usedCount = 1,
  description?: string
): Promise<string> => {
  const { rows } = await p.query(
    `INSERT INTO test_scripts (target_url, test_type, script, used_count, description)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [targetUrl, testType, script, usedCount, description ?? null]
  );
  return rows[0].id as string;
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await createSchema(pool);
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE test_scripts CASCADE');
});

// ─── findExistingScript ───────────────────────────────────────────────────────

describe('findExistingScript', () => {
  it('returns null when no script exists for the URL', async () => {
    const result = await findExistingScript(
      'http://not-in-db.com',
      'backend',
      undefined,
      pool
    );

    expect(result).toBeNull();
  });

  it('returns the script without incrementing used_count', async () => {
    await insertScript(pool, 'http://example.com', 'backend', 'export default function(){}', 3);

    const result = await findExistingScript('http://example.com', 'backend', undefined, pool);

    expect(result).not.toBeNull();
    expect(result!.targetUrl).toBe('http://example.com');
    expect(result!.testType).toBe('backend');

    const { rows } = await pool.query(
      'SELECT used_count FROM test_scripts WHERE target_url = $1',
      ['http://example.com']
    );
    // used_count must NOT be incremented by findExistingScript — caller decides
    expect(rows[0].used_count).toBe(3);
  });

  it('returns the stored description', async () => {
    await insertScript(pool, 'http://desc-test.com', 'backend', 'export default function(){}', 1, 'load test 10 users 1 min');

    const result = await findExistingScript('http://desc-test.com', 'backend', undefined, pool);

    expect(result).not.toBeNull();
    expect(result!.description).toBe('load test 10 users 1 min');
  });

  it('returns null description when script was inserted without one', async () => {
    await insertScript(pool, 'http://no-desc.com', 'backend', 'export default function(){}');

    const result = await findExistingScript('http://no-desc.com', 'backend', undefined, pool);

    expect(result).not.toBeNull();
    expect(result!.description).toBeNull();
  });

  it('injects new options into the cached script for backend type', async () => {
    const scriptWithOptions = [
      "import http from 'k6/http';",
      'export const options = {',
      '  vus: 5,',
      "  duration: '30s',",
      '};',
      "export default function() { http.get('http://example.com'); }",
    ].join('\n');

    await insertScript(pool, 'http://options-test.com', 'backend', scriptWithOptions);

    const result = await findExistingScript(
      'http://options-test.com',
      'backend',
      { vus: 20, duration: '2m', profile: 'load' },
      pool
    );

    expect(result).not.toBeNull();
    expect(result!.script).toContain('export const options =');
    expect(result!.script).not.toContain('vus: 5');

    const parsed = JSON.parse(
      result!.script.match(/export const options = (\{[\s\S]*?\});/)![1]
    );
    expect(parsed.stages).toHaveLength(3);
    const plateau = parsed.stages.find((s: { target: number }) => s.target === 20);
    expect(plateau).toBeDefined();
  });

  it('returns script unchanged for client-side type even when options provided', async () => {
    const clientScript = 'const page = await browser.newPage();';
    await insertScript(pool, 'http://client-test.com', 'client-side', clientScript);

    const result = await findExistingScript(
      'http://client-test.com',
      'client-side',
      { vus: 10, duration: '1m' } as any,
      pool
    );

    expect(result).not.toBeNull();
    expect(result!.script).toBe(clientScript);
  });
});

// ─── stepsToKey ───────────────────────────────────────────────────────────────
// Pure function — no DB needed, no Testcontainers

describe('stepsToKey', () => {
  const makeStep = (url: string, method = 'GET'): FlowStep => ({
    name: `Step: ${method} ${url}`,
    url,
    method: method as FlowStep['method'],
    headers: {},
    extract: {},
  });

  it('returns a string in the format "flow:<16 hex chars>"', () => {
    expect(stepsToKey([])).toMatch(/^flow:[0-9a-f]{16}$/);
  });

  it('is deterministic — same input always produces the same key', () => {
    const steps = [makeStep('https://example.com/login', 'POST')];
    expect(stepsToKey(steps)).toBe(stepsToKey(steps));
  });

  it('produces different keys for different step arrays', () => {
    const a = [makeStep('https://example.com/a', 'GET')];
    const b = [makeStep('https://example.com/b', 'POST')];
    expect(stepsToKey(a)).not.toBe(stepsToKey(b));
  });

  it('produces a stable key for an empty array', () => {
    expect(stepsToKey([])).toBe(stepsToKey([]));
  });

  it('the 16-char suffix is lowercase hex', () => {
    const hash = stepsToKey([makeStep('https://example.com')]).replace('flow:', '');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });
});

// ─── incrementUsedCount ───────────────────────────────────────────────────────
// Uses an injected mock pool — no Testcontainers

describe('incrementUsedCount', () => {
  it('runs the correct UPDATE SQL with the supplied id', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await incrementUsedCount('uuid-abc', mockPool as unknown as Pool);

    const [sql, params] = mockPool.query.mock.calls[0] as [string, string[]];
    expect(sql).toContain('UPDATE test_scripts');
    expect(sql).toContain('used_count = used_count + 1');
    expect(sql).toContain('updated_at = NOW()');
    expect(params).toEqual(['uuid-abc']);
  });

  it('returns void on success', async () => {
    const mockPool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const result = await incrementUsedCount('uuid-def', mockPool as unknown as Pool);
    expect(result).toBeUndefined();
  });
});
