import { describe, it, expect } from 'vitest';
import { deriveMultiPercentileThresholds } from '../index';

describe('deriveMultiPercentileThresholds', () => {
  it('derives p90 as 0.8x and p99 as 2x of the given p95 budget', () => {
    expect(deriveMultiPercentileThresholds(1000)).toEqual({ p90: 800, p99: 2000 });
  });

  it('scales proportionally for a tighter p95 budget', () => {
    expect(deriveMultiPercentileThresholds(500)).toEqual({ p90: 400, p99: 1000 });
  });

  it('scales proportionally for a looser p95 budget', () => {
    expect(deriveMultiPercentileThresholds(2000)).toEqual({ p90: 1600, p99: 4000 });
  });

  it('rounds to the nearest integer for a non-round p95 value', () => {
    expect(deriveMultiPercentileThresholds(733)).toEqual({ p90: 586, p99: 1466 });
  });

  it('always keeps p90 < p95 < p99 for a positive p95', () => {
    const { p90, p99 } = deriveMultiPercentileThresholds(1234);
    expect(p90).toBeLessThan(1234);
    expect(p99).toBeGreaterThan(1234);
  });
});
