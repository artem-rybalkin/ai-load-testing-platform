/**
 * Pure message-routing logic extracted from index.ts for testability.
 * The AMQP consumer in index.ts calls processAiRequest(); tests can call it directly.
 */
import amqplib from 'amqplib';
import { EnrichedTestRequest, internalHeaders } from '@alt/shared';
import { generateScript, compareDescriptions, checkAndIncrementGeminiUsage } from './generator';
import { log } from './logger';

export const BACKEND_QUEUE = 'backend-tests';
export const CLIENT_QUEUE  = 'client-tests';
export const MAX_RETRIES   = 3;

/** Distinguishes a quota-exceeded stop from a transient Gemini/network failure —
 *  retrying an exhausted daily quota can't succeed, so the catch block below
 *  skips the normal 3-attempt retry loop for this error specifically. */
class GeminiQuotaExceededError extends Error {}

// A minimal Message shape — only what this module actually reads (msg.content,
// msg.properties.headers). A real amqplib.Message satisfies this trivially; test
// fixtures don't need to fabricate the internal `fields` or the rest of
// amqplib's full MessageProperties (contentType, deliveryMode, priority, etc.).
interface MinimalMessage {
  content: Buffer;
  properties: { headers?: amqplib.MessagePropertyHeaders | undefined };
}

export interface ProcessorDeps {
  // Custom (not Pick<amqplib.Channel, ...>) method signatures accepting MinimalMessage —
  // a real amqplib.Channel structurally satisfies this (method-syntax parameters are
  // checked bivariantly), while test mocks can pass a lighter msg fixture too.
  channel: {
    sendToQueue(queue: string, content: Buffer, options?: amqplib.Options.Publish): boolean;
    publish(exchange: string, routingKey: string, content: Buffer, options?: amqplib.Options.Publish): boolean;
    ack(message: MinimalMessage, allUpTo?: boolean): void;
  };
  msg:        MinimalMessage;
  resultsUrl: string;
  /** Override for testing — defaults to real generateScript */
  generateScript?:     typeof generateScript;
  /** Override for testing — defaults to real compareDescriptions */
  compareDescriptions?: typeof compareDescriptions;
  /** Override for testing — defaults to real checkAndIncrementGeminiUsage */
  checkAndIncrementGeminiUsage?: typeof checkAndIncrementGeminiUsage;
}

const postMessage = async (resultsUrl: string, testId: string, message: string): Promise<void> => {
  await fetch(`${resultsUrl}/results/${testId}/message`, {
    method: 'POST',
    headers: internalHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message }),
  }).catch(() => {});
};

export const processAiRequest = async (
  test: EnrichedTestRequest,
  deps: ProcessorDeps,
): Promise<void> => {
  const { channel, msg, resultsUrl } = deps;
  const genScript  = deps.generateScript     ?? generateScript;
  const compareFn  = deps.compareDescriptions ?? compareDescriptions;
  const checkQuota = deps.checkAndIncrementGeminiUsage ?? checkAndIncrementGeminiUsage;

  const targetQueue = (test.type === 'backend' || test.type === 'flow')
    ? BACKEND_QUEUE
    : CLIENT_QUEUE;

  try {
    // Description comparison path: cached script + stored description both present
    if (test.cachedScript && test.description) {
      if (test.cachedScriptDescription == null) {
        log.info({ testId: test.id }, 'Cached script has no stored description — regenerating');
        test = { ...test, scriptId: undefined, cachedScript: undefined, cachedScriptDescription: undefined };
      } else {
        const same = test.description.trim().toLowerCase() === test.cachedScriptDescription.trim().toLowerCase();
        // Exact-match REUSE never calls Gemini at all — only charge quota for
        // the real LLM call compareFn is about to make.
        if (!same) {
          const quotaError = await checkQuota(test.projectId);
          if (quotaError) throw new GeminiQuotaExceededError(quotaError);
        }
        const verdict = same ? 'REUSE' : await compareFn(test.description, test.cachedScriptDescription, test.projectId);
        log.info({ testId: test.id, verdict }, 'Description comparison result');
        if (verdict === 'REUSE') {
          const reused: EnrichedTestRequest = { ...test, generatedScript: test.cachedScript, reusedScript: true };
          channel.sendToQueue(targetQueue, Buffer.from(JSON.stringify(reused)), { persistent: true });
          log.info({ testId: test.id, targetQueue }, 'Script reused after semantic comparison');
          channel.ack(msg);
          return;
        }
        // Clear cached fields so any retry skips straight to generation — no redundant LLM comparison.
        test = { ...test, scriptId: undefined, cachedScript: undefined, cachedScriptDescription: undefined };
      }
    }

    const genQuotaError = await checkQuota(test.projectId);
    if (genQuotaError) throw new GeminiQuotaExceededError(genQuotaError);

    // Fire-and-forget — postMessage already swallows its own errors; awaiting it here
    // would block script generation/dispatch on a non-essential status-notification round-trip.
    void postMessage(resultsUrl, test.id, 'Generating test script with AI…');
    const script = await genScript(test);
    void postMessage(resultsUrl, test.id, 'Script ready — starting test…');

    const enrichedTest: EnrichedTestRequest = { ...test, generatedScript: script };
    channel.sendToQueue(targetQueue, Buffer.from(JSON.stringify(enrichedTest)), { persistent: true });
    log.info({ testId: test.id, targetQueue }, 'Script generated and routed');
    channel.ack(msg);
  } catch (err) {
    log.error({ testId: test.id, err: (err as Error).message }, 'Script generation failed');
    // Retrying an exhausted daily quota can't succeed — it'll hit the same
    // wall every time until tomorrow, so fail immediately instead of burning
    // 3 retry cycles (each up to a minute of Gemini backoff) on a foregone
    // conclusion, and report the real reason instead of "Gemini unavailable".
    if (err instanceof GeminiQuotaExceededError) {
      await postMessage(resultsUrl, test.id, err.message);
      channel.sendToQueue('ai-requests.dlq', msg.content, { persistent: true });
      await fetch(`${resultsUrl}/results/${test.id}/fail`, {
        method: 'POST',
        headers: internalHeaders(),
      }).catch(() => {});
      channel.ack(msg);
      return;
    }
    const retryCount = Number(msg.properties.headers?.['x-retry-count'] ?? 0);
    if (retryCount < MAX_RETRIES) {
      const attemptsLeft = MAX_RETRIES - retryCount;
      await postMessage(
        resultsUrl,
        test.id,
        `Gemini unavailable — retrying… (${attemptsLeft} attempt${attemptsLeft !== 1 ? 's' : ''} left)`,
      );
      channel.publish('', 'ai-requests', Buffer.from(JSON.stringify(test)), {
        persistent: true,
        headers: { ...msg.properties.headers, 'x-retry-count': retryCount + 1 },
      });
    } else {
      await postMessage(resultsUrl, test.id, 'Script generation failed after 3 attempts — test could not start');
      channel.sendToQueue('ai-requests.dlq', msg.content, { persistent: true });
      await fetch(`${resultsUrl}/results/${test.id}/fail`, {
        method: 'POST',
        headers: internalHeaders(),
      }).catch(() => {});
    }
    channel.ack(msg);
  }
};
