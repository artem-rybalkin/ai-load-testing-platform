import { describe, it, expect, vi, afterEach } from 'vitest';
import { drainInFlight } from '../index';

afterEach(() => vi.useRealTimers());

describe('drainInFlight', () => {
  it('resolves immediately when the count is already 0', async () => {
    const start = Date.now();
    await drainInFlight(() => 0, 5000, 10);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('polls until the count drops to 0', async () => {
    let count = 3;
    setTimeout(() => { count = 0; }, 30);
    await drainInFlight(() => count, 5000, 10);
    expect(count).toBe(0);
  });

  it('gives up once the timeout elapses, even if the count never reaches 0', async () => {
    const start = Date.now();
    await drainInFlight(() => 1, 50, 10);
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });

  it('polls at the given interval, not faster', async () => {
    const getCount = vi.fn().mockReturnValue(1);
    await drainInFlight(getCount, 55, 20);
    // ~1 initial check + checks every 20ms for ~55ms — expect roughly 3-4 calls, not e.g. 50+
    expect(getCount.mock.calls.length).toBeLessThan(10);
    expect(getCount.mock.calls.length).toBeGreaterThan(1);
  });
});
