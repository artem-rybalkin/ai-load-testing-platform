import { describe, it, expect, vi } from 'vitest';
import type amqplib from 'amqplib';
import { handleRetry } from '../retry';

// ─── Mock channel ─────────────────────────────────────────────────────────────

const makeChannel = () => ({
  publish:     vi.fn(),
  sendToQueue: vi.fn(),
  ack:         vi.fn(),
}) as unknown as amqplib.Channel;

const makeMsg = (headers: Record<string, unknown> = {}): amqplib.Message => ({
  content: Buffer.from(JSON.stringify({ id: 'test-123' })),
  properties: {
    headers,
    deliveryMode: 2,
    contentType: undefined,
    contentEncoding: undefined,
    priority: undefined,
    correlationId: undefined,
    replyTo: undefined,
    expiration: undefined,
    messageId: undefined,
    timestamp: undefined,
    type: undefined,
    userId: undefined,
    appId: undefined,
    clusterId: undefined,
  } as amqplib.MessageProperties,
  fields: {
    deliveryTag: 1,
    redelivered: false,
    exchange: '',
    routingKey: 'client-tests',
    messageCount: 0,
    consumerTag: '',
  } as amqplib.MessageFields,
});

// ─── Retry logic ──────────────────────────────────────────────────────────────

describe('handleRetry — retry increments', () => {
  it('republishes to the same queue on first failure (retry 0 → 1)', () => {
    const ch = makeChannel();
    handleRetry(ch, makeMsg(), 'client-tests', 'client-tests.dlq', 'test-123');

    expect(ch.publish).toHaveBeenCalledOnce();
    expect(ch.publish).toHaveBeenCalledWith(
      '',
      'client-tests',
      expect.any(Buffer),
      expect.objectContaining({ headers: expect.objectContaining({ 'x-retry-count': 1 }) })
    );
    expect(ch.sendToQueue).not.toHaveBeenCalled();
    expect(ch.ack).toHaveBeenCalledOnce();
  });

  it('increments retry count from existing header value', () => {
    const ch = makeChannel();
    handleRetry(ch, makeMsg({ 'x-retry-count': 2 }), 'client-tests', 'client-tests.dlq', 'test-123');

    expect(ch.publish).toHaveBeenCalledWith(
      '',
      'client-tests',
      expect.any(Buffer),
      expect.objectContaining({ headers: expect.objectContaining({ 'x-retry-count': 3 }) })
    );
  });

  it('preserves other existing headers when republishing', () => {
    const ch = makeChannel();
    handleRetry(ch, makeMsg({ 'x-custom': 'abc', 'x-retry-count': 0 }), 'client-tests', 'client-tests.dlq', 'test-123');

    const opts = (ch.publish as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(opts.headers['x-custom']).toBe('abc');
  });
});

// ─── DLQ routing ─────────────────────────────────────────────────────────────

describe('handleRetry — DLQ routing', () => {
  it('routes to DLQ when retry count reaches MAX_RETRIES (3)', () => {
    const ch = makeChannel();
    handleRetry(ch, makeMsg({ 'x-retry-count': 3 }), 'client-tests', 'client-tests.dlq', 'test-123');

    expect(ch.sendToQueue).toHaveBeenCalledOnce();
    expect(ch.sendToQueue).toHaveBeenCalledWith(
      'client-tests.dlq',
      expect.any(Buffer),
      expect.objectContaining({ persistent: true })
    );
    expect(ch.publish).not.toHaveBeenCalled();
    expect(ch.ack).toHaveBeenCalledOnce();
  });

  it('always acks the message regardless of retry vs DLQ path', () => {
    const chRetry = makeChannel();
    handleRetry(chRetry, makeMsg({ 'x-retry-count': 0 }), 'q', 'q.dlq', 'x');
    expect(chRetry.ack).toHaveBeenCalledOnce();

    const chDlq = makeChannel();
    handleRetry(chDlq, makeMsg({ 'x-retry-count': 3 }), 'q', 'q.dlq', 'x');
    expect(chDlq.ack).toHaveBeenCalledOnce();
  });

  it('treats missing x-retry-count header as retry count 0', () => {
    const ch = makeChannel();
    handleRetry(ch, makeMsg({}), 'client-tests', 'client-tests.dlq', 'test-123');

    expect(ch.publish).toHaveBeenCalledWith(
      '',
      'client-tests',
      expect.any(Buffer),
      expect.objectContaining({ headers: expect.objectContaining({ 'x-retry-count': 1 }) })
    );
    expect(ch.sendToQueue).not.toHaveBeenCalled();
  });
});

// ─── Queue name passthrough ───────────────────────────────────────────────────

describe('handleRetry — queue name passthrough', () => {
  it('uses the supplied queue name when republishing', () => {
    const ch = makeChannel();
    handleRetry(ch, makeMsg(), 'my-custom-queue', 'my-custom-queue.dlq', 'id');

    expect(ch.publish).toHaveBeenCalledWith('', 'my-custom-queue', expect.any(Buffer), expect.anything());
  });

  it('uses the supplied dlq name when routing to dead-letter', () => {
    const ch = makeChannel();
    handleRetry(ch, makeMsg({ 'x-retry-count': 3 }), 'my-custom-queue', 'my-custom-queue.dlq', 'id');

    expect(ch.sendToQueue).toHaveBeenCalledWith('my-custom-queue.dlq', expect.any(Buffer), expect.anything());
  });

  it('preserves the original message content when republishing', () => {
    const ch = makeChannel();
    const content = Buffer.from(JSON.stringify({ id: 'abc', type: 'client-side' }));
    const msg = { ...makeMsg(), content };
    handleRetry(ch, msg, 'q', 'q.dlq', 'abc');

    const republishedContent = (ch.publish as ReturnType<typeof vi.fn>).mock.calls[0][2] as Buffer;
    expect(republishedContent.toString()).toBe(content.toString());
  });
});
