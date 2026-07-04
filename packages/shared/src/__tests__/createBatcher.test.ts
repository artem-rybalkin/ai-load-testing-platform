import { describe, it, expect, vi, afterEach } from 'vitest';
import { createBatcher } from '../index';

afterEach(() => vi.useRealTimers());

describe('createBatcher', () => {
  it('does not call send() until an item is pushed', () => {
    const send = vi.fn();
    createBatcher(send);
    expect(send).not.toHaveBeenCalled();
  });

  it('flushes immediately once maxBatchSize is reached', () => {
    const send = vi.fn();
    const { push } = createBatcher(send, { maxBatchSize: 3, flushIntervalMs: 10_000 });
    push('a'); push('b');
    expect(send).not.toHaveBeenCalled();
    push('c');
    expect(send).toHaveBeenCalledWith(['a', 'b', 'c']);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('flushes on the interval timer even below maxBatchSize', async () => {
    const send = vi.fn();
    const { push } = createBatcher(send, { maxBatchSize: 50, flushIntervalMs: 20 });
    push('a'); push('b');
    expect(send).not.toHaveBeenCalled();
    await new Promise(resolve => setTimeout(resolve, 35));
    expect(send).toHaveBeenCalledWith(['a', 'b']);
  });

  it('starts a fresh batch after a flush', async () => {
    const send = vi.fn();
    const { push } = createBatcher(send, { maxBatchSize: 2, flushIntervalMs: 10_000 });
    push('a'); push('b'); // flushes ['a','b']
    push('c');
    expect(send).toHaveBeenCalledTimes(1);
    push('d'); // flushes ['c','d']
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(2, ['c', 'd']);
  });

  it('flush() manually sends whatever is pending and clears the timer', () => {
    const send = vi.fn();
    const { push, flush } = createBatcher(send, { maxBatchSize: 50, flushIntervalMs: 10_000 });
    push('a'); push('b');
    flush();
    expect(send).toHaveBeenCalledWith(['a', 'b']);
    flush(); // nothing pending — should not call send again
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not schedule a second timer while one is already pending', async () => {
    const send = vi.fn();
    const { push } = createBatcher(send, { maxBatchSize: 50, flushIntervalMs: 20 });
    push('a');
    push('b'); // should not reset/duplicate the timer
    await new Promise(resolve => setTimeout(resolve, 35));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(['a', 'b']);
  });
});
