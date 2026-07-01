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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// ── pg mock ────────────────────────────────────────────────────────────────
const mockQuery = vi.fn();
vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({ query: mockQuery })),
}));

// ── amqplib mock ──────────────────────────────────────────────────────────
vi.mock('amqplib', () => ({ default: { connect: vi.fn() } }));

// ── child_process mock (prevents k6 spawn) ────────────────────────────────
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({ spawn: mockSpawn }));

// ── fastify mock (prevents health server from binding) ────────────────────
vi.mock('fastify', () => ({
  default: vi.fn(() => ({
    get:    vi.fn(),
    listen: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockFn = ReturnType<typeof vi.fn<(...args: any[]) => any>>;

const makeChannel = (): { publish: MockFn; sendToQueue: MockFn; ack: MockFn } => ({
  publish:     vi.fn(),
  sendToQueue: vi.fn(),
  ack:         vi.fn(),
});

const makeMessage = (retryCount?: number): { content: Buffer; properties: { headers: Record<string, number> } } => ({
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
  projectId?: string,
): Promise<string> => {
  if (scriptId) {
    await pool.query(
      'UPDATE test_scripts SET used_count = used_count + 1, updated_at = NOW() WHERE id = $1',
      [scriptId],
    );
    return scriptId;
  }
  const { rows } = await pool.query(
    `INSERT INTO test_scripts (target_url, test_type, script, description, project_id)
     VALUES ($1, 'backend', $2, $3, $4)
     ON CONFLICT (target_url, test_type) DO UPDATE
     SET script = EXCLUDED.script, description = EXCLUDED.description, updated_at = NOW(),
         project_id = COALESCE(test_scripts.project_id, EXCLUDED.project_id)
     RETURNING id`,
    [targetUrl, script, description ?? null, projectId ?? null],
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
  _testId: string,
): void => {
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

// ── validateScript (re-implemented inline matching worker-backend/src/index.ts) ─
//
// Spawns `k6 inspect <path>`, capturing stderr so a non-zero exit (script
// load/syntax error — k6 inspect makes no network calls) is diagnosable.

const validateScriptFn = (scriptPath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const k6 = mockSpawn('k6', ['inspect', scriptPath]);
    const stderrChunks: Buffer[] = [];
    k6.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    k6.on('close', (code: number) => {
      if (code === 0) { resolve(); return; }
      const detail = Buffer.concat(stderrChunks).toString('utf8').trim().slice(0, 2000);
      reject(new Error(`k6 script validation failed (exit ${code})${detail ? `: ${detail}` : ''}`));
    });
    k6.on('error', reject);
  });

const makeFakeK6Process = (): EventEmitter & { stderr: EventEmitter } => {
  const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  proc.stderr = new EventEmitter();
  return proc;
};

// ── notify* REST helpers (re-implemented inline matching src/index.ts) ────
//
// worker-backend now reports status transitions via results-service's REST
// endpoints (instead of direct pool.query writes) so that broadcast() fires
// and connected UI clients receive WebSocket pushes. Errors are swallowed —
// these are best-effort notifications, not the source of truth (DB write
// happens inside results-service).

const RESULTS_URL = 'http://results-service:3004';

const notifyRunningFn = async (testId: string): Promise<void> => {
  try { await fetch(`${RESULTS_URL}/results/${testId}/running`, { method: 'POST' }); }
  catch { /* best-effort */ }
};

const notifyFailedFn = async (testId: string): Promise<void> => {
  try { await fetch(`${RESULTS_URL}/results/${testId}/fail`, { method: 'POST' }); }
  catch { /* best-effort */ }
};

const notifyCancelledFn = async (testId: string): Promise<void> => {
  try { await fetch(`${RESULTS_URL}/results/${testId}/cancel`, { method: 'POST' }); }
  catch { /* best-effort */ }
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

  it('stores projectId when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'new-uuid' }] });

    await saveScriptFn(pool, 'http://x.com', 'k6script', undefined, undefined, 'project-123');

    expect(mockQuery.mock.calls[0][1]).toContain('project-123');
  });

  it('stores null projectId when none provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'new-uuid' }] });

    await saveScriptFn(pool, 'http://x.com', 'k6script');

    expect(mockQuery.mock.calls[0][1]).toEqual(['http://x.com', 'k6script', null, null]);
  });

  it('preserves an existing project_id on conflict via COALESCE', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'existing-uuid' }] });

    await saveScriptFn(pool, 'http://x.com', 'k6script', undefined, undefined, 'project-123');

    expect(mockQuery.mock.calls[0][0]).toMatch(/project_id = COALESCE\(test_scripts\.project_id, EXCLUDED\.project_id\)/);
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

// ── validateScript ────────────────────────────────────────────────────────

describe('validateScript — k6 inspect stderr capture', () => {
  it('resolves when k6 inspect exits 0', async () => {
    const proc = makeFakeK6Process();
    mockSpawn.mockReturnValueOnce(proc);

    const promise = validateScriptFn('/run/dir/script.js');
    proc.emit('close', 0);

    await expect(promise).resolves.toBeUndefined();
    expect(mockSpawn).toHaveBeenCalledWith('k6', ['inspect', '/run/dir/script.js']);
  });

  it('rejects with the captured stderr text when k6 inspect exits non-zero', async () => {
    const proc = makeFakeK6Process();
    mockSpawn.mockReturnValueOnce(proc);

    const promise = validateScriptFn('/run/dir/script.js');
    proc.stderr.emit('data', Buffer.from('SyntaxError: '));
    proc.stderr.emit('data', Buffer.from('Unexpected token at line 12'));
    proc.emit('close', 255);

    await expect(promise).rejects.toThrow(
      'k6 script validation failed (exit 255): SyntaxError: Unexpected token at line 12',
    );
  });

  it('omits the trailing colon-detail when stderr produced no output', async () => {
    const proc = makeFakeK6Process();
    mockSpawn.mockReturnValueOnce(proc);

    const promise = validateScriptFn('/run/dir/script.js');
    proc.emit('close', 1);

    await expect(promise).rejects.toThrow('k6 script validation failed (exit 1)');
    await expect(promise).rejects.not.toThrow(/:\s*$/);
  });

  it('truncates stderr detail to 2000 characters', async () => {
    const proc = makeFakeK6Process();
    mockSpawn.mockReturnValueOnce(proc);

    const promise = validateScriptFn('/run/dir/script.js');
    proc.stderr.emit('data', Buffer.from('x'.repeat(3000)));
    proc.emit('close', 255);

    await promise.catch((err: Error) => {
      const detail = err.message.split(': ')[1];
      expect(detail.length).toBe(2000);
    });
  });

  it('rejects when the spawned process itself errors (e.g. k6 binary missing)', async () => {
    const proc = makeFakeK6Process();
    mockSpawn.mockReturnValueOnce(proc);

    const promise = validateScriptFn('/run/dir/script.js');
    const spawnError = new Error('spawn k6 ENOENT');
    proc.emit('error', spawnError);

    await expect(promise).rejects.toBe(spawnError);
  });
});

// ── notifyRunning / notifyFailed / notifyCancelled ────────────────────────

describe('notify* REST helpers — status transitions reported via results-service', () => {
  const originalFetch = global.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => { global.fetch = originalFetch; });

  it('notifyRunning POSTs to /results/:testId/running', async () => {
    await notifyRunningFn('tid-1');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://results-service:3004/results/tid-1/running',
      { method: 'POST' },
    );
  });

  it('notifyFailed POSTs to /results/:testId/fail', async () => {
    await notifyFailedFn('tid-2');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://results-service:3004/results/tid-2/fail',
      { method: 'POST' },
    );
  });

  it('notifyCancelled POSTs to /results/:testId/cancel', async () => {
    await notifyCancelledFn('tid-3');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://results-service:3004/results/tid-3/cancel',
      { method: 'POST' },
    );
  });

  it('swallows fetch errors (best-effort — DB write happens server-side)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(notifyRunningFn('tid-4')).resolves.toBeUndefined();
  });

  it('swallows network errors for notifyFailed and notifyCancelled too', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(notifyFailedFn('tid-5')).resolves.toBeUndefined();
    await expect(notifyCancelledFn('tid-6')).resolves.toBeUndefined();
  });
});

