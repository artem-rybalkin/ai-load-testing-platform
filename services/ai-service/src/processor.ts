/**
 * Pure message-routing logic extracted from index.ts for testability.
 * The AMQP consumer in index.ts calls processAiRequest(); tests can call it directly.
 */
import amqplib from 'amqplib';
import { EnrichedTestRequest, internalHeaders } from '@alt/shared';
import { generateScript, compareDescriptions } from './generator';
import { log } from './logger';

export const BACKEND_QUEUE = 'backend-tests';
export const CLIENT_QUEUE  = 'client-tests';
export const MAX_RETRIES   = 3;

export interface ProcessorDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  channel:    Pick<amqplib.Channel, 'sendToQueue' | 'publish' | 'ack'> | any;
  msg:        amqplib.Message | any;
  resultsUrl: string;
  /** Override for testing — defaults to real generateScript */
  generateScript?:     typeof generateScript;
  /** Override for testing — defaults to real compareDescriptions */
  compareDescriptions?: typeof compareDescriptions;
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
