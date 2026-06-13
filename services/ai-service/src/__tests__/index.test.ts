/**
 * Unit tests for ai-service consumer routing logic (src/index.ts).
 *
 * The routing logic inside the amqplib consume callback is tested by
 * re-implementing the decision tree as a pure function, mirroring the
 * exact branching in src/index.ts:
 *
 *   1. cachedScript + description + cachedScriptDescription !== null
 *      → compareDescriptions() → REUSE or REGENERATE
 *   2. cachedScript + description + cachedScriptDescription === null
 *      → clear scriptId, fall through to generateScript
 *   3. No cachedScript
 *      → generateScript()
 *   4. generateScript throws after MAX_RETRIES
 *      → postMessage failure + sendToQueue DLQ + call fail endpoint
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EnrichedTestRequest } from '@alt/shared';

// ── Mock generator module ─────────────────────────────────────────────────
const mockCompareDescriptions = vi.fn();
const mockGenerateScript       = vi.fn();

vi.mock('../generator', () => ({
  compareDescriptions: mockCompareDescriptions,
  generateScript:      mockGenerateScript,
}));

// ── Channel mock ──────────────────────────────────────────────────────────
const makeChannel = () => ({
  sendToQueue: vi.fn(),
  ack:         vi.fn(),
  publish:     vi.fn(),
});

// ── postMessage mock ──────────────────────────────────────────────────────
const postMessage = vi.fn().mockResolvedValue(undefined);

// ── Routing logic (mirrors src/index.ts consumer callback) ───────────────

const BACKEND_QUEUE = 'backend-tests';
const CLIENT_QUEUE  = 'client-tests';
const DLQ           = 'ai-requests.dlq';
const MAX_RETRIES   = 3;

type Channel = ReturnType<typeof makeChannel>;

const processMessage = async (
  channel: Channel,
  test: EnrichedTestRequest,
  retryCount = 0,
): Promise<void> => {
  const targetQueue =
    test.type === 'backend' || test.type === 'flow' ? BACKEND_QUEUE : CLIENT_QUEUE;

  try {
    let mutableTest = { ...test };

    if (mutableTest.cachedScript && mutableTest.description) {
      if (mutableTest.cachedScriptDescription == null) {
        mutableTest = { ...mutableTest, scriptId: undefined };
      } else {
        const same =
          mutableTest.description.trim().toLowerCase() ===
          mutableTest.cachedScriptDescription.trim().toLowerCase();
        const verdict = same
          ? 'REUSE'
          : await mockCompareDescriptions(
              mutableTest.description,
              mutableTest.cachedScriptDescription,
            );

        if (verdict === 'REUSE') {
          const reused: EnrichedTestRequest = {
            ...mutableTest,
            generatedScript: mutableTest.cachedScript,
            reusedScript: true,
          };
          channel.sendToQueue(targetQueue, Buffer.from(JSON.stringify(reused)), {
            persistent: true,
          });
          channel.ack({} as never);
          return;
        }
        mutableTest = { ...mutableTest, scriptId: undefined };
      }
    }

    await postMessage('Generating test script with AI…');
    const script = await mockGenerateScript(mutableTest);
    await postMessage('Script ready — starting test…');

    channel.sendToQueue(
      targetQueue,
      Buffer.from(JSON.stringify({ ...mutableTest, generatedScript: script })),
      { persistent: true },
    );
    channel.ack({} as never);
  } catch {
    if (retryCount < MAX_RETRIES) {
      await postMessage(`Gemini unavailable — retrying… (${MAX_RETRIES - retryCount} attempts left)`);
      channel.publish('', 'ai-requests', Buffer.from('{}'), {
        persistent: true,
        headers: { 'x-retry-count': retryCount + 1 },
      });
    } else {
      await postMessage('Script generation failed after 3 attempts — test could not start');
      channel.sendToQueue(DLQ, Buffer.from('{}'), { persistent: true });
      // marks test as failed in results-service (fire-and-forget)
    }
    channel.ack({} as never);
  }
};

// ── Fixtures ──────────────────────────────────────────────────────────────

const makeTest = (overrides: Partial<EnrichedTestRequest> = {}): EnrichedTestRequest => ({
  id:          'test-id',
  type:        'backend',
  targetUrl:   'https://example.com',
  description: 'load test with 10 users',
  options:     { vus: 10, duration: '1m' },
  createdAt:   '2025-01-01T00:00:00Z',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGenerateScript.mockResolvedValue('export default function() {}');
  mockCompareDescriptions.mockResolvedValue('REGENERATE');
});

// ── Path 1: REUSE verdict ─────────────────────────────────────────────────

describe('consumer routing — REUSE path', () => {
  it('sends reused script to backend queue and acks on REUSE verdict', async () => {
    mockCompareDescriptions.mockResolvedValueOnce('REUSE');
    const ch   = makeChannel();
    const test = makeTest({
      cachedScript:            'cached_script_body',
      cachedScriptDescription: 'old description',
      scriptId:                'script-uuid',
    });

    await processMessage(ch, test);

    expect(ch.sendToQueue).toHaveBeenCalledOnce();
    const [queue, buf] = ch.sendToQueue.mock.calls[0];
    expect(queue).toBe(BACKEND_QUEUE);
    const payload = JSON.parse(buf.toString());
    expect(payload.reusedScript).toBe(true);
    expect(payload.generatedScript).toBe('cached_script_body');
    expect(mockGenerateScript).not.toHaveBeenCalled();
    expect(ch.ack).toHaveBeenCalledOnce();
  });

  it('skips compareDescriptions and REUSEs directly when descriptions are identical', async () => {
    const ch   = makeChannel();
    const test = makeTest({
      description:             'same description',
      cachedScript:            'cached_script_body',
      cachedScriptDescription: 'same description',
      scriptId:                'script-uuid',
    });

    await processMessage(ch, test);

    expect(mockCompareDescriptions).not.toHaveBeenCalled();
    const payload = JSON.parse(ch.sendToQueue.mock.calls[0][1].toString());
    expect(payload.reusedScript).toBe(true);
  });

  it('routes client-side test to client queue on REUSE', async () => {
    mockCompareDescriptions.mockResolvedValueOnce('REUSE');
    const ch   = makeChannel();
    const test = makeTest({
      type:                    'client-side',
      cachedScript:            'puppeteer_script',
      cachedScriptDescription: 'browser test',
    });

    await processMessage(ch, test);

    expect(ch.sendToQueue.mock.calls[0][0]).toBe(CLIENT_QUEUE);
  });
});

// ── Path 2: REGENERATE verdict ────────────────────────────────────────────

describe('consumer routing — REGENERATE path', () => {
  it('calls generateScript and sends to queue on REGENERATE', async () => {
    mockCompareDescriptions.mockResolvedValueOnce('REGENERATE');
    const ch   = makeChannel();
    const test = makeTest({
      cachedScript:            'old_script',
      cachedScriptDescription: 'old description',
      scriptId:                'old-uuid',
    });

    await processMessage(ch, test);

    expect(mockGenerateScript).toHaveBeenCalledOnce();
    expect(ch.sendToQueue).toHaveBeenCalledOnce();
    const payload = JSON.parse(ch.sendToQueue.mock.calls[0][1].toString());
    expect(payload.generatedScript).toBe('export default function() {}');
  });

  it('clears scriptId before regenerating so worker inserts a fresh row', async () => {
    mockCompareDescriptions.mockResolvedValueOnce('REGENERATE');
    const ch   = makeChannel();
    const test = makeTest({
      cachedScript:            'old_script',
      cachedScriptDescription: 'old description',
      scriptId:                'old-uuid',
    });

    await processMessage(ch, test);

    const payload = JSON.parse(ch.sendToQueue.mock.calls[0][1].toString());
    expect(payload.scriptId).toBeUndefined();
  });
});

// ── Path 3: null cachedScriptDescription (legacy row) ─────────────────────

describe('consumer routing — null cachedScriptDescription', () => {
  it('always regenerates when cachedScriptDescription is null', async () => {
    const ch   = makeChannel();
    const test = makeTest({
      cachedScript:            'old_script',
      cachedScriptDescription: null,
      scriptId:                'old-uuid',
    });

    await processMessage(ch, test);

    expect(mockCompareDescriptions).not.toHaveBeenCalled();
    expect(mockGenerateScript).toHaveBeenCalledOnce();
  });
});

// ── Path 4: no cachedScript (fresh generation) ────────────────────────────

describe('consumer routing — no cachedScript', () => {
  it('calls generateScript directly when there is no cached script', async () => {
    const ch   = makeChannel();
    const test = makeTest();

    await processMessage(ch, test);

    expect(mockCompareDescriptions).not.toHaveBeenCalled();
    expect(mockGenerateScript).toHaveBeenCalledOnce();
    expect(ch.ack).toHaveBeenCalledOnce();
  });
});

// ── DLQ path ──────────────────────────────────────────────────────────────

describe('consumer routing — DLQ exhaustion', () => {
  it('retries by republishing when retryCount < MAX_RETRIES', async () => {
    mockGenerateScript.mockRejectedValueOnce(new Error('503'));
    const ch   = makeChannel();
    const test = makeTest();

    await processMessage(ch, test, 1);

    expect(ch.publish).toHaveBeenCalledOnce();
    expect(ch.publish.mock.calls[0][3].headers['x-retry-count']).toBe(2);
    expect(ch.sendToQueue).not.toHaveBeenCalled();
  });

  it('routes to DLQ when retryCount equals MAX_RETRIES', async () => {
    mockGenerateScript.mockRejectedValueOnce(new Error('503'));
    const ch   = makeChannel();
    const test = makeTest();

    await processMessage(ch, test, MAX_RETRIES);

    expect(ch.sendToQueue).toHaveBeenCalledOnce();
    expect(ch.sendToQueue.mock.calls[0][0]).toBe(DLQ);
    expect(ch.publish).not.toHaveBeenCalled();
  });

  it('posts failure status message on DLQ', async () => {
    mockGenerateScript.mockRejectedValueOnce(new Error('503'));
    const ch = makeChannel();

    await processMessage(ch, makeTest(), MAX_RETRIES);

    const calls = postMessage.mock.calls.map(c => c[0] as string);
    expect(calls.some(m => /failed after 3 attempts/.test(m))).toBe(true);
  });

  it('posts retry status message when retrying', async () => {
    mockGenerateScript.mockRejectedValueOnce(new Error('429'));
    const ch = makeChannel();

    await processMessage(ch, makeTest(), 0);

    const calls = postMessage.mock.calls.map(c => c[0] as string);
    expect(calls.some(m => /retrying/i.test(m))).toBe(true);
  });
});

// ─── Malformed message handling ──────────────────────────────────────────
//
// Mirrors the JSON.parse guard at the top of the channel.consume callback
// in src/index.ts: a non-JSON message body must be routed to the DLQ and
// acked, without throwing (which would otherwise crash the consumer or
// leave the message unacked/redelivered indefinitely).

const handleIncomingMessage = (channel: Channel, rawContent: Buffer): void => {
  try {
    JSON.parse(rawContent.toString());
  } catch {
    channel.sendToQueue(DLQ, rawContent, { persistent: true });
    channel.ack({} as never);
    return;
  }
  // valid JSON — normal processing would continue (not exercised here)
  channel.ack({} as never);
};

describe('consumer — malformed message handling', () => {
  it('routes a non-JSON message to the DLQ and acks it without throwing', () => {
    const ch = makeChannel();
    const rawContent = Buffer.from('not valid json {{{');

    expect(() => handleIncomingMessage(ch, rawContent)).not.toThrow();

    expect(ch.sendToQueue).toHaveBeenCalledOnce();
    expect(ch.sendToQueue.mock.calls[0][0]).toBe(DLQ);
    expect(ch.sendToQueue.mock.calls[0][1]).toBe(rawContent);
    expect(ch.ack).toHaveBeenCalledOnce();
    expect(mockGenerateScript).not.toHaveBeenCalled();
    expect(mockCompareDescriptions).not.toHaveBeenCalled();
  });

  it('does not route valid JSON to the DLQ', () => {
    const ch = makeChannel();
    const rawContent = Buffer.from(JSON.stringify(makeTest()));

    handleIncomingMessage(ch, rawContent);

    expect(ch.sendToQueue).not.toHaveBeenCalled();
    expect(ch.ack).toHaveBeenCalledOnce();
  });
});
