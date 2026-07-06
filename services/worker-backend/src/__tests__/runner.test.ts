/**
 * Unit tests for worker-backend runner.ts
 * Covers: validateScript, runK6Test (exit codes, data files, env vars, SIGTERM/SIGKILL, cleanup),
 *         handleRetry (DLQ routing and retry counter).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mockSpawn    = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());
const mockMkdir    = vi.hoisted(() => vi.fn());
const mockRm       = vi.hoisted(() => vi.fn());
const mockOpen     = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({ spawn: mockSpawn }));
vi.mock('fs/promises', () => ({
  writeFile: mockWriteFile,
  mkdir:     mockMkdir,
  rm:        mockRm,
  open:      mockOpen,
  readFile:  mockReadFile,
}));
vi.mock('../logger', () => ({
  log: {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
}));
vi.mock('@alt/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alt/shared')>();
  return { ...actual, stripAnsi: (s: string) => s };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** k6 text output with one valid http_reqs line so parseK6Output returns requestsTotal > 0. */
const K6_OUTPUT = [
  '     http_req_duration.............: avg=200ms min=50ms med=180ms max=400ms p(90)=350ms p(95)=380ms p(99)=400ms',
  '     http_reqs.....................: 100    10/s',
  '     http_req_failed...............: 0.00% ✓ 0   ✗ 100',
].join('\n');

/** Create a fake ChildProcess (EventEmitter) with controllable stdout/stderr.
 *  stdout/stderr are plain EventEmitters so tests can emit 'data' synchronously.
 *  The opts parameter is accepted but ignored — callers emit data manually instead.
 */
function makeProc(_opts: { stdout?: string; stderr?: string } = {}) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill   = vi.fn();
  return proc;
}

/** Build a no-op RunnerContext for tests that don't care about notifications. */
function makeCtx(runningTests = new Map<string, ChildProcess>()) {
  return {
    runningTests,
    notifyRunning:  vi.fn().mockResolvedValue(undefined),
    postLogLines:   vi.fn().mockResolvedValue(undefined),
    postLiveMetric: vi.fn().mockResolvedValue(undefined),
    maxDurationMs:  600_000,
    gracePeriodMs:  30_000,
    liveIntervalMs: 5_000,
  };
}

/** Setup all fs/promises mocks so runK6Test doesn't throw on file ops.
 *  Also clears call history so accumulated calls from previous tests don't bleed through.
 */
function setupFs() {
  mockSpawn.mockClear();
  mockMkdir.mockClear();
  mockWriteFile.mockClear();
  mockRm.mockClear();
  mockReadFile.mockClear();
  mockOpen.mockClear();
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  mockRm.mockResolvedValue(undefined);
  mockReadFile.mockResolvedValue('');
  mockOpen.mockResolvedValue({
    stat: vi.fn().mockResolvedValue({ size: 0 }),
    read: vi.fn().mockResolvedValue({ bytesRead: 0 }),
    close: vi.fn().mockResolvedValue(undefined),
  });
}

// ─── validateScript ───────────────────────────────────────────────────────────

describe('validateScript', () => {
  beforeEach(() => { vi.resetModules(); });

  it('resolves when k6 inspect exits with code 0', async () => {
    const { validateScript } = await import('../runner');
    const proc = makeProc();
    mockSpawn.mockReturnValueOnce(proc);

    const p = validateScript('/tmp/script.js');
    proc.emit('close', 0);
    await expect(p).resolves.toBeUndefined();
  });

  it('rejects with a descriptive error when k6 inspect exits non-zero', async () => {
    const { validateScript } = await import('../runner');
    const proc = makeProc({ stderr: 'GoError: invalid JS' });
    mockSpawn.mockReturnValueOnce(proc);

    const p = validateScript('/tmp/bad.js');
    proc.stdout.emit('data', Buffer.from(''));
    proc.stderr.emit('data', Buffer.from('GoError: invalid JS'));
    proc.emit('close', 1);
    await expect(p).rejects.toThrow(/k6 script validation failed.*exit 1/);
  });

  it('rejects when the spawn itself errors (k6 not found)', async () => {
    const { validateScript } = await import('../runner');
    const proc = makeProc();
    mockSpawn.mockReturnValueOnce(proc);

    const p = validateScript('/tmp/script.js');
    proc.emit('error', new Error('ENOENT: k6 not found'));
    await expect(p).rejects.toThrow('ENOENT');
  });
});

// ─── runK6Test — exit code handling ───────────────────────────────────────────

