import { describe, it, expect } from 'vitest';
import { computeJourneys, validateStepPercents } from '../journeys';
import type { FlowStep } from '../index';

const step = (name: string, userPercent?: number): FlowStep => ({
  name, url: `https://example.com/${name}`, method: 'GET',
  ...(userPercent !== undefined ? { userPercent } : {}),
});

describe('computeJourneys', () => {
  it('collapses to a single default journey when no step sets userPercent', () => {
    const steps = [step('a'), step('b'), step('c')];
    expect(computeJourneys(steps, 100)).toEqual([{ stepCount: 3, vus: 100, execName: 'default' }]);
  });

  it('collapses to a single default journey when every step explicitly sets the same percent', () => {
    const steps = [step('a', 50), step('b', 50)];
    expect(computeJourneys(steps, 100)).toEqual([{ stepCount: 2, vus: 100, execName: 'default' }]);
  });

  it('matches the TODO 40/40/20 three-tier example', () => {
    // step1 implicit 100, step2 drops to 60, step3 (full flow) drops to 20
    const steps = [step('login'), step('search', 60), step('checkout', 20)];
    expect(computeJourneys(steps, 100)).toEqual([
      { stepCount: 1, vus: 40, execName: 'journey1' },
      { stepCount: 2, vus: 40, execName: 'journey2' },
      { stepCount: 3, vus: 20, execName: 'journey3' },
    ]);
  });

  it('handles a two-tier split', () => {
    const steps = [step('a'), step('b', 30)];
    const journeys = computeJourneys(steps, 100);
    expect(journeys).toEqual([
      { stepCount: 1, vus: 70, execName: 'journey1' },
      { stepCount: 2, vus: 30, execName: 'journey2' },
    ]);
  });

  it('rounds and fixes up the remainder so the total always equals totalVus', () => {
    // thirds of 100 VUs across 3 tiers: 33.3/33.3/33.3 -> must still sum to 100
    const steps = [step('a', 100), step('b', 66.666), step('c', 33.333)];
    const journeys = computeJourneys(steps, 100);
    expect(journeys.reduce((sum, j) => sum + j.vus, 0)).toBe(100);
    expect(journeys).toHaveLength(3);
  });

  it('redistributes proportionally when step 1 itself is below 100', () => {
    // step1=50 (only half of totalVus ever start), step2=20 (full flow)
    const steps = [step('a', 50), step('b', 20)];
    const journeys = computeJourneys(steps, 100);
    // share of run1 (a-only): (50-20)/50 = 0.6 -> 60 vus; run2 (full flow): 20/50 = 0.4 -> 40 vus
    expect(journeys).toEqual([
      { stepCount: 1, vus: 60, execName: 'journey1' },
      { stepCount: 2, vus: 40, execName: 'journey2' },
    ]);
    expect(journeys.reduce((sum, j) => sum + j.vus, 0)).toBe(100);
  });

  it('drops tiers that round down to zero VUs and collapses further if only one remains', () => {
    // totalVus=1 split across 3 near-equal tiers - only one tier can get the single VU
    const steps = [step('a'), step('b', 66), step('c', 33)];
    const journeys = computeJourneys(steps, 1);
    expect(journeys).toEqual([{ stepCount: 1, vus: 1, execName: 'default' }]);
  });

  it('handles a single-step flow', () => {
    const steps = [step('only')];
    expect(computeJourneys(steps, 25)).toEqual([{ stepCount: 1, vus: 25, execName: 'default' }]);
  });
});

describe('validateStepPercents', () => {
  it('accepts an undefined-percent flow', () => {
    expect(validateStepPercents([step('a'), step('b')])).toBeNull();
  });

  it('accepts a valid non-increasing sequence', () => {
    expect(validateStepPercents([step('a', 100), step('b', 60), step('c', 20)])).toBeNull();
  });

  it('rejects an out-of-range percent above 100', () => {
    expect(validateStepPercents([step('a', 150)])).toMatch(/between 0 and 100/);
  });

  it('rejects a negative percent', () => {
    expect(validateStepPercents([step('a', -5)])).toMatch(/between 0 and 100/);
  });

  it('rejects a percent that increases from the previous step', () => {
    expect(validateStepPercents([step('a', 40), step('b', 80)])).toMatch(/cannot exceed step 1/);
  });

  it('allows equal consecutive percents (flat funnel)', () => {
    expect(validateStepPercents([step('a', 50), step('b', 50)])).toBeNull();
  });
});