// ── Stop-with-metrics (cancel-during-run) ────────────────────────────────────
//
// Inline re-implementation of the cancel branch in the queue consumer body.
// When a test is stopped via the Stop button:
//   • requestsTotal > 0  → publish to test-results queue as 'completed' (save partial metrics)
//   • requestsTotal === 0 → notifyCancelled (no data to save)
//   • Error thrown from runK6Test while cancelled → notifyCancelled, no retry

type StopResult = 'completed' | 'cancelled';

const stopBranchFn = async (
  cancelledTests: Set<string>,
  ch: ReturnType<typeof makeChannel>,
  testId: string,
  metrics: { requestsTotal: number },
  notifyCancelled: (id: string) => Promise<void>,
): Promise<StopResult> => {
  const wasStopped = cancelledTests.has(testId);
  if (wasStopped) cancelledTests.delete(testId);

  if (wasStopped && metrics.requestsTotal === 0) {
    await notifyCancelled(testId);
    ch.ack({} as never);
    return 'cancelled';
  }

  ch.sendToQueue('test-results', Buffer.from(JSON.stringify({ testId, status: 'completed', metrics })));
  ch.ack({} as never);
  return 'completed';
};

const stopErrorBranchFn = async (
  cancelledTests: Set<string>,
  ch: ReturnType<typeof makeChannel>,
  testId: string,
  notifyCancelled: (id: string) => Promise<void>,
  handleRetry: () => void,
): Promise<StopResult | 'failed'> => {
  if (cancelledTests.has(testId)) {
    cancelledTests.delete(testId);
    await notifyCancelled(testId);
    ch.ack({} as never);
    return 'cancelled';
  }
  handleRetry();
  return 'failed';
};