describe('runK6Test — exit code handling', () => {
  beforeEach(() => {
    vi.resetModules();
    setupFs();
  });

  it('resolves with metrics on exit code 0 (success)', async () => {
    const { runK6Test } = await import('../runner');
    const validate = makeProc();
    const run      = makeProc({ stdout: K6_OUTPUT });
    mockSpawn.mockReturnValueOnce(validate).mockReturnValueOnce(run);

    const promise = runK6Test('test-0', 'export default function(){}', undefined, undefined, undefined, makeCtx());
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    validate.emit('close', 0);
    await Promise.resolve();
    await Promise.resolve();
    run.stdout.emit('data', Buffer.from(K6_OUTPUT));
    run.emit('close', 0);

    const result = await promise;
    expect(result.metrics.requestsTotal).toBeGreaterThan(0);
  });

  it('resolves on exit code 99 (threshold violation — test ran)', async () => {
    const { runK6Test } = await import('../runner');
    const validate = makeProc();
    const run      = makeProc({ stdout: K6_OUTPUT });
    mockSpawn.mockReturnValueOnce(validate).mockReturnValueOnce(run);

    const promise = runK6Test('test-99', 'export default function(){}', undefined, undefined, undefined, makeCtx());
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    validate.emit('close', 0);
    await Promise.resolve();
    await Promise.resolve();
    run.stdout.emit('data', Buffer.from(K6_OUTPUT));
    run.emit('close', 99);

    const result = await promise;
    expect(result.metrics.requestsTotal).toBeGreaterThan(0);
  });

  it('rejects on non-zero/non-99 exit when requestsTotal === 0', async () => {
    const { runK6Test } = await import('../runner');
    const validate = makeProc();
    const run      = makeProc({ stderr: 'fatal error' }); // no stdout → requestsTotal = 0
    mockSpawn.mockReturnValueOnce(validate).mockReturnValueOnce(run);

    const promise = runK6Test('test-fail', 'bad script', undefined, undefined, undefined, makeCtx());
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    validate.emit('close', 0);
    await Promise.resolve();
    await Promise.resolve();
    run.emit('close', 1);

    await expect(promise).rejects.toThrow(/k6 exited with code 1/);
  });

  it('resolves with partial metrics on non-zero exit when requestsTotal > 0', async () => {
    const { runK6Test } = await import('../runner');
    const validate = makeProc();
    const run      = makeProc({ stdout: K6_OUTPUT, stderr: 'warning' });
    mockSpawn.mockReturnValueOnce(validate).mockReturnValueOnce(run);

    const promise = runK6Test('test-partial', 'export default function(){}', undefined, undefined, undefined, makeCtx());
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    validate.emit('close', 0);
    await Promise.resolve();
    await Promise.resolve();
    run.stdout.emit('data', Buffer.from(K6_OUTPUT));
    run.emit('close', 127);

    const result = await promise;
    expect(result.metrics.requestsTotal).toBeGreaterThan(0);
  });

  it('attaches executionLog to the resolved result', async () => {
    const { runK6Test } = await import('../runner');
    const validate = makeProc();
    const run      = makeProc({ stdout: K6_OUTPUT + '\nINFO some message' });
    mockSpawn.mockReturnValueOnce(validate).mockReturnValueOnce(run);

    const promise = runK6Test('test-log', 'export default function(){}', undefined, undefined, undefined, makeCtx());
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    validate.emit('close', 0);
    await Promise.resolve();
    await Promise.resolve();
    run.emit('close', 0);

    const result = await promise;
    expect(typeof result.executionLog).toBe('string');
  });

  it('batches stdout lines into a single postLogLines call instead of one call per line', async () => {
    const { runK6Test } = await import('../runner');
    const validate = makeProc();
    const run      = makeProc();
    mockSpawn.mockReturnValueOnce(validate).mockReturnValueOnce(run);
    const ctx = makeCtx();

    const promise = runK6Test('test-batch', 'export default function(){}', undefined, undefined, undefined, ctx);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    validate.emit('close', 0);
    await Promise.resolve();
    await Promise.resolve();

    run.stdout.emit('data', Buffer.from('first line\nsecond line\nthird line\n'));
    run.emit('close', 0);
    await promise;

    // 3 lines pushed, none reaching the default 50-line batch threshold — the
    // pending batch must be flushed as one call when the k6 process closes,
    // not left stranded, and not sent as 3 separate HTTP calls.
    expect(ctx.postLogLines).toHaveBeenCalledTimes(1);
    expect(ctx.postLogLines).toHaveBeenCalledWith('test-batch', [
      { level: 'INFO', line: 'first line' },
      { level: 'INFO', line: 'second line' },
      { level: 'INFO', line: 'third line' },
    ]);
  });
});

// ─── runK6Test — validateScript failure → rm cleanup ─────────────────────────

describe('runK6Test — validateScript failure cleans up runDir', () => {
  beforeEach(() => {
    vi.resetModules();
    setupFs();
  });

  it('removes the runDir when k6 inspect fails', async () => {
    const { runK6Test } = await import('../runner');
    const validate = makeProc({ stderr: 'SyntaxError in script' });
    mockSpawn.mockReturnValueOnce(validate);

    const promise = runK6Test('test-val-fail', 'bad script', undefined, undefined, undefined, makeCtx());
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    validate.stderr.emit('data', Buffer.from('SyntaxError'));
    validate.emit('close', 1);

    await expect(promise).rejects.toThrow(/validation failed/);
    expect(mockRm).toHaveBeenCalledWith(
      expect.stringContaining('k6-run-test-val-fail'),
      { recursive: true, force: true },
    );
  });
});

