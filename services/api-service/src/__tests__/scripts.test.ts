import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createTestDatabase, truncateAll } from '../../../../test-support/sharedPostgres';
import { findExistingScript, stepsToKey, incrementUsedCount, pool as scriptsPool } from '../scripts';
import type { FlowStep, BackendTestOptions } from '@alt/shared';

let pool: Pool;
let dropDb: () => Promise<void>;

const createSchema = async (p: Pool): Promise<void> => {
  await p.query(`
    CREATE TABLE IF NOT EXISTS test_scripts (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      target_url  TEXT NOT NULL,
      test_type   VARCHAR(20) NOT NULL,
      script      TEXT NOT NULL,
      description TEXT,
      used_count  INTEGER DEFAULT 1,
      project_id  UUID,
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
  ({ pool, drop: dropDb } = await createTestDatabase());
  await createSchema(pool);
}, 60_000);

afterAll(async () => {
  await dropDb();
});

beforeEach(async () => {
  await truncateAll(pool, 'TRUNCATE test_scripts CASCADE');
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
      result!.script.match(/export const options = (\{[\s\S]*?\});/)![1]! // capture group 1 is required by the pattern
    );
    expect(parsed.stages).toHaveLength(3);
    const plateau = parsed.stages.find((s: { target: number }) => s.target === 20);
    expect(plateau).toBeDefined();
  });

  it('injects capacity-profile abortOnFail thresholds, falling open to the default when app_settings has no override (or doesn\'t exist)', async () => {
    const scriptWithOptions = [
      "import http from 'k6/http';",
      'export const options = { vus: 5, duration: \'30s\' };',
      "export default function() { http.get('http://example.com'); }",
    ].join('\n');
    await insertScript(pool, 'http://capacity-test.com', 'backend', scriptWithOptions);

    const result = await findExistingScript(
      'http://capacity-test.com',
      'backend',
      { vus: 10, duration: '5m', profile: 'capacity' },
      pool,
    );

    expect(result).not.toBeNull();
    const parsed = JSON.parse(
      result!.script.match(/export const options = (\{[\s\S]*?\});/)![1]! // capture group 1 is required by the pattern
    );
    // This test's local schema (createSchema above) has no app_settings table at
    // all — getCapacityAbortConfig must fail open to the hardcoded default
    // rather than throwing and breaking cache-hit re-injection entirely.
    expect(parsed.thresholds.http_req_duration).toEqual([
      'p(90)<1600',
      { threshold: 'p(95)<2000', abortOnFail: true, delayAbortEval: '10s' },
      'p(99)<4000',
    ]);
  });

  it('returns script unchanged for client-side type even when options provided', async () => {
    const clientScript = 'const page = await browser.newPage();';
    await insertScript(pool, 'http://client-test.com', 'client-side', clientScript);

    const result = await findExistingScript(
      'http://client-test.com',
      'client-side',
      { vus: 10, duration: '1m' } as unknown as BackendTestOptions,
      pool
    );

    expect(result).not.toBeNull();
    expect(result!.script).toBe(clientScript);
  });

  // ── flow type — lookup by stepsToKey hash key ────────────────────────────────

  describe('flow type — hash-key lookup', () => {
    const stepsA: FlowStep[] = [
      { name: 'home', url: 'https://example.com/', method: 'GET', headers: {}, extract: {} },
      { name: 'login', url: 'https://example.com/login', method: 'POST', headers: {}, extract: {} },
    ];
    const stepsB: FlowStep[] = [
      { name: 'home', url: 'https://example.com/', method: 'GET', headers: {}, extract: {} },
      { name: 'checkout', url: 'https://example.com/checkout', method: 'POST', headers: {}, extract: {} },
    ];

    it('returns null on the first lookup (cache miss) for a flow steps hash key', async () => {
      const cacheKey = stepsToKey(stepsA);

      const result = await findExistingScript(
        'https://example.com/',
        'flow',
        undefined,
        pool,
        cacheKey
      );

      expect(result).toBeNull();
    });

    it('hits the cache on a second lookup with the same steps (same hash key)', async () => {
      const cacheKey = stepsToKey(stepsA);
      const flowScript = "export default function() { /* flow */ }";

      // Flow scripts are stored under test_type = 'backend' keyed by the hash
      await insertScript(pool, cacheKey, 'backend', flowScript);

      const result = await findExistingScript(
        'https://example.com/',
        'flow',
        undefined,
        pool,
        cacheKey
      );

      expect(result).not.toBeNull();
      expect(result!.script).toBe(flowScript);
      expect(result!.targetUrl).toBe(cacheKey);
    });

    it('produces a different hash key for different steps, resulting in a cache miss', async () => {
      const cacheKeyA = stepsToKey(stepsA);
      const cacheKeyB = stepsToKey(stepsB);
      expect(cacheKeyA).not.toBe(cacheKeyB);

      const flowScript = "export default function() { /* flow A */ }";
      await insertScript(pool, cacheKeyA, 'backend', flowScript);

      // Looking up with a different steps array (different hash key) misses
      const result = await findExistingScript(
        'https://example.com/',
        'flow',
        undefined,
        pool,
        cacheKeyB
      );

      expect(result).toBeNull();
    });

    it('same steps array produces a stable cache key across repeated calls', () => {
      expect(stepsToKey(stepsA)).toBe(stepsToKey(stepsA));
      expect(stepsToKey([...stepsA])).toBe(stepsToKey(stepsA));
    });
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

  it('produces the exact same key with setupFirstStep unset vs explicitly false — existing cached flow scripts stay valid', () => {
    const steps = [makeStep('https://example.com/login', 'POST')];
    expect(stepsToKey(steps)).toBe(stepsToKey(steps, undefined));
    expect(stepsToKey(steps)).toBe(stepsToKey(steps, false));
  });

  it('produces a different key when setupFirstStep is true, so a structural script change forces regeneration', () => {
    const steps = [makeStep('https://example.com/login', 'POST')];
    expect(stepsToKey(steps, true)).not.toBe(stepsToKey(steps));
  });

  it('produces the exact same key when userPercent is unset, so existing cached flow scripts stay valid', () => {
    const steps = [makeStep('https://example.com/login', 'POST')];
    expect(stepsToKey(steps)).toBe(stepsToKey(steps.map(s => ({ ...s }))));
  });

  it('produces a different key when a step sets userPercent, forcing regeneration for a distribution-only edit', () => {
    const steps = [makeStep('https://example.com/login', 'POST')];
    const withPercent = [{ ...steps[0]!, userPercent: 60 }];
    expect(stepsToKey(withPercent)).not.toBe(stepsToKey(steps));
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

describe('pool config', () => {
  it('sets explicit max/idleTimeoutMillis/connectionTimeoutMillis instead of relying on pg defaults', () => {
    expect(scriptsPool.options.max).toBe(10);
    expect(scriptsPool.options.idleTimeoutMillis).toBe(30_000);
    expect(scriptsPool.options.connectionTimeoutMillis).toBe(5_000);
  });
});
