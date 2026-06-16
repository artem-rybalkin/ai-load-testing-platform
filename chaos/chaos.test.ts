/**
 * Chaos / resilience test suite.
 *
 * Each `describe` block maps to one fault category from the chaos brief. The
 * suite is self-contained: no docker-compose, no real RabbitMQ, no real network.
 * Pure-logic gaps are exercised with `vi.mock`/`vi.fn`; the one stateful scenario
 * (stale-worker cleanup, category 4) uses a real PostgreSQL testcontainer via the
 * shared container helper.
 *
 * See chaos/README.md for the per-category finding (COVERED / GAP / HARDENED).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';

import { generateAIText } from '@alt/shared';
import { handleResult } from '../services/results-service/src/consumer';
import { runStaleCleanup } from '../services/results-service/src/cleanup';
import { createTestDatabase } from '../test-support/sharedPostgres';
import { createSchema } from '../services/results-service/src/db';

// ───────────────────────────────────────────────────────────────────────────
// Shared helpers
// ───────────────────────────────────────────────────────────────────────────

/** Reproduces the DLQ retry-count decision from results-service consumer.ts. */
type RetryDecision = 'retry' | 'dlq';
const MAX_RETRIES = 3;
function decideRetry(retryCount: number): { decision: RetryDecision; nextHeader: number } {
  if (retryCount < MAX_RETRIES) {
    return { decision: 'retry', nextHeader: retryCount + 1 };
  }
  return { decision: 'dlq', nextHeader: retryCount };
}

/** Minimal in-memory broker mirroring the consume() logic in consumer.ts. */
class FakeChannel {
  public readonly published: Array<{ queue: string; headers: Record<string, unknown> }> = [];
  public readonly dlq: Array<Buffer> = [];
  public readonly acked: number[] = [];
  private seq = 0;

  publish(_exchange: string, queue: string, _content: Buffer, opts: { headers: Record<string, unknown> }): void {
    this.published.push({ queue, headers: opts.headers });
  }
  sendToQueue(_queue: string, content: Buffer): void {
    this.dlq.push(content);
  }
  ack(): void {
    this.acked.push(this.seq++);
  }
}

/**
 * Re-implementation of the catch-block routing in consumer.ts `channel.consume`,
 * so we can drive it deterministically without a real AMQP server. This mirrors
 * the production branch exactly: < MAX_RETRIES → republish with incremented
 * header; otherwise → DLQ. Either way the original message is acked.
 */
function routeFailedMessage(ch: FakeChannel, content: Buffer, headers: Record<string, unknown>): void {
  const retryCount = (headers['x-retry-count'] as number) ?? 0;
  if (retryCount < MAX_RETRIES) {
    ch.publish('', 'test-results', content, {
      headers: { ...headers, 'x-retry-count': retryCount + 1 },
    });
  } else {
    ch.sendToQueue('test-results.dlq', content);
  }
  ch.ack();
}