// ─── runK6Test — data file writing ───────────────────────────────────────────

describe('runK6Test — data file writing', () => {
  beforeEach(() => {
    vi.resetModules();
    setupFs();
  });

  async function runToCompletion(testId: string, extra?: { testData?: unknown[]; csvData?: string }) {
    const { runK6Test } = await import('../runner');
    const validate = makeProc();
    const run      = makeProc({ stdout: K6_OUTPUT });
    mockSpawn.mockReturnValueOnce(validate).mockReturnValueOnce(run);

    const promise = runK6Test(
      testId,
      'export default function(){}',
      undefined,
      extra?.testData as Array<Record<string, string>> | undefined,
      extra?.csvData,
      makeCtx(),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    validate.emit('close', 0);
    await Promise.resolve();
    await Promise.resolve();
    run.stdout.emit('data', Buffer.from(K6_OUTPUT));
    run.emit('close', 0);
    await promise;
  }

  it('writes data.json when testData is non-empty', async () => {
    const testData = [{ userId: '1', token: 'abc' }];
    await runToCompletion('test-data-json', { testData });

    const dataWrite = mockWriteFile.mock.calls.find((c: unknown[]) => String(c[0]).endsWith('data.json'));
    expect(dataWrite).toBeDefined();
    expect(dataWrite![1]).toBe(JSON.stringify(testData));
  });

  it('does NOT write data.json when testData is empty array', async () => {
    await runToCompletion('test-no-data', { testData: [] });
    const dataWrite = mockWriteFile.mock.calls.find((c: unknown[]) => String(c[0]).endsWith('data.json'));
    expect(dataWrite).toBeUndefined();
  });

  it('does NOT write data.json when testData is undefined', async () => {
    await runToCompletion('test-no-data2');
    const dataWrite = mockWriteFile.mock.calls.find((c: unknown[]) => String(c[0]).endsWith('data.json'));
    expect(dataWrite).toBeUndefined();
  });

  it('writes data.csv when csvData (base64) is provided', async () => {
    const csvContent = 'name,value\nfoo,bar';
    const csvData    = Buffer.from(csvContent).toString('base64');
    await runToCompletion('test-csv', { csvData });

    const csvWrite = mockWriteFile.mock.calls.find((c: unknown[]) => String(c[0]).endsWith('data.csv'));
    expect(csvWrite).toBeDefined();
    expect(Buffer.isBuffer(csvWrite![1])).toBe(true);
    expect(csvWrite![1].toString()).toBe(csvContent);
  });
});

// ─── runK6Test — envVar injection safety ─────────────────────────────────────

describe('runK6Test — envVar injection safety', () => {
  beforeEach(() => {
    vi.resetModules();
    setupFs();
  });

  async function getRunArgs(testId: string, envVars: Record<string, string>): Promise<string[]> {
    const { runK6Test } = await import('../runner');
    const validate = makeProc();
    const run      = makeProc({ stdout: K6_OUTPUT });
    mockSpawn.mockReturnValueOnce(validate).mockReturnValueOnce(run);

    const promise = runK6Test(testId, 'export default function(){}', envVars, undefined, undefined, makeCtx());
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    validate.emit('close', 0);
    await Promise.resolve();
    await Promise.resolve();
    run.stdout.emit('data', Buffer.from(K6_OUTPUT));
    run.emit('close', 0);
    await promise;

    return mockSpawn.mock.calls[1][1] as string[]; // second spawn call = k6 run (calls cleared in setupFs beforeEach)
  }

  it('passes valid env vars as --env KEY=VALUE args', async () => {
    const args = await getRunArgs('test-env-valid', { API_KEY: 'secret', BASE_URL: 'https://x.com' });
    const envPairs = args.filter((_: string, i: number) => args[i - 1] === '--env');
    expect(envPairs).toContain('API_KEY=secret');
    expect(envPairs).toContain('BASE_URL=https://x.com');
  });

  it('strips keys that start with a digit', async () => {
    const args = await getRunArgs('test-env-digit', { '1INVALID': 'nope', VALID: 'ok' });
    const envPairs = args.filter((_: string, i: number) => args[i - 1] === '--env');
    expect(envPairs).toContain('VALID=ok');
    expect(envPairs.some((a: string) => a.startsWith('1INVALID'))).toBe(false);
  });

  it('strips keys that contain spaces', async () => {
    const args = await getRunArgs('test-env-space', { 'KEY WITH SPACE': 'nope', VALID: 'ok' });
    const envPairs = args.filter((_: string, i: number) => args[i - 1] === '--env');
    expect(envPairs.some((a: string) => a.startsWith('KEY WITH'))).toBe(false);
  });

  it('strips values that contain newlines', async () => {
    const args = await getRunArgs('test-env-newline', { SAFE: 'good', BAD: 'bad\nvalue' });
    const envPairs = args.filter((_: string, i: number) => args[i - 1] === '--env');
    expect(envPairs).toContain('SAFE=good');
    expect(envPairs.some((a: string) => a.includes('bad\n'))).toBe(false);
  });

  it('strips values that contain null bytes', async () => {
    const args = await getRunArgs('test-env-null', { SAFE: 'good', BAD: 'bad\0value' });
    const envPairs = args.filter((_: string, i: number) => args[i - 1] === '--env');
    expect(envPairs.some((a: string) => a.includes('\0'))).toBe(false);
  });

  it('skips if no envVars provided', async () => {
    const args = await getRunArgs('test-env-empty', {});
    expect(args).not.toContain('--env');
  });
});

// ─── runK6Test — SIGTERM / SIGKILL escalation ─────────────────────────────────

describe('runK6Test — SIGTERM/SIGKILL escalation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.resetModules();
    setupFs();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends SIGTERM to the k6 process when maxDurationMs elapses', async () => {
    const { runK6Test } = await import('../runner');
    const validate = makeProc();
    const run      = makeProc({ stdout: K6_OUTPUT });
    mockSpawn.mockReturnValueOnce(validate).mockReturnValueOnce(run);

    const ctx = makeCtx();
    ctx.maxDurationMs  = 10_000;
    ctx.gracePeriodMs  = 30_000;
    ctx.liveIntervalMs = 5_000;

    const promise = runK6Test('test-sigterm', 'export default function(){}', undefined, undefined, undefined, ctx);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    validate.emit('close', 0);
    await Promise.resolve();
    await Promise.resolve();

    vi.advanceTimersByTime(10_001);
    expect(run.kill).toHaveBeenCalledWith('SIGTERM');

    run.emit('close', 0);
    await promise;
  });

  it('sends SIGKILL after gracePeriodMs if the process has not exited after SIGTERM', async () => {
    const { runK6Test } = await import('../runner');
    const validate = makeProc();
    const run      = makeProc({ stdout: K6_OUTPUT });
    mockSpawn.mockReturnValueOnce(validate).mockReturnValueOnce(run);

    const runningTests = new Map<string, ChildProcess>();
    const ctx = makeCtx(runningTests);
    ctx.maxDurationMs  = 10_000;
    ctx.gracePeriodMs  = 30_000;
    ctx.liveIntervalMs = 5_000;

    const promise = runK6Test('test-sigkill', 'export default function(){}', undefined, undefined, undefined, ctx);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    validate.emit('close', 0);
    await Promise.resolve();
    await Promise.resolve();

    // runningTests still has the entry so SIGKILL is sent
    vi.advanceTimersByTime(10_001); // SIGTERM
    expect(run.kill).toHaveBeenCalledWith('SIGTERM');

    vi.advanceTimersByTime(30_001); // grace period → SIGKILL
    expect(run.kill).toHaveBeenCalledWith('SIGKILL');

    run.emit('close', 0);
    await promise;
  });
});

