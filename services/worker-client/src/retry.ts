import amqplib from 'amqplib';
import { log } from './logger';

const MAX_RETRIES = 3;

export const handleRetry = (
  channel: amqplib.Channel,
  msg: amqplib.Message,
  queue: string,
  dlq: string,
  testId: string
) => {
  const retryCount = ((msg.properties.headers?.['x-retry-count'] as number) ?? 0);
  if (retryCount < MAX_RETRIES) {
    log.warn({ testId, retryCount: retryCount + 1, maxRetries: MAX_RETRIES }, 'Retrying message');
    channel.publish('', queue, msg.content, {
      persistent: true,
      headers: { ...msg.properties.headers, 'x-retry-count': retryCount + 1 }
    });
  } else {
    log.error({ testId, retryCount }, 'Max retries exceeded, routing to DLQ');
    channel.sendToQueue(dlq, msg.content, { persistent: true });
  }
  channel.ack(msg);
};
