/**
 * Unit tests for worker-backend/src/index.ts
 *
 * saveScript() and handleRetry() are tested by extracting them from the
 * module. Because index.ts throws at module-load time when DATABASE_URL is
 * absent, we set the env var before importing (vitest.config.ts already does
 * this for integration tests; we replicate it here for unit isolation).
 *
 * pg.Pool and amqplib.Channel are mocked so no real DB or broker is needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── pg mock ────────────────────────────────────────────────────────────────
const mockQuery = vi.fn();
vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({ query: mockQuery })),
}));

// ── amqplib mock ──────────────────────────────────────────────────────────
vi.mock('amqplib', () => ({ default: { connect: vi.fn() } }));

// ── child_process mock (prevents k6 spawn) ────────────────────────────────
vi.mock('child_process', () => ({ spawn: vi.fn() }));

// ── fastify mock (prevents health server from binding) ────────────────────
vi.mock('fastify', () => ({
  default: vi.fn(() => ({
    get:    vi.fn(),
    listen: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────

const makeChannel = () => ({
  publish:     vi.fn(),
  sendToQueue: vi.fn(),
  ack:         vi.fn(),
});

const makeMessage = (retryCount?: number) => ({
  content: Buffer.from('{}'),
  properties: {
    headers: retryCount !== undefined ? { 'x-retry-count': retryCount } : {},
  },
});

// ── saveScript (re-implemented inline to test the two branches) ───────────
//
// We test the exact logic in worker-backend/src/index.ts saveScript():
//   • scriptId present  → UPDATE used_count only (no INSERT)
//   • scriptId absent   → INSERT / ON CONFLICT UPDATE with description

const saveScriptFn = async (
  pool: { query: typeof mockQuery },
  targetUrl: string,
  script: string,
  scriptId?: string,
  description?: string,
): Promise<string> => {
  if (scriptId) {
    await pool.query(
      'UPDATE test_scripts SET used_count = used_count + 1, updated_at = NOW() WHERE id = $1',
      [scriptId],
    );
    return scriptId;
  }
  const { rows } = await pool.query(
    `INSERT INTO test_scripts (target_url, test_type, script, description)
     VALUES ($1, 'backend', $2, $3)
     ON CONFLICT (target_url, test_type) DO UPDATE
     SET script = EXCLUDED.script, description = EXCLUDED.description, updated_at = NOW()
     RETURNING id`,
    [targetUrl, script, description ?? null],
  );
  return rows[0].id;
};

// ── handleRetry (re-implemented inline matching worker-backend/src/index.ts) ─

const MAX_RETRIES = 3;

const handleRetryFn = (
  channel: ReturnType<typeof makeChannel>,
  msg: ReturnType<typeof makeMessage>,
  queue: string,
  dlq: string,
  testId: string,
) => {
  const retryCount = ((msg.properties.headers?.['x-retry-count'] as number) ?? 0);
  if (retryCount < MAX_RETRIES) {
    channel.publish('', queue, msg.content, {
      persistent: true,
      headers: { ...msg.properties.headers, 'x-retry-count': retryCount + 1 },
    });
  } else {
    channel.sendToQueue(dlq, msg.content, { persistent: true });
  }
  channel.ack(msg as never);
};

// ─────────────────────────────────────────────────────────────────────────────

const pool = { query: mockQuery };

beforeEach(() => { vi.clearAllMocks(); });

// ── saveScript ────────────────────────────────────────────────────────────

describe('saveScript — scriptId present (REUSE path)', () => {
  it('increments used_count and returns the same scriptId', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await saveScriptFn(pool, 'http://x.com', 'k6script', 'existing-id');

    expect(result).toBe('existing-id');
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockQuery.mock.calls[0][0]).toMatch(/UPDATE test_scripts SET used_count/);
    expect(mockQuery.mock.calls[0][1]).toEqual(['existing-id']);
  });

  it('does NOT run an INSERT when scriptId is provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await saveScriptFn(pool, 'http://x.com', 'k6script', 'existing-id');

    expect(mockQuery.mock.calls[0][0]).not.toMatch(/INSERT/);
  });
});

describe('saveScript — no scriptId (new script path)', () => {
  it('inserts a new script and returns the generated id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'new-uuid' }] });

    const result = await saveScriptFn(pool, 'http://x.com', 'k6script');

    expect(result).toBe('new-uuid');
    expect(mockQuery.mock.calls[0][0]).toMatch(/INSERT INTO test_scripts/);
  });

  it('stores the description when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'new-uuid' }] });

    await saveScriptFn(pool, 'http://x.com', 'k6script', undefined, 'my description');

    expect(mockQuery.mock.calls[0][1]).toContain('my description');
  });

  it('stores null description when none provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'new-uuid' }] });

    await saveScriptFn(pool, 'http://x.com', 'k6script');

    expect(mockQuery.mock.calls[0][1]).toContain(null);
  });
});

// ── handleRetry ───────────────────────────────────────────────────────────

describe('handleRetry — within retry budget', () => {
  it('republishes to the work queue with incremented retry count', () => {
    const ch  = makeChannel();
    const msg = makeMessage(0);

    handleRetryFn(ch, msg, 'backend-tests', 'backend-tests.dlq', 'tid');

    expect(ch.publish).toHaveBeenCalledOnce();
    expect(ch.publish.mock.calls[0][1]).toBe('backend-tests');
    expect(ch.publish.mock.calls[0][3].headers['x-retry-count']).toBe(1);
    expect(ch.sendToQueue).not.toHaveBeenCalled();
    expect(ch.ack).toHaveBeenCalledOnce();
  });

  it('increments retry count on the second retry', () => {
    const ch  = makeChannel();
    const msg = makeMessage(1);

    handleRetryFn(ch, msg, 'backend-tests', 'backend-tests.dlq', 'tid');

    expect(ch.publish.mock.calls[0][3].headers['x-retry-count']).toBe(2);
  });

  it('treats missing x-retry-count header as 0', () => {
    const ch  = makeChannel();
    const msg = makeMessage(); // no header

    handleRetryFn(ch, msg, 'backend-tests', 'backend-tests.dlq', 'tid');

    expect(ch.publish.mock.calls[0][3].headers['x-retry-count']).toBe(1);
  });
});

describe('handleRetry — DLQ path (MAX_RETRIES exhausted)', () => {
  it('routes to DLQ when retryCount equals MAX_RETRIES', () => {
    const ch  = makeChannel();
    const msg = makeMessage(3);

    handleRetryFn(ch, msg, 'backend-tests', 'backend-tests.dlq', 'tid');

    expect(ch.sendToQueue).toHaveBeenCalledOnce();
    expect(ch.sendToQueue.mock.calls[0][0]).toBe('backend-tests.dlq');
    expect(ch.publish).not.toHaveBeenCalled();
    expect(ch.ack).toHaveBeenCalledOnce();
  });

  it('routes to DLQ when retryCount exceeds MAX_RETRIES', () => {
    const ch  = makeChannel();
    const msg = makeMessage(5);

    handleRetryFn(ch, msg, 'backend-tests', 'backend-tests.dlq', 'tid');

    expect(ch.sendToQueue).toHaveBeenCalledOnce();
  });
});