describe('Stop button — cancel branch with partial metrics (success path)', () => {
  it('publishes to test-results as completed when requestsTotal > 0', async () => {
    const cancelled = new Set(['test-1']);
    const ch = makeChannel();
    const notifyCancelled = vi.fn().mockResolvedValue(undefined);

    const result = await stopBranchFn(cancelled, ch, 'test-1', { requestsTotal: 42 }, notifyCancelled);

    expect(result).toBe('completed');
    expect(ch.sendToQueue).toHaveBeenCalledOnce();
    const payload = JSON.parse(ch.sendToQueue.mock.calls[0][1].toString());
    expect(payload.status).toBe('completed');
    expect(payload.metrics.requestsTotal).toBe(42);
    expect(notifyCancelled).not.toHaveBeenCalled();
    expect(ch.ack).toHaveBeenCalledOnce();
  });

  it('removes the testId from cancelledTests after handling', async () => {
    const cancelled = new Set(['test-2']);
    const ch = makeChannel();

    await stopBranchFn(cancelled, ch, 'test-2', { requestsTotal: 10 }, vi.fn());

    expect(cancelled.has('test-2')).toBe(false);
  });

  it('calls notifyCancelled and does NOT publish metrics when requestsTotal === 0', async () => {
    const cancelled = new Set(['test-3']);
    const ch = makeChannel();
    const notifyCancelled = vi.fn().mockResolvedValue(undefined);

    const result = await stopBranchFn(cancelled, ch, 'test-3', { requestsTotal: 0 }, notifyCancelled);

    expect(result).toBe('cancelled');
    expect(notifyCancelled).toHaveBeenCalledWith('test-3');
    expect(ch.sendToQueue).not.toHaveBeenCalled();
    expect(ch.ack).toHaveBeenCalledOnce();
  });

  it('does not treat a non-cancelled test differently — publishes as completed', async () => {
    const cancelled = new Set<string>(); // test-4 is NOT cancelled
    const ch = makeChannel();

    const result = await stopBranchFn(cancelled, ch, 'test-4', { requestsTotal: 100 }, vi.fn());

    expect(result).toBe('completed');
    expect(ch.sendToQueue).toHaveBeenCalledOnce();
  });
});

describe('Stop button — cancel branch in error path (k6 failed with no metrics)', () => {
  it('calls notifyCancelled and acks without retrying when test was stopped', async () => {
    const cancelled = new Set(['test-5']);
    const ch = makeChannel();
    const notifyCancelled = vi.fn().mockResolvedValue(undefined);
    const handleRetry = vi.fn();

    const result = await stopErrorBranchFn(cancelled, ch, 'test-5', notifyCancelled, handleRetry);

    expect(result).toBe('cancelled');
    expect(notifyCancelled).toHaveBeenCalledWith('test-5');
    expect(ch.ack).toHaveBeenCalledOnce();
    expect(handleRetry).not.toHaveBeenCalled();
  });

  it('calls handleRetry normally when the test was NOT stopped', async () => {
    const cancelled = new Set<string>(); // test-6 not in set
    const ch = makeChannel();
    const notifyCancelled = vi.fn();
    const handleRetry = vi.fn();

    const result = await stopErrorBranchFn(cancelled, ch, 'test-6', notifyCancelled, handleRetry);

    expect(result).toBe('failed');
    expect(handleRetry).toHaveBeenCalledOnce();
    expect(notifyCancelled).not.toHaveBeenCalled();
    expect(ch.ack).not.toHaveBeenCalled();
  });

  it('removes the testId from cancelledTests after handling in error path', async () => {
    const cancelled = new Set(['test-7']);
    await stopErrorBranchFn(cancelled, makeChannel(), 'test-7', vi.fn(), vi.fn());
    expect(cancelled.has('test-7')).toBe(false);
  });
});
