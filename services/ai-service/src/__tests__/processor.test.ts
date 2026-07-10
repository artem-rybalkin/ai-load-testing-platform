/**
 * Unit tests for ai-service processAiRequest (H4).
 * Covers: REUSE path, REGENERATE path, generation fallthrough, DLQ after MAX_RETRIES,
 *         cachedScript/cachedScriptDescription passthrough, backend vs client-side queue routing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EnrichedTestRequest } from '@alt/shared';
import { processAiRequest, BACKEND_QUEUE, CLIENT_QUEUE, MAX_RETRIES } from '../processor';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@alt/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alt/shared')>();
  return { ...actual, internalHeaders: vi.fn(() => ({ 'Content-Type': 'application/json' })) };
});

// ─── Test builders ────────────────────────────────────────────────────────────

const BASE_TEST: EnrichedTestRequest = {
  id: 'test-id-1',
  type: 'backend',
  targetUrl: 'http://example.com',
  description: 'load test with 100 VUs',
  options: { vus: 100, duration: '30s' },
  createdAt: new Date().toISOString(),
};

function makeChannel() {
  return {
    sendToQueue: vi.fn(),
    publish:     vi.fn(),
    ack:         vi.fn(),
  };
}

function makeMsg(headers: Record<string, unknown> = {}) {
  return {
    content:    Buffer.from(JSON.stringify(BASE_TEST)),
    properties: { headers },
  };
}

function makeDeps(
  overrides: {
    channel?:             ReturnType<typeof makeChannel>;
    msg?:                 ReturnType<typeof makeMsg>;
    generateScript?:      (t: EnrichedTestRequest) => Promise<string>;
    compareDescriptions?: (...args: unknown[]) => Promise<'REUSE' | 'REGENERATE'>;
  } = {},
) {
  const channel = overrides.channel ?? makeChannel();
  const msg     = overrides.msg     ?? makeMsg();
  const mockFetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', mockFetch);

  return {
    channel,
    msg,
    deps: {
      channel,
      msg,
      resultsUrl:          'http://results-service:3004',
      generateScript:      overrides.generateScript ?? vi.fn().mockResolvedValue('export default function(){}'),
      compareDescriptions: overrides.compareDescriptions as any,
    },
    mockFetch,
  };
}

// ─── Standard generation path ─────────────────────────────────────────────────

describe('processAiRequest — standard generation path', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('generates a script and sends to backend-tests queue for type=backend', async () => {
    const { channel, deps } = makeDeps();
    await processAiRequest(BASE_TEST, deps);

    expect(channel.sendToQueue).toHaveBeenCalledWith(
      BACKEND_QUEUE,
      expect.any(Buffer),
      { persistent: true },
    );
    expect(channel.ack).toHaveBeenCalled();
  });

  it('routes to client-tests queue for type=client-side', async () => {
    const { channel, deps } = makeDeps();
    await processAiRequest({ ...BASE_TEST, type: 'client-side' }, deps);

    expect(channel.sendToQueue).toHaveBeenCalledWith(
      CLIENT_QUEUE,
      expect.any(Buffer),
      { persistent: true },
    );
  });

  it('routes to backend-tests queue for type=flow', async () => {
    const { channel, deps } = makeDeps();
    await processAiRequest({ ...BASE_TEST, type: 'flow' }, deps);

    expect(channel.sendToQueue).toHaveBeenCalledWith(
      BACKEND_QUEUE,
      expect.any(Buffer),
      { persistent: true },
    );
  });

  it('includes the generated script in the enqueued payload', async () => {
    const script = 'export default function(){ http.get("https://x.com"); }';
    const { channel, deps } = makeDeps({ generateScript: vi.fn().mockResolvedValue(script) });
    await processAiRequest(BASE_TEST, deps);

    const payload = JSON.parse(channel.sendToQueue.mock.calls[0][1].toString());
    expect(payload.generatedScript).toBe(script);
  });

  it('posts "Generating…" and "Script ready…" status messages', async () => {
    const { mockFetch, deps } = makeDeps();
    await processAiRequest(BASE_TEST, deps);

    const bodies = mockFetch.mock.calls.map((c: unknown[]) => {
      try { return JSON.parse((c[1] as RequestInit).body as string).message as string; } catch { return ''; }
    });
    expect(bodies.some(b => b.includes('Generating test script'))).toBe(true);
    expect(bodies.some(b => b.includes('Script ready'))).toBe(true);
  });
});

// ─── REUSE path ───────────────────────────────────────────────────────────────

describe('processAiRequest — REUSE path', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  const reuseTest: EnrichedTestRequest = {
    ...BASE_TEST,
    cachedScript:            'export default function(){}',
    cachedScriptDescription: 'load test with 100 VUs',
    scriptId:                'cached-script-id',
  };

  it('forwards the cached script unchanged when verdict is REUSE', async () => {
    const { channel, deps } = makeDeps({
      compareDescriptions: vi.fn().mockResolvedValue('REUSE'),
    });
    await processAiRequest(reuseTest, deps);

    expect(channel.sendToQueue).toHaveBeenCalledOnce();
    const payload = JSON.parse(channel.sendToQueue.mock.calls[0][1].toString());
    expect(payload.generatedScript).toBe(reuseTest.cachedScript);
    expect(payload.reusedScript).toBe(true);
    expect(payload.scriptId).toBe('cached-script-id'); // preserved
  });

  it('skips compareDescriptions when descriptions are identical (saves quota)', async () => {
    const { channel, deps } = makeDeps({
      compareDescriptions: vi.fn().mockResolvedValue('REUSE'),
    });
    // descriptions match exactly — should bypass compareDescriptions
    await processAiRequest(reuseTest, deps);

    expect(deps.compareDescriptions).not.toHaveBeenCalled();
    const payload = JSON.parse(channel.sendToQueue.mock.calls[0][1].toString());
    expect(payload.reusedScript).toBe(true);
  });

  it('calls compareDescriptions when descriptions differ', async () => {
    const compareDescriptions = vi.fn().mockResolvedValue('REUSE');
    const { deps } = makeDeps({ compareDescriptions });
    await processAiRequest(
      { ...reuseTest, description: 'different description', cachedScriptDescription: 'original description' },
      deps,
    );

    expect(compareDescriptions).toHaveBeenCalledWith(
      'different description',
      'original description',
      undefined, // projectId
    );
  });

  it('does not call generateScript when verdict is REUSE', async () => {
    const generateScript = vi.fn().mockResolvedValue('');
    const { deps } = makeDeps({ generateScript, compareDescriptions: vi.fn().mockResolvedValue('REUSE') });
    await processAiRequest(
      { ...reuseTest, description: 'something different', cachedScriptDescription: 'original' },
      deps,
    );
    expect(generateScript).not.toHaveBeenCalled();
  });
});

// ─── REGENERATE path ──────────────────────────────────────────────────────────

describe('processAiRequest — REGENERATE path', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('clears scriptId and regenerates when verdict is REGENERATE', async () => {
    const newScript = 'export default function newScript(){}';
    const generateScript = vi.fn().mockResolvedValue(newScript);
    const { channel, deps } = makeDeps({
      generateScript,
      compareDescriptions: vi.fn().mockResolvedValue('REGENERATE'),
    });
    const test: EnrichedTestRequest = {
      ...BASE_TEST,
      cachedScript:            'old script',
      cachedScriptDescription: 'old description',
      scriptId:                'old-script-id',
      description:             'new description',
    };

    await processAiRequest(test, deps);

    expect(generateScript).toHaveBeenCalled();
    const payload = JSON.parse(channel.sendToQueue.mock.calls[0][1].toString());
    expect(payload.generatedScript).toBe(newScript);
    expect(payload.scriptId).toBeUndefined(); // cleared so worker re-saves
  });

  it('regenerates when cachedScriptDescription is null (legacy row)', async () => {
    const generateScript = vi.fn().mockResolvedValue('new script');
    const { channel, deps } = makeDeps({ generateScript });
    const test: EnrichedTestRequest = {
      ...BASE_TEST,
      cachedScript:            'old script',
      cachedScriptDescription: null as unknown as string,
      description:             'any description',
      scriptId:                'old-script-id',
    };

    await processAiRequest(test, deps);

    expect(generateScript).toHaveBeenCalled();
    const payload = JSON.parse(channel.sendToQueue.mock.calls[0][1].toString());
    expect(payload.scriptId).toBeUndefined(); // cleared
  });
});

// ─── DLQ after MAX_RETRIES ────────────────────────────────────────────────────

describe('processAiRequest — DLQ routing after MAX_RETRIES', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('routes to ai-requests.dlq and marks test failed after MAX_RETRIES', async () => {
    const { channel, deps, mockFetch } = makeDeps({
      generateScript: vi.fn().mockRejectedValue(new Error('Gemini 429')),
    });
    const exhaustedMsg = makeMsg({ 'x-retry-count': MAX_RETRIES });
    deps.msg = exhaustedMsg;

    await processAiRequest(BASE_TEST, deps);

    expect(channel.sendToQueue).toHaveBeenCalledWith(
      'ai-requests.dlq',
      exhaustedMsg.content,
      { persistent: true },
    );
    expect(channel.publish).not.toHaveBeenCalled();

    // also POSTs /results/:id/fail
    const failCall = mockFetch.mock.calls.find(
      (c: unknown[]) => String(c[0]).endsWith('/fail'),
    );
    expect(failCall).toBeDefined();

    // posts "failed after 3 attempts" message
    const bodies = mockFetch.mock.calls.map((c: unknown[]) => {
      try { return JSON.parse((c[1] as RequestInit).body as string).message as string; } catch { return ''; }
    });
    expect(bodies.some(b => b.includes('failed after 3 attempts'))).toBe(true);
  });

  it('retries with incremented x-retry-count when below MAX_RETRIES', async () => {
    const { channel, deps } = makeDeps({
      generateScript: vi.fn().mockRejectedValue(new Error('Gemini 429')),
    });
    const firstMsg = makeMsg({ 'x-retry-count': 0 });
    deps.msg = firstMsg;

    await processAiRequest(BASE_TEST, deps);

    expect(channel.publish).toHaveBeenCalledWith(
      '',
      'ai-requests',
      firstMsg.content,
      expect.objectContaining({ headers: expect.objectContaining({ 'x-retry-count': 1 }) }),
    );
    expect(channel.sendToQueue).not.toHaveBeenCalledWith('ai-requests.dlq', expect.anything(), expect.anything());
    expect(channel.ack).toHaveBeenCalled();
  });

  it('posts retry warning message with decreasing attempts-left count', async () => {
    const { mockFetch, deps } = makeDeps({
      generateScript: vi.fn().mockRejectedValue(new Error('Gemini 429')),
    });
    const firstMsg = makeMsg({ 'x-retry-count': 2 }); // 2 already retried → 1 left (MAX_RETRIES - 2 = 1)
    deps.msg = firstMsg;

    await processAiRequest(BASE_TEST, deps);

    const bodies = mockFetch.mock.calls.map((c: unknown[]) => {
      try { return JSON.parse((c[1] as RequestInit).body as string).message as string; } catch { return ''; }
    });
    expect(bodies.some(b => b.includes('1 attempt'))).toBe(true);
  });

  it('treats missing x-retry-count as 0 (first attempt)', async () => {
    const { channel, deps } = makeDeps({
      generateScript: vi.fn().mockRejectedValue(new Error('fail')),
    });
    const noHeaderMsg = makeMsg();
    deps.msg = noHeaderMsg;

    await processAiRequest(BASE_TEST, deps);

    expect(channel.publish).toHaveBeenCalledWith(
      '',
      'ai-requests',
      noHeaderMsg.content,
      expect.objectContaining({ headers: expect.objectContaining({ 'x-retry-count': 1 }) }),
    );
  });
});

// ─── cachedScript passthrough (no description → go straight to generate) ──────

describe('processAiRequest — cachedScript without description', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('goes to generateScript when cachedScript exists but description is empty', async () => {
    const generateScript = vi.fn().mockResolvedValue('new script');
    const { deps } = makeDeps({ generateScript });
    const test: EnrichedTestRequest = {
      ...BASE_TEST,
      cachedScript: 'old script',
      description:  '', // empty → skip comparison
    };

    await processAiRequest(test, deps);
    expect(generateScript).toHaveBeenCalled();
  });
});

// ─── ack is always called ────────────────────────────────────────────────────

describe('processAiRequest — ack guarantee', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('acks the message on successful generation', async () => {
    const { channel, deps } = makeDeps();
    await processAiRequest(BASE_TEST, deps);
    expect(channel.ack).toHaveBeenCalledOnce();
  });

  it('acks the message on REUSE', async () => {
    const { channel, deps } = makeDeps({
      compareDescriptions: vi.fn().mockResolvedValue('REUSE'),
    });
    await processAiRequest(
      { ...BASE_TEST, cachedScript: 's', cachedScriptDescription: 'orig', description: 'diff' },
      deps,
    );
    expect(channel.ack).toHaveBeenCalledOnce();
  });

  it('acks the message on generation error (before/after DLQ)', async () => {
    const { channel, deps } = makeDeps({
      generateScript: vi.fn().mockRejectedValue(new Error('fail')),
    });
    deps.msg = makeMsg({ 'x-retry-count': MAX_RETRIES });
    await processAiRequest(BASE_TEST, deps);
    expect(channel.ack).toHaveBeenCalledOnce();
  });
});

// ─── Regression: REGENERATE→failure retry requeues original message (Finding #3) ──

describe('regression: REGENERATE→generate-failure requeues original message (finding #3)', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it(
    'requeued message omits cachedScript so retry skips comparison',
    async () => {
      const compareDescriptions = vi.fn().mockResolvedValue('REGENERATE');
      const generateScript = vi.fn().mockRejectedValue(new Error('Gemini unavailable'));
      const { channel, deps } = makeDeps({ generateScript, compareDescriptions });

      const test: EnrichedTestRequest = {
        ...BASE_TEST,
        cachedScript: 'export default function cached(){}',
        cachedScriptDescription: 'old description',
        description: 'new description — semantically different',
        scriptId: 'old-script-id',
      };

      // msg.content holds the original test object (with cachedScript) so we can
      // inspect exactly what the retry requeues.
      deps.msg = {
        content: Buffer.from(JSON.stringify(test)),
        properties: { headers: { 'x-retry-count': 0 } },
      };

      await processAiRequest(test, deps);

      // A retry should have been published (retryCount=0 < MAX_RETRIES=3)
      expect(channel.publish).toHaveBeenCalledOnce();

      const requeuedBuffer = channel.publish.mock.calls[0][2] as Buffer;
      const requeuedMsg = JSON.parse(requeuedBuffer.toString()) as Record<string, unknown>;

      // Correct behavior: the requeued message should NOT carry cachedScript/cachedScriptDescription
      // so the next processAiRequest call bypasses compareDescriptions and goes straight to generate —
      // avoiding a redundant LLM comparison call on every one of the 3 retry attempts.
      // Bug: processor.ts publishes msg.content (the original buffer), which still has cachedScript,
      // causing compareDescriptions to fire again on each retry.
      expect(requeuedMsg['cachedScript']).toBeUndefined();
    },
  );
});