// ─── runK6Test — live metric polling loop (readAndPost) ──────────────────────

describe('runK6Test — live metric polling loop (readAndPost)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.resetModules();
    setupFs();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A JSON line k6's --out json would emit for one HTTP request duration point. */
  const LIVE_LINE = JSON.stringify({
    type: 'Point',
    metric: 'http_req_duration',
    data: { value: 123, time: new Date().toISOString(), tags: {} },
  }) + '\n';

  /** Makes mockOpen's file handle reflect `content`, writing the requested slice
   *  into the caller-provided buffer the way real fs.read() would (the default
   *  setupFs() mock leaves the buffer untouched, which would hide real bugs here). */
  function mockJsonFile(content: string): void {
    const buf = Buffer.from(content, 'utf-8');
    mockOpen.mockResolvedValue({
      stat: vi.fn().mockResolvedValue({ size: buf.length }),
      read: vi.fn().mockImplementation(async (dest: Buffer, offset: number, length: number, position: number) => {
        const slice = buf.subarray(position, position + length);
        slice.copy(dest, offset);
        return { bytesRead: slice.length };
      }),
      close: vi.fn().mockResolvedValue(undefined),
    });
  }

  it('posts an aggregated live metric point when the json output file has new data', async () => {
    const { runK6Test } = await import('../runner');
    const validate = makeProc();
    const run      = makeProc();
    mockSpawn.mockReturnValueOnce(validate).mockReturnValueOnce(run);
    mockJsonFile(LIVE_LINE);

    const ctx = makeCtx();
    ctx.liveIntervalMs = 5_000;

    const promise = runK6Test('test-live', 'export default function(){}', undefined, undefined, undefined, ctx);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    validate.emit('close', 0);
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(ctx.postLiveMetric).toHaveBeenCalledWith('test-live', expect.objectContaining({ avgResponseTime: 123 }));

    run.emit('close', 0);
    await promise;
  });

  it('derives the aggregation window from liveIntervalMs — rps reflects /30, not the default /2', async () => {
    const { runK6Test } = await import('../runner');
    const validate = makeProc();
    const run      = makeProc();
    mockSpawn.mockReturnValueOnce(validate).mockReturnValueOnce(run);
    // 30 http_reqs points in the window + one duration point (aggregateWindow
    // needs at least one duration/vus point to return non-null).
    const lines = [
      JSON.stringify({ type: 'Point', metric: 'http_req_duration', data: { value: 100, time: new Date().toISOString(), tags: {} } }),
      ...Array.from({ length: 30 }, () => JSON.stringify({ type: 'Point', metric: 'http_reqs', data: { value: 1, time: new Date().toISOString(), tags: {} } })),
    ].join('\n') + '\n';
    mockJsonFile(lines);

    const ctx = makeCtx();
    ctx.liveIntervalMs = 30_000; // admin-configured 30s window

    const promise = runK6Test('test-live-30s', 'export default function(){}', undefined, undefined, undefined, ctx);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    validate.emit('close', 0);
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(ctx.postLiveMetric).toHaveBeenCalledWith('test-live-30s', expect.objectContaining({ rps: 1 })); // 30 reqs / 30s

    run.emit('close', 0);
    await promise;
  });

  it('falls back to the default 2s window when ctx.liveIntervalMs is not set', async () => {
    const { runK6Test, LIVE_INTERVAL_MS } = await import('../runner');
    const validate = makeProc();
    const run      = makeProc();
    mockSpawn.mockReturnValueOnce(validate).mockReturnValueOnce(run);
    const lines = [
      JSON.stringify({ type: 'Point', metric: 'http_req_duration', data: { value: 100, time: new Date().toISOString(), tags: {} } }),
      ...Array.from({ length: 4 }, () => JSON.stringify({ type: 'Point', metric: 'http_reqs', data: { value: 1, time: new Date().toISOString(), tags: {} } })),
    ].join('\n') + '\n';
    mockJsonFile(lines);

    const ctx = makeCtx();
    ctx.liveIntervalMs = undefined as unknown as number; // simulate a caller that never sets it

    const promise = runK6Test('test-live-default', 'export default function(){}', undefined, undefined, undefined, ctx);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    validate.emit('close', 0);
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS);

    expect(ctx.postLiveMetric).toHaveBeenCalledWith('test-live-default', expect.objectContaining({ rps: 2 })); // 4 reqs / 2s default

    run.emit('close', 0);
    await promise;
  });

  it('does NOT post a live metric when the json file has no new bytes since the last read', async () => {
    const { runK6Test } = await import('../runner');
    const validate = makeProc();
    const run      = makeProc();
    mockSpawn.mockReturnValueOnce(validate).mockReturnValueOnce(run);
    mockJsonFile(''); // size 0 === starting fileOffset(0) → readAndPost returns early, nothing posted

    const ctx = makeCtx();
    ctx.liveIntervalMs = 5_000;

    const promise = runK6Test('test-live-empty', 'export default function(){}', undefined, undefined, undefined, ctx);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    validate.emit('close', 0);
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(ctx.postLiveMetric).not.toHaveBeenCalled();

    run.emit('close', 0);
    await promise;
  });

  it('does a final readAndPost flush on process close, posting trailing data the interval never reached', async () => {
    const { runK6Test } = await import('../runner');
    const validate = makeProc();
    const run      = makeProc();
    mockSpawn.mockReturnValueOnce(validate).mockReturnValueOnce(run);
    mockJsonFile(LIVE_LINE);

    const ctx = makeCtx();
    ctx.liveIntervalMs = 999_999; // long enough that the interval itself never fires before close

    const promise = runK6Test('test-live-flush', 'export default function(){}', undefined, undefined, undefined, ctx);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    validate.emit('close', 0);
    await Promise.resolve();
    await Promise.resolve();

    run.emit('close', 0);
    await promise;

    expect(ctx.postLiveMetric).toHaveBeenCalledWith('test-live-flush', expect.objectContaining({ avgResponseTime: 123 }));
  });

  it('clears the polling interval on close — no further postLiveMetric calls afterward', async () => {
    const { runK6Test } = await import('../runner');
    const validate = makeProc();
    const run      = makeProc();
    mockSpawn.mockReturnValueOnce(validate).mockReturnValueOnce(run);
    mockJsonFile(LIVE_LINE);

    const ctx = makeCtx();
    ctx.liveIntervalMs = 5_000;

    const promise = runK6Test('test-live-clear', 'export default function(){}', undefined, undefined, undefined, ctx);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    validate.emit('close', 0);
    await Promise.resolve();
    await Promise.resolve();

    run.emit('close', 0);
    await promise;

    const callsAfterClose = ctx.postLiveMetric.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ctx.postLiveMetric.mock.calls.length).toBe(callsAfterClose);
  });
});