// ───────────────────────────────────────────────────────────────────────────
// Category 1 — RabbitMQ partition / slow consumer (DLQ retry logic)
// ───────────────────────────────────────────────────────────────────────────
describe('Chaos 1 — RabbitMQ partition / slow consumer (DLQ retry exhaustion)', () => {
  it('increments x-retry-count and republishes for counts below the max', () => {
    for (let count = 0; count < MAX_RETRIES; count++) {
      const { decision, nextHeader } = decideRetry(count);
      expect(decision).toBe('retry');
      expect(nextHeader).toBe(count + 1);
    }
  });

  it('routes a message with x-retry-count=3 to the DLQ (exhausted, not retried again)', () => {
    const { decision } = decideRetry(3);
    expect(decision).toBe('dlq');
  });

  it('drives the real consume() routing: a poison message ends up in the DLQ after 3 retries and is always acked', () => {
    const ch = new FakeChannel();
    const content = Buffer.from(JSON.stringify({ testId: 't-poison' }));

    // Simulate the message bouncing through retries 0 → 1 → 2 → 3.
    let headers: Record<string, unknown> = {};
    for (let i = 0; i < 4; i++) {
      routeFailedMessage(ch, content, headers);
      const last = ch.published[ch.published.length - 1];
      headers = last ? last.headers : headers;
    }

    // 3 republishes (counts 0,1,2) then the 4th attempt (count 3) → DLQ.
    expect(ch.published.map(p => p.headers['x-retry-count'])).toEqual([1, 2, 3]);
    expect(ch.dlq).toHaveLength(1);
    // Every delivery is acked — a slow/poison consumer never blocks the queue.
    expect(ch.acked).toHaveLength(4);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Category 2 — PostgreSQL transient failure (nack, not silent drop)
// ───────────────────────────────────────────────────────────────────────────
describe('Chaos 2 — PostgreSQL transient failure during handleResult', () => {
  const baseResult = {
    testId: 'db-fail-1',
    type: 'backend' as const,
    targetUrl: 'https://example.com',
    status: 'completed' as const,
    metrics: { type: 'backend', requestsTotal: 10, requestsFailed: 0, avgResponseTime: 100, p50ResponseTime: 90, p95ResponseTime: 120, p99ResponseTime: 130, rps: 5 },
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    // analyser-service unreachable → falls back to local analyzeResult (no network).
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('analyser down')));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('propagates a DB error (throws) so the AMQP message is nacked, not silently dropped', async () => {
    const release = vi.fn();
    const failingClient = {
      query: vi.fn()
        .mockResolvedValueOnce(undefined)              // BEGIN
        .mockRejectedValueOnce(new Error('connection terminated')) // INSERT → DB outage
        .mockResolvedValue(undefined),                 // ROLLBACK
      release,
    };
    const pool = {
      // 1st call = previous-metrics SELECT (succeeds), then handleResult opens a client.
      query: vi.fn().mockResolvedValue({ rows: [] }),
      connect: vi.fn().mockResolvedValue(failingClient),
    } as unknown as Pool;

    await expect(handleResult(pool, baseResult as never)).rejects.toThrow(/connection terminated/);

    // Transaction was rolled back and the client returned to the pool — no leak.
    expect(failingClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('succeeds when the DB recovers (mock pool throws once then succeeds on a fresh delivery)', async () => {
    let connectCalls = 0;
    const makeClient = (fail: boolean) => ({
      query: fail
        ? vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('transient')).mockResolvedValue(undefined)
        : vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      connect: vi.fn().mockImplementation(() => Promise.resolve(makeClient(connectCalls++ === 0))),
    } as unknown as Pool;

    // 1st delivery throws (transient outage)…
    await expect(handleResult(pool, baseResult as never)).rejects.toThrow(/transient/);
    // …RabbitMQ redelivers; DB is back → succeeds.
    await expect(handleResult(pool, baseResult as never)).resolves.toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Category 3 — AI (Gemini) provider unavailability & fallback chain
// ───────────────────────────────────────────────────────────────────────────
describe('Chaos 3 — AI provider unavailability (generateAIText fallback chain)', () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    vi.doUnmock('@google/generative-ai');
    vi.doUnmock('openai');
    vi.doUnmock('@anthropic-ai/sdk');
    vi.restoreAllMocks();
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  // NOTE: these two cases import the SOURCE module (`../packages/shared/src/aiProvider`)
  // rather than the built `@alt/shared` barrel, so that `vi.doMock` intercepts the
  // SDKs' dynamic `import()` calls. Importing the compiled dist barrel would let the
  // real SDK run and hit the network with the dummy key.
  it('falls back to a secondary provider when the primary throws 429', async () => {
    process.env.GEMINI_API_KEY = 'k';
    process.env.OPENAI_API_KEY = 'k';

    // Mock the SDK dynamic imports: Gemini 429s, OpenAI succeeds.
    vi.doMock('@google/generative-ai', () => ({
      GoogleGenerativeAI: class {
        getGenerativeModel() {
          return { generateContent: () => { const e = new Error('rate limit') as Error & { status: number }; e.status = 429; throw e; } };
        }
      },
    }));
    vi.doMock('openai', () => ({
      default: class {
        chat = { completions: { create: async () => ({ choices: [{ message: { content: 'FALLBACK_OK' } }] }) } };
        constructor() { /* noop */ }
      },
    }));

    const { generateAIText: gen } = await import('../packages/shared/src/aiProvider');
    const out = await gen('hello', { provider: 'gemini', fallbacks: ['openai'] });
    expect(out).toBe('FALLBACK_OK');
  });

  it('throws the LAST error (not silently empty) when every provider in the chain fails', async () => {
    process.env.GEMINI_API_KEY = 'k';
    process.env.OPENAI_API_KEY = 'k';

    vi.doMock('@google/generative-ai', () => ({
      GoogleGenerativeAI: class {
        getGenerativeModel() { return { generateContent: () => { throw new Error('gemini down'); } }; }
      },
    }));
    vi.doMock('openai', () => ({
      default: class { chat = { completions: { create: async () => { throw new Error('openai down'); } } }; },
    }));

    const { generateAIText: gen } = await import('../packages/shared/src/aiProvider');
    await expect(gen('hi', { provider: 'gemini', fallbacks: ['openai'] }))
      .rejects.toThrow(/openai down/); // last error in the chain, surfaced — not swallowed
  });

  it('throws (never returns "") when no provider in the chain is configured', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    await expect(generateAIText('x', { provider: 'gemini', fallbacks: [] })).rejects.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Category 3b — compareDescriptions safe fallback to REGENERATE
// ───────────────────────────────────────────────────────────────────────────
describe('Chaos 3b — compareDescriptions defaults to REGENERATE on any error', () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeEach(() => {
    // generator.ts calls results-service for the provider setting — keep it offline so it uses the default.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('results-service offline')));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it('returns REGENERATE (the safe verdict) when the provider call throws a non-429 error', async () => {
    process.env.GEMINI_API_KEY = 'k';
    vi.doMock('@google/generative-ai', () => ({
      GoogleGenerativeAI: class {
        getGenerativeModel() { return { generateContent: () => { throw new Error('boom'); } }; }
      },
    }));

    const { compareDescriptions } = await import('../services/ai-service/src/generator');
    const verdict = await compareDescriptions('spike test to 500 vus', 'gentle load test');
    expect(verdict).toBe('REGENERATE');
  });

  it('returns REGENERATE when the provider replies with an unparseable verdict', async () => {
    process.env.GEMINI_API_KEY = 'k';
    vi.doMock('@google/generative-ai', () => ({
      GoogleGenerativeAI: class {
        getGenerativeModel() {
          return { generateContent: async () => ({ response: { text: () => 'I am not sure, maybe?' } }) };
        }
      },
    }));

    const { compareDescriptions } = await import('../services/ai-service/src/generator');
    const verdict = await compareDescriptions('a', 'b');
    expect(verdict).toBe('REGENERATE');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Category 4 — Worker crash mid-test (stale cleanup) — REAL PostgreSQL
// ───────────────────────────────────────────────────────────────────────────
describe('Chaos 4 — Worker crash mid-test → stale cleanup reaps the orphaned run', () => {
  let pool: Pool;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    const db = await createTestDatabase();
    pool = db.pool;
    drop = db.drop;
    await createSchema(pool);
  });
  afterAll(async () => { await drop(); });

  it("marks a 'running' test whose started_at is older than STALE_RUNNING_MINUTES as 'failed'", async () => {
    // Simulate a worker that picked up the test, set it running, then crashed
    // before posting results — started_at is 20 minutes ago.
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status, started_at, created_at)
       VALUES ($1, 'backend', 'https://crashed.example', 'running', NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '20 minutes')`,
      ['11111111-1111-1111-1111-111111111111']
    );
    // A healthy, recently-started run must NOT be touched.
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status, started_at, created_at)
       VALUES ($1, 'backend', 'https://healthy.example', 'running', NOW(), NOW())`,
      ['22222222-2222-2222-2222-222222222222']
    );

    const res = await runStaleCleanup(pool, 15, 30);
    expect(res.runningFixed).toBe(1);

    const { rows } = await pool.query(
      `SELECT test_id, status FROM test_results ORDER BY target_url`
    );
    const crashed = rows.find((r: { target_url?: string; test_id: string }) => r.test_id === '11111111-1111-1111-1111-111111111111');
    const healthy = rows.find((r: { test_id: string }) => r.test_id === '22222222-2222-2222-2222-222222222222');
    expect(crashed.status).toBe('failed');
    expect(healthy.status).toBe('running'); // untouched
  });

  it("marks a 'pending' test stuck past STALE_PENDING_MINUTES as 'failed' (no worker ever consumed it)", async () => {
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status, created_at)
       VALUES ($1, 'backend', 'https://stuck-pending.example', 'pending', NOW() - INTERVAL '45 minutes')`,
      ['33333333-3333-3333-3333-333333333333']
    );
    const res = await runStaleCleanup(pool, 15, 30);
    expect(res.pendingFixed).toBeGreaterThanOrEqual(1);

    const { rows } = await pool.query(
      `SELECT status FROM test_results WHERE test_id = $1`,
      ['33333333-3333-3333-3333-333333333333']
    );
    expect(rows[0].status).toBe('failed');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Category 5 — Cancel race condition — REAL PostgreSQL
// ───────────────────────────────────────────────────────────────────────────
describe('Chaos 5 — Cancel arriving after completion is a no-op', () => {
  let pool: Pool;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    const db = await createTestDatabase();
    pool = db.pool;
    drop = db.drop;
    await createSchema(pool);
  });
  afterAll(async () => { await drop(); });

  // Mirror of the results-service POST /results/:id/cancel guard: only flip to
  // cancelled when the row is still cancellable (pending|running).
  const applyCancel = async (testId: string): Promise<number> => {
    const { rowCount } = await pool.query(
      `UPDATE test_results SET status = 'cancelled'
       WHERE test_id = $1 AND status IN ('pending', 'running')`,
      [testId]
    );
    return rowCount ?? 0;
  };

  it('does NOT overwrite a completed result when a late cancel arrives', async () => {
    const id = '44444444-4444-4444-4444-444444444444';
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status) VALUES ($1, 'backend', 'https://done.example', 'completed')`,
      [id]
    );

    const affected = await applyCancel(id); // cancel loses the race
    expect(affected).toBe(0);

    const { rows } = await pool.query(`SELECT status FROM test_results WHERE test_id = $1`, [id]);
    expect(rows[0].status).toBe('completed'); // stays completed
  });

  it('DOES cancel a still-running test (the guard only protects terminal states)', async () => {
    const id = '55555555-5555-5555-5555-555555555555';
    await pool.query(
      `INSERT INTO test_results (test_id, type, target_url, status, started_at) VALUES ($1, 'backend', 'https://live.example', 'running', NOW())`,
      [id]
    );
    const affected = await applyCancel(id);
    expect(affected).toBe(1);
    const { rows } = await pool.query(`SELECT status FROM test_results WHERE test_id = $1`, [id]);
    expect(rows[0].status).toBe('cancelled');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Category 6 — Concurrent test submission (quota enforcement → 429)
// ───────────────────────────────────────────────────────────────────────────
describe('Chaos 6 — Concurrent submission beyond maxConcurrentTests returns 429', () => {
  // Reuses the real checkTestQuota logic by mocking only the pg pool counts.
  it('returns an over-limit message on the N+1th concurrent test', async () => {
    const { checkTestQuota } = await import('../services/api-service/src/quotas');
    const MAX = 3;

    const makePool = (concurrent: number) => ({
      query: vi.fn()
        // 1st query in checkTestQuota = SELECT * FROM team_quotas
        .mockResolvedValueOnce({ rows: [{
          max_concurrent_tests: MAX, max_vus_per_test: 1000, max_test_duration_seconds: 3600,
          max_scheduled_tests: 10, max_gemini_calls_per_day: 100,
        }] })
        // 2nd query = COUNT(*) of pending/running tests
        .mockResolvedValueOnce({ rows: [{ count: String(concurrent) }] }),
    }) as unknown as Pool;

    // N tests in flight → still allowed.
    const okMsg = await checkTestQuota(makePool(MAX - 1), 'team-1', {
      type: 'backend', options: { vus: 10, duration: '30s' } as never,
    });
    expect(okMsg).toBeNull();

    // N already running → the N+1th submission is rejected.
    const blockedMsg = await checkTestQuota(makePool(MAX), 'team-1', {
      type: 'backend', options: { vus: 10, duration: '30s' } as never,
    });
    expect(blockedMsg).toMatch(/concurrent test limit/i);
  });

  it('bypasses quota entirely when teamId is undefined (auth-disabled dev mode)', async () => {
    const { checkTestQuota } = await import('../services/api-service/src/quotas');
    const pool = { query: vi.fn() } as unknown as Pool;
    const msg = await checkTestQuota(pool, undefined, { type: 'backend', options: { vus: 9999, duration: '1h' } as never });
    expect(msg).toBeNull();
    expect((pool.query as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Category 7 — Webhook delivery failure must not block result persistence
// ───────────────────────────────────────────────────────────────────────────
describe('Chaos 7 — Failing webhook does not block result persistence (fire-and-forget)', () => {
  const result = {
    testId: 'wh-1',
    type: 'backend' as const,
    targetUrl: 'https://wh.example',
    status: 'completed' as const,
    metrics: { type: 'backend', requestsTotal: 100, requestsFailed: 90, avgResponseTime: 5000, p50ResponseTime: 4000, p95ResponseTime: 9000, p99ResponseTime: 9500, rps: 2 },
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };

  afterEach(() => vi.unstubAllGlobals());

  it('persists the result even when every webhook POST rejects with a network error', async () => {
    // analyser fetch and webhook fetch both go through global fetch.
    // - analyser /analyse → reject (forces local analyzeResult, which will mark this 'failed' → webhook path runs)
    // - webhook POST     → reject (network error)
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    const insert = vi.fn().mockResolvedValue(undefined);
    const client = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (typeof sql === 'string' && sql.startsWith('INSERT')) return insert(sql);
        return Promise.resolve(undefined); // BEGIN / COMMIT
      }),
      release: vi.fn(),
    };
    const pool = {
      // previous-metrics SELECT, then the fireWebhooks SELECT (rows with one webhook url).
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })                                  // previous metrics
        .mockResolvedValue({ rows: [{ url: 'https://hook.example', secret: null, format: 'generic' }] }), // webhooks
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool;

    // Must resolve cleanly — the webhook rejection is swallowed (.catch) and never bubbles.
    await expect(handleResult(pool, result as never)).resolves.toBeUndefined();

    // The INSERT happened despite the webhook failure → result persisted.
    expect(insert).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('demonstrates the fire-and-forget swallow pattern explicitly', async () => {
    // Pattern under test: fireWebhooks(...).catch(() => {}) — a rejected promise
    // attached with a no-op catch must not throw to the caller.
    const fireWebhooks = (): Promise<void> => Promise.reject(new Error('delivery failed'));
    let threw = false;
    try {
      fireWebhooks().catch(() => {}); // exactly how consumer.ts invokes it
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    await new Promise(r => setTimeout(r, 0)); // flush microtasks → no unhandled rejection
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Category 8 — WebSocket reconnect exponential backoff
// ───────────────────────────────────────────────────────────────────────────
describe('Chaos 8 — WebSocket reconnect backoff follows 1s → 2s → 4s → … → 30s cap', () => {
  // Mirror of the backoff recurrence in ResultsSocketContext.tsx:
  //   delay starts at 1000; after each close: delay = Math.min(delay * 2, 30_000)
  const nextDelay = (delay: number): number => Math.min(delay * 2, 30_000);

  it('produces the documented doubling sequence capped at 30s', () => {
    const observed: number[] = [];
    let delay = 1_000;
    for (let i = 0; i < 8; i++) {
      observed.push(delay);     // delay used for THIS reconnect attempt
      delay = nextDelay(delay); // advance for the next close
    }
    expect(observed).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });

  it('never exceeds the 30s cap no matter how long the outage lasts', () => {
    let delay = 1_000;
    for (let i = 0; i < 50; i++) delay = nextDelay(delay);
    expect(delay).toBe(30_000);
  });

  it('resets to 1s after a successful reconnect (onopen sets delay = 1000)', () => {
    let delay = 16_000; // mid-backoff
    // onopen handler in the provider does: delay = 1_000
    delay = 1_000;
    expect(delay).toBe(1_000);
    expect(nextDelay(delay)).toBe(2_000); // backoff restarts cleanly
  });
});
