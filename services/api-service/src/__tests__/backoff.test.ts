import { describe, it, expect, vi } from 'vitest';
import { connectWithBackoff } from '@alt/shared';

describe('connectWithBackoff', () => {
  it('returns the result immediately on first success', async () => {
    const connect = vi.fn().mockResolvedValue('connected');
    await expect(connectWithBackoff(connect)).resolves.toBe('connected');
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('retries with exponential backoff capped at maxDelayMs until it succeeds', async () => {
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce('connected');
    const onRetry = vi.fn();

    vi.useFakeTimers();
    try {
      const promise = connectWithBackoff(connect, { initialDelayMs: 1000, maxDelayMs: 30000, onRetry });
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBe('connected');

      expect(connect).toHaveBeenCalledTimes(3);
      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry.mock.calls[0]![1]).toBe(1);
      expect(onRetry.mock.calls[0]![2]).toBe(1000);  // 1s
      expect(onRetry.mock.calls[1]![1]).toBe(2);
      expect(onRetry.mock.calls[1]![2]).toBe(2000);  // 2s
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps the delay at maxDelayMs and never gives up', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('persistent failure'));
    const onRetry = vi.fn();

    vi.useFakeTimers();
    try {
      const promise = connectWithBackoff(connect, { initialDelayMs: 1000, maxDelayMs: 4000, onRetry });
      promise.catch(() => {}); // never resolves; suppress unhandled rejection noise

      // Advance through enough attempts that delay would exceed maxDelayMs without the cap
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(4000);
      }

      expect(connect.mock.calls.length).toBeGreaterThan(5);
      const delays = onRetry.mock.calls.map((call) => call[2]);
      expect(Math.max(...delays)).toBe(4000);
    } finally {
      vi.useRealTimers();
    }
  });
});