// ─── runK6Test — runningTests / cancellation tracking ─────────────────────────

describe('runK6Test — runningTests map', () => {
  beforeEach(() => {
    vi.resetModules();
    setupFs();
  });

  it('adds the process to runningTests while running, removes it on close', async () => {
    const { runK6Test } = await import('../runner');
    const validate = makeProc();
    const run      = makeProc({ stdout: K6_OUTPUT });
    mockSpawn.mockReturnValueOnce(validate).mockReturnValueOnce(run);

    const runningTests = new Map<string, ChildProcess>();
    const ctx = makeCtx(runningTests);

    const promise = runK6Test('test-map', 'export default function(){}', undefined, undefined, undefined, ctx);
    // runK6Test awaits mkdir then writeFile before calling validateScript:
    // tick 1 → past mkdir; tick 2 → past writeFile Promise.all; now validateScript listener is registered
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    validate.emit('close', 0);
    // tick 3 → validateScript promise resolves; tick 4 → .catch chain propagates, k6 spawned, runningTests.set
    await Promise.resolve();
    await Promise.resolve();

    // While running, the process is tracked
    expect(runningTests.has('test-map')).toBe(true);

    run.emit('close', 0);
    await promise;

    // After completion, it's removed
    expect(runningTests.has('test-map')).toBe(false);
  });

  it('calls notifyRunning once after validation passes', async () => {
    const { runK6Test } = await import('../runner');
    const validate = makeProc();
    const run      = makeProc({ stdout: K6_OUTPUT });
    mockSpawn.mockReturnValueOnce(validate).mockReturnValueOnce(run);

    const ctx = makeCtx();
    const promise = runK6Test('test-notify', 'export default function(){}', undefined, undefined, undefined, ctx);
    // tick 1 → past mkdir; tick 2 → past writeFile Promise.all; now validateScript listener is registered
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    validate.emit('close', 0);
    // tick 3 → validateScript resolves; tick 4 → k6 spawned, notifyRunning called; run can now close
    await Promise.resolve();
    await Promise.resolve();
    run.emit('close', 0);
    await promise;

    expect(ctx.notifyRunning).toHaveBeenCalledOnce();
    expect(ctx.notifyRunning).toHaveBeenCalledWith('test-notify');
  });
});

