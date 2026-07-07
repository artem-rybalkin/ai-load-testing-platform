/**
 * Core k6 test execution logic — extracted from index.ts so it can be unit-tested.
 */
import { spawn, ChildProcess } from 'child_process';
import { writeFile, readFile, mkdir, rm, open } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import amqplib from 'amqplib';

import { BackendMetrics, LiveMetricPoint, stripAnsi, createBatcher } from '@alt/shared';
import { parseK6Output, aggregateWindow, parseK6JsonOutput, LIVE_WINDOW_SEC } from './parser';
import { log } from './logger';

export const GRACE_PERIOD_MS = 30_000;
export const LIVE_INTERVAL_MS = LIVE_WINDOW_SEC * 1_000;

export const MAX_RETRIES = 3;

/** Regex for valid envVar key names (mirrors index.ts SAFE_KEY). */
export const SAFE_KEY = /^[A-Z_][A-Z0-9_]*$/i;

// ── Helpers ───────────────────────────────────────────────────────────────────

export const k6Level = (line: string): string => {
  if (line.startsWith('ERRO')) return 'ERROR';
  if (line.startsWith('WARN')) return 'WARN';
  if (line.startsWith('DEBU')) return 'DEBUG';
  return 'INFO';
};

export const makeLineBuffer = (onLine: (line: string) => void): ((chunk: Buffer) => void) => {
  let buf = '';
  return (chunk: Buffer) => {
    buf += chunk.toString('utf-8');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const l of lines) { if (l.trim()) onLine(l); }
  };
};

/**
 * Keeps only the trailing `maxBytes` of everything ever pushed. k6's
 * end-of-test summary (the block runK6Test's regex parsing actually needs —
 * a fixed few KB, emitted once at process exit) is always the LAST thing
 * written to stdout/stderr, so a small bounded tail is enough; accumulating
 * every chunk for a long/verbose test's full duration cost unbounded memory
 * and made the final regex parse scan megabytes of irrelevant per-request
 * output instead of the actual summary.
 */
export const makeTailBuffer = (maxBytes: number): { push: (chunk: Buffer) => void; toString: () => string } => {
  let buf = Buffer.alloc(0);
  return {
    push: (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > maxBytes) buf = buf.subarray(buf.length - maxBytes);
    },
    toString: (): string => buf.toString('utf-8'),
  };
};

// ── validateScript ────────────────────────────────────────────────────────────

export const validateScript = (scriptPath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const k6 = spawn('k6', ['inspect', scriptPath]);
    const stderr = makeTailBuffer(8 * 1_024);
    k6.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    k6.on('close', (code) => {
      if (code === 0) { resolve(); return; }
      const detail = stderr.toString().trim().slice(0, 2000);
      reject(new Error(`k6 script validation failed (exit ${code})${detail ? `: ${detail}` : ''}`));
    });
    k6.on('error', reject);
  });

// ── RunnerContext ─────────────────────────────────────────────────────────────

export interface RunnerContext {
  runningTests: Map<string, ChildProcess>;
  notifyRunning:   (testId: string) => Promise<void>;
  postLogLines:    (testId: string, lines: Array<{ level: string; line: string }>) => Promise<void>;
  postLiveMetric:  (testId: string, point: LiveMetricPoint) => Promise<void>;
  maxDurationMs:   number;
  gracePeriodMs:   number;
  liveIntervalMs:  number;
}

// ── runK6Test ─────────────────────────────────────────────────────────────────

const MAX_LOG_LINES = 5_000;
const MAX_LOG_BYTES = 100 * 1_024; // 100 KB

