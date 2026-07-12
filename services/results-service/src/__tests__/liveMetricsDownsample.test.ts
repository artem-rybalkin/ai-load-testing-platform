import { describe, it, expect } from 'vitest';
import { downsampleLivePoints, MAX_LIVE_POINTS } from '../liveMetricsDownsample';

const points = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

describe('downsampleLivePoints', () => {
  it('returns the array unchanged when at or under the cap', () => {
    const rows = points(50);
    expect(downsampleLivePoints(rows, 100)).toBe(rows);
    expect(downsampleLivePoints(points(100), 100)).toHaveLength(100);
  });

  it('sub-samples uniformly once over the cap, bounding the result size', () => {
    const rows = points(1000);
    const result = downsampleLivePoints(rows, 100);
    expect(result.length).toBeLessThanOrEqual(101); // cap + possible tail append
    expect(result.length).toBeGreaterThan(50);
  });

  it('always includes the last row so the chart tail is never stale', () => {
    const rows = points(1000);
    const result = downsampleLivePoints(rows, 100);
    expect(result[result.length - 1]).toEqual({ i: 999 });
  });

  it('always includes the first row', () => {
    const rows = points(1000);
    const result = downsampleLivePoints(rows, 100);
    expect(result[0]).toEqual({ i: 0 });
  });

  it('preserves chronological order of the sampled subset', () => {
    const rows = points(777);
    const result = downsampleLivePoints(rows, 100);
    for (let k = 1; k < result.length; k++) {
      expect(result[k]!.i).toBeGreaterThan(result[k - 1]!.i); // guarded by the loop's k < result.length condition
    }
  });

  it('defaults to MAX_LIVE_POINTS when no cap is given', () => {
    const rows = points(MAX_LIVE_POINTS + 500);
    const result = downsampleLivePoints(rows);
    expect(result.length).toBeLessThanOrEqual(MAX_LIVE_POINTS + 1);
  });

  it('handles an empty array', () => {
    expect(downsampleLivePoints([], 100)).toEqual([]);
  });

  it('handles exactly cap+1 rows', () => {
    const rows = points(101);
    const result = downsampleLivePoints(rows, 100);
    expect(result[result.length - 1]).toEqual({ i: 100 });
    expect(result.length).toBeLessThanOrEqual(101);
  });
});