// ─── handleRetry ─────────────────────────────────────────────────────────────

describe('handleRetry', () => {
  beforeEach(() => { vi.resetModules(); });

  it('retries with incremented x-retry-count when below MAX_RETRIES', async () => {
    const { handleRetry } = await import('../runner');
    const ch = { publish: vi.fn(), sendToQueue: vi.fn(), ack: vi.fn() };
    const msg = { content: Buffer.from('{}'), properties: { headers: { 'x-retry-count': 1 } } };

    handleRetry(ch as any, msg as any, 'backend-tests', 'backend-tests.dlq', 'tid-1');

    expect(ch.publish).toHaveBeenCalledWith(
      '',
      'backend-tests',
      msg.content,
      expect.objectContaining({ headers: expect.objectContaining({ 'x-retry-count': 2 }) }),
    );
    expect(ch.sendToQueue).not.toHaveBeenCalled();
    expect(ch.ack).toHaveBeenCalledWith(msg);
  });

  it('routes to DLQ after MAX_RETRIES exhausted', async () => {
    const { handleRetry, MAX_RETRIES } = await import('../runner');
    const ch = { publish: vi.fn(), sendToQueue: vi.fn(), ack: vi.fn() };
    const msg = { content: Buffer.from('{}'), properties: { headers: { 'x-retry-count': MAX_RETRIES } } };

    handleRetry(ch as any, msg as any, 'backend-tests', 'backend-tests.dlq', 'tid-2');

    expect(ch.sendToQueue).toHaveBeenCalledWith('backend-tests.dlq', msg.content, { persistent: true });
    expect(ch.publish).not.toHaveBeenCalled();
    expect(ch.ack).toHaveBeenCalledWith(msg);
  });

  it('treats missing x-retry-count header as 0 (first attempt)', async () => {
    const { handleRetry } = await import('../runner');
    const ch = { publish: vi.fn(), sendToQueue: vi.fn(), ack: vi.fn() };
    const msg = { content: Buffer.from('{}'), properties: { headers: {} } };

    handleRetry(ch as any, msg as any, 'backend-tests', 'backend-tests.dlq', 'tid-3');

    expect(ch.publish).toHaveBeenCalledWith(
      '',
      'backend-tests',
      msg.content,
      expect.objectContaining({ headers: expect.objectContaining({ 'x-retry-count': 1 }) }),
    );
  });

  it('respects a custom maxRetries argument', async () => {
    const { handleRetry } = await import('../runner');
    const ch = { publish: vi.fn(), sendToQueue: vi.fn(), ack: vi.fn() };
    const msg = { content: Buffer.from('{}'), properties: { headers: { 'x-retry-count': 1 } } };

    // maxRetries = 1 means retry count 1 is already at the limit → DLQ
    handleRetry(ch as any, msg as any, 'q', 'q.dlq', 'tid-4', 1);

    expect(ch.sendToQueue).toHaveBeenCalledWith('q.dlq', msg.content, { persistent: true });
  });
});