export const runK6Test = async (
  testId: string,
  script: string,
  envVars?: Record<string, string>,
  testData?: Array<Record<string, string>>,
  csvData?: string,
  ctx?: RunnerContext,
): Promise<{ metrics: BackendMetrics; executionLog: string }> => {
  const runDir    = path.join(os.tmpdir(), `k6-run-${testId}`);
  await mkdir(runDir, { recursive: true });
  const scriptPath = path.join(runDir, 'script.js');
  const jsonPath   = path.join(runDir, 'live.json');

  try {
    await Promise.all([
      writeFile(scriptPath, script),
      testData && testData.length > 0
        ? writeFile(path.join(runDir, 'data.json'), JSON.stringify(testData))
        : Promise.resolve(),
      csvData
        ? writeFile(path.join(runDir, 'data.csv'), Buffer.from(csvData, 'base64'))
        : Promise.resolve(),
    ]);

    await validateScript(scriptPath);
  } catch (err) {
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  return new Promise((resolve, reject) => {
    const envArgs = Object.entries(envVars ?? {})
      .filter(([k, v]) =>
        SAFE_KEY.test(k) &&
        !v.includes('\n') &&
        !v.includes('\0') &&
        k.length <= 64 &&
        v.length <= 1_024,
      )
      .flatMap(([k, v]) => ['--env', `${k}=${v}`]);

    const k6 = spawn('k6', [
      'run',
      '--out', `json=${jsonPath}`,
      '--summary-trend-stats', 'avg,min,med,max,p(90),p(95),p(99)',
      ...envArgs,
      scriptPath,
    ]);

    ctx?.runningTests.set(testId, k6);
    ctx?.notifyRunning(testId).catch(() => {});

    // Only the end-of-test summary (a fixed few KB, the last thing k6 writes)
    // is ever read back out of these — a 64KB tail comfortably covers it
    // without retaining a long/verbose test's full stdout+stderr in memory.
    const stdoutTail = makeTailBuffer(64 * 1_024);
    const stderrTail = makeTailBuffer(64 * 1_024);
    let fileOffset = 0;
    let partialLine = '';

    const logLines: string[] = [];
    let logBytes = 0;
    const logBatcher = createBatcher<{ level: string; line: string }>(
      batch => { ctx?.postLogLines(testId, batch).catch(() => {}); },
    );
    const addLogLine = (level: string, raw: string): void => {
      const text = stripAnsi(raw).trimEnd();
      if (!text || logLines.length >= MAX_LOG_LINES || logBytes >= MAX_LOG_BYTES) return;
      logLines.push(`[${level}] ${text}`);
      logBytes += level.length + Buffer.byteLength(text, 'utf8') + 3;
      logBatcher.push({ level, line: text });
    };

    const stdoutLineBuf = makeLineBuffer(line => addLogLine(k6Level(line), line));
    const stderrLineBuf = makeLineBuffer(line => addLogLine(k6Level(line), line));

    k6.stdout.on('data', (d: Buffer) => { stdoutTail.push(d); stdoutLineBuf(d); });
    k6.stderr.on('data', (d: Buffer) => { stderrTail.push(d); stderrLineBuf(d); });

    const liveIntervalMs = ctx?.liveIntervalMs ?? LIVE_INTERVAL_MS;
    const liveWindowSec = liveIntervalMs / 1_000;

    const readAndPost = async (): Promise<void> => {
      try {
        const fh = await open(jsonPath, 'r');
        try {
          const { size } = await fh.stat();
          if (size <= fileOffset) return;
          const buf = Buffer.allocUnsafe(size - fileOffset);
          await fh.read(buf, 0, buf.length, fileOffset);
          fileOffset = size;
          const text = partialLine + buf.toString('utf-8');
          const parts = text.split('\n');
          partialLine = parts.pop() ?? '';
          const newLines = parts.filter(l => l.trim());
          const agg = aggregateWindow(newLines, liveWindowSec);
          if (agg) await ctx?.postLiveMetric(testId, { timestamp: new Date().toISOString(), ...agg });
        } finally {
          await fh.close();
        }
      } catch { /* file may not exist yet */ }
    };

    const liveInterval = setInterval(readAndPost, liveIntervalMs);

    const maxDurationMs  = ctx?.maxDurationMs  ?? parseInt(process.env.K6_MAX_DURATION_MS ?? '600000');
    const gracePeriodMs  = ctx?.gracePeriodMs  ?? GRACE_PERIOD_MS;

    const killTimer = setTimeout(() => {
      log.warn({ testId, maxMs: maxDurationMs }, 'k6 test exceeded max duration, sending SIGTERM');
      k6.kill('SIGTERM');
      setTimeout(() => { if (ctx?.runningTests.has(testId)) k6.kill('SIGKILL'); }, gracePeriodMs);
    }, maxDurationMs);

    k6.on('close', async (code) => {
      clearInterval(liveInterval);
      clearTimeout(killTimer);
      ctx?.runningTests.delete(testId);
      logBatcher.flush();
      await readAndPost();

      const jsonContent = await readFile(jsonPath, 'utf-8').catch(() => '');
      await rm(runDir, { recursive: true, force: true }).catch(() => {});

      if (code !== 0 && code !== 99) {
        log.warn({ testId, code }, 'k6 exited with non-zero code — parsing partial output');
      }

      const output = stdoutTail.toString() + stderrTail.toString();
      const metrics = parseK6Output(output);
      const { statusCodes, errorBreakdown, stepMetrics } = parseK6JsonOutput(jsonContent);
      metrics.statusCodes    = statusCodes;
      metrics.errorBreakdown = errorBreakdown;
      if (stepMetrics.length > 0) metrics.stepMetrics = stepMetrics;

      if (code !== 0 && code !== 99 && metrics.requestsTotal === 0) {
        const e = Object.assign(
          new Error(`k6 exited with code ${code}: ${stderrTail.toString().slice(-500)}`),
          { partialLog: logLines.join('\n') },
        );
        reject(e);
        return;
      }

      resolve({ metrics, executionLog: logLines.join('\n') });
    });

    k6.on('error', async (err) => {
      clearInterval(liveInterval);
      clearTimeout(killTimer);
      ctx?.runningTests.delete(testId);
      logBatcher.flush();
      await rm(runDir, { recursive: true, force: true }).catch(() => {});
      (err as Error & { partialLog?: string }).partialLog = logLines.join('\n');
      reject(err);
    });
  });
};

// ── handleRetry ───────────────────────────────────────────────────────────────

export const handleRetry = (
  channel: amqplib.Channel,
  msg: amqplib.Message,
  queue: string,
  dlq: string,
  testId: string,
  maxRetries = MAX_RETRIES,
): void => {
  const retryCount = Number(msg.properties.headers?.['x-retry-count'] ?? 0);
  if (retryCount < maxRetries) {
    log.warn({ testId, retryCount: retryCount + 1, maxRetries }, 'Retrying message');
    channel.publish('', queue, msg.content, {
      persistent: true,
      headers: { ...msg.properties.headers, 'x-retry-count': retryCount + 1 },
    });
  } else {
    log.error({ testId, retryCount }, 'Max retries exceeded, routing to DLQ');
    channel.sendToQueue(dlq, msg.content, { persistent: true });
  }
  channel.ack(msg);
};
