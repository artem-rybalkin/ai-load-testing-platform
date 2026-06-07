# Pattern: RabbitMQ Consumer with DLQ Retry

## Context
Used in: ai-service, worker-backend, worker-client, results-service

## Problem
Message processing can fail transiently (Gemini 429, DB down, k6 crash). Messages must be retried but not infinitely.

## Solution

```typescript
// Setup: declare DLQ and main queue with x-dead-letter-exchange
await channel.assertQueue(`${QUEUE}.dlq`, { durable: true });
await channel.assertQueue(QUEUE, {
  durable: true,
  arguments: {
    'x-dead-letter-exchange': '',
    'x-dead-letter-routing-key': `${QUEUE}.dlq`,
  }
});

// Consumer: increment x-retry-count, nack to DLQ after max retries
channel.consume(QUEUE, async (msg) => {
  const retryCount = (msg.properties.headers['x-retry-count'] ?? 0) as number;
  try {
    await processMessage(JSON.parse(msg.content.toString()));
    channel.ack(msg);
  } catch (err) {
    if (retryCount >= MAX_RETRIES) {
      logger.error({ err }, 'Max retries reached, sending to DLQ');
      await markTestFailed(testId); // IMPORTANT: mark as failed immediately
      channel.ack(msg);             // ack to remove from main queue
    } else {
      channel.nack(msg, false, false); // nack to trigger DLQ routing
    }
  }
});
```

## Key Rules
- MAX_RETRIES = 3 across all consumers
- Always mark test as `failed` on DLQ exhaustion (don't rely on stale cleanup)
- Use `channel.ack(msg)` after routing to DLQ (explicit, not nack)
- Include testId in every log line