// ─── makeLineBuffer ───────────────────────────────────────────────────────────

describe('makeLineBuffer', () => {
  it('emits complete lines as they arrive', async () => {
    const { makeLineBuffer } = await import('../runner');
    const lines: string[] = [];
    const buf = makeLineBuffer(l => lines.push(l));

    buf(Buffer.from('hello\nworld\n'));
    expect(lines).toEqual(['hello', 'world']);
  });

  it('buffers incomplete lines across chunks', async () => {
    const { makeLineBuffer } = await import('../runner');
    const lines: string[] = [];
    const buf = makeLineBuffer(l => lines.push(l));

    buf(Buffer.from('hel'));
    expect(lines).toHaveLength(0);
    buf(Buffer.from('lo\n'));
    expect(lines).toEqual(['hello']);
  });

  it('ignores empty lines', async () => {
    const { makeLineBuffer } = await import('../runner');
    const lines: string[] = [];
    const buf = makeLineBuffer(l => lines.push(l));

    buf(Buffer.from('a\n\n\nb\n'));
    expect(lines).toEqual(['a', 'b']);
  });
});

// ─── makeTailBuffer ─────────────────────────────────────────────────────────

describe('makeTailBuffer', () => {
  it('returns everything pushed when under the cap', async () => {
    const { makeTailBuffer } = await import('../runner');
    const buf = makeTailBuffer(1024);

    buf.push(Buffer.from('hello '));
    buf.push(Buffer.from('world'));

    expect(buf.toString()).toBe('hello world');
  });

  it('keeps only the trailing maxBytes once the cap is exceeded', async () => {
    const { makeTailBuffer } = await import('../runner');
    const buf = makeTailBuffer(10);

    buf.push(Buffer.from('0123456789')); // exactly 10 bytes
    buf.push(Buffer.from('ABCDE'));      // now 15 bytes total -> keep last 10

    expect(buf.toString()).toBe('56789ABCDE');
    expect(Buffer.byteLength(buf.toString())).toBe(10);
  });

  it('never exceeds maxBytes across many small pushes', async () => {
    const { makeTailBuffer } = await import('../runner');
    const buf = makeTailBuffer(100);

    for (let i = 0; i < 1000; i++) {
      buf.push(Buffer.from(`line-${i}\n`));
    }

    expect(Buffer.byteLength(buf.toString())).toBeLessThanOrEqual(100);
    // The most recent content survives; the very first push is long gone.
    expect(buf.toString()).toContain('line-999');
    expect(buf.toString()).not.toContain('line-0\n');
  });

  it('returns an empty string when nothing has been pushed', async () => {
    const { makeTailBuffer } = await import('../runner');
    const buf = makeTailBuffer(1024);
    expect(buf.toString()).toBe('');
  });
});

// ─── k6Level ─────────────────────────────────────────────────────────────────

describe('k6Level', () => {
  it.each([
    ['ERRO some error', 'ERROR'],
    ['WARN some warning', 'WARN'],
    ['DEBU debug output', 'DEBUG'],
    ['INFO info line', 'INFO'],
    ['     default line', 'INFO'],
  ])('maps %s to level %s', async (line, expected) => {
    const { k6Level } = await import('../runner');
    expect(k6Level(line)).toBe(expected);
  });
});

// ─── Regression #2: write failure leaks runDir ────────────────────────────────
//
// Finding (Low): "Per-test run directory leaks on write failure"
// runK6Test mkdir's the run dir, then an unguarded Promise.all writes
// script.js / data.json / data.csv. Only the validateScript failure path
// calls rm() to clean up. A writeFile rejection (disk full, EACCES, etc.)
// throws straight out of the Promise.all and exits the function without ever
// calling rm(), leaving the run directory behind.
//
// Desired: rm(runDir, { recursive: true, force: true }) is called whenever
// runK6Test rejects, regardless of which failure path caused the rejection.
// Current: rm is only called on the validateScript failure path.

describe('runK6Test — write failure should clean up runDir (regression finding #2)', () => {
  beforeEach(() => {
    vi.resetModules();
    setupFs();
  });

  it.fails('write failure should remove the runDir even when writeFile rejects (currently leaks)', async () => {
    const { runK6Test } = await import('../runner');

    // Make the first writeFile call (script.js) reject, simulating disk-full or EACCES.
    // setupFs() sets the default to resolve; mockRejectedValueOnce overrides the first call only.
    mockWriteFile.mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));

    // validateScript (spawn) is never reached because writeFile fails first —
    // include a stub anyway so mockSpawn state stays consistent.
    const validate = makeProc();
    mockSpawn.mockReturnValueOnce(validate);

    // runK6Test must reject (the Promise.all throws)
    await expect(
      runK6Test('test-write-fail', 'export default function(){}', undefined, undefined, undefined, makeCtx())
    ).rejects.toThrow();

    // Desired: the runDir is cleaned up even when writeFile is the failure cause.
    // Current: rm() is only called from the validateScript.catch handler, not here.
    expect(mockRm).toHaveBeenCalledWith(
      expect.stringContaining('k6-run-test-write-fail'),
      { recursive: true, force: true },
    );
  });
});

// ─── Regression #3: mid-line poll silently drops the data point ───────────────
//
// Finding (Low): "A live-metrics poll landing mid-line silently drops that data point"
// readAndPost() advances fileOffset to the current file size before checking
// whether the last line read is complete. If the polling interval fires while
// k6 is still writing a JSON line (no trailing '\n' yet), that partial line is
// silently dropped by aggregateWindow's per-line try/catch.  On the next tick
// fileOffset is already past the partial content, so the continuation bytes
// are read in isolation and are also unparseable — the data point is lost.
//
// makeLineBuffer (used for stdout/stderr) correctly retains the incomplete
// trailing fragment in an internal buffer and prepends it to the next chunk.
// readAndPost does not apply equivalent buffering.
//
// Desired: a data point split across two poll ticks is retained and eventually
// posted (as makeLineBuffer does for stdout/stderr).
// Current: both halves are silently discarded.

describe('readAndPost — mid-line split silently drops data point (regression finding #3)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.resetModules();
    setupFs();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.fails('a data point split across two poll ticks should not be lost (currently dropped)', async () => {
    const { runK6Test } = await import('../runner');
    const validate = makeProc();
    const run      = makeProc();
    mockSpawn.mockReturnValueOnce(validate).mockReturnValueOnce(run);

    // A complete, valid JSON line that k6 would emit for one http_req_duration point.
    const fullLine = JSON.stringify({
      type:   'Point',
      metric: 'http_req_duration',
      data:   { value: 456, time: new Date().toISOString(), tags: {} },
    });
    // Split the line in half with NO trailing newline on the first chunk,
    // simulating a poll that fires while k6 is still writing this line.
    const splitAt = Math.floor(fullLine.length / 2);
    const chunk1  = fullLine.slice(0, splitAt);           // partial JSON, no '\n'
    const chunk2  = fullLine.slice(splitAt) + '\n';        // remainder + newline

    const buf1 = Buffer.from(chunk1, 'utf-8');
    const buf2 = Buffer.from(chunk2, 'utf-8');

    // Tick 1: file contains only chunk1 (truncated mid-line, no '\n')
    mockOpen.mockResolvedValueOnce({
      stat:  vi.fn().mockResolvedValue({ size: buf1.length }),
      read:  vi.fn().mockImplementation(async (dest: Buffer, _off: number, len: number, pos: number) => {
        const data = buf1.subarray(pos, pos + len);
        data.copy(dest, _off);
        return { bytesRead: data.length };
      }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    // Tick 2: file now has chunk1 + chunk2 (the complete, newline-terminated line)
    mockOpen.mockResolvedValueOnce({
      stat:  vi.fn().mockResolvedValue({ size: buf1.length + buf2.length }),
      read:  vi.fn().mockImplementation(async (dest: Buffer, _off: number, len: number, pos: number) => {
        const full = Buffer.concat([buf1, buf2]);
        const data = full.subarray(pos, pos + len);
        data.copy(dest, _off);
        return { bytesRead: data.length };
      }),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const ctx = makeCtx();
    ctx.liveIntervalMs = 5_000;

    const promise = runK6Test('test-midline', 'export default function(){}', undefined, undefined, undefined, ctx);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    validate.emit('close', 0);
    await Promise.resolve();
    await Promise.resolve();

    // Tick 1: reads chunk1 (no '\n'). split('\n').filter(trim) → [chunk1].
    // aggregateWindow tries JSON.parse(chunk1) → throws (not valid JSON) → swallowed.
    // fileOffset advances to buf1.length — the partial content is irreversibly forgotten.
    await vi.advanceTimersByTimeAsync(5_000);

    // Tick 2: reads from fileOffset=buf1.length → reads only chunk2.
    // chunk2 = fullLine.slice(splitAt) + '\n' — the second half of the JSON without the head.
    // aggregateWindow tries JSON.parse(chunk2 without '\n') → throws → swallowed.
    // The data point is permanently lost.
    await vi.advanceTimersByTimeAsync(5_000);

    // Desired: postLiveMetric should have been called with the complete data point
    // (value 456 → avgResponseTime: 456) once both halves were available.
    // Current: the partial line and its remainder are both silently discarded;
    // postLiveMetric is never called with this data point.
    expect(ctx.postLiveMetric).toHaveBeenCalledWith(
      'test-midline',
      expect.objectContaining({ avgResponseTime: 456 }),
    );

    run.emit('close', 0);
    await promise;
  });
});
