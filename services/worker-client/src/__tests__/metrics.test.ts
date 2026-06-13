import { describe, it, expect } from 'vitest';
import { avgNum, avgResourceBreakdown } from '../index';
import type { ClientMetrics, ResourceBreakdown } from '@alt/shared';

type WebVitalsSnapshot = Omit<ClientMetrics, 'type' | 'lighthouseScore'>;

const makeBreakdown = (overrides: Partial<ResourceBreakdown> = {}): ResourceBreakdown => ({
  jsSize: 0,
  cssSize: 0,
  imageSize: 0,
  fontSize: 0,
  xhrSize: 0,
  totalSize: 0,
  requestCount: 0,
  ...overrides,
});

const makeSnapshot = (overrides: Partial<WebVitalsSnapshot> = {}): WebVitalsSnapshot => ({
  lcp: 0,
  fid: 0,
  cls: 0,
  ttfb: 0,
  fcp: 0,
  ...overrides,
});

// ─── avgNum ────────────────────────────────────────────────────────────────────

describe('avgNum', () => {
  it('returns 0 for an empty snapshots array', () => {
    expect(avgNum([], 'lcp')).toBe(0);
  });

  it('returns the value itself for a single session', () => {
    const snapshots = [makeSnapshot({ lcp: 1234 })];
    expect(avgNum(snapshots, 'lcp')).toBe(1234);
  });

  it('averages the field across multiple sessions', () => {
    const snapshots = [
      makeSnapshot({ lcp: 1000 }),
      makeSnapshot({ lcp: 2000 }),
      makeSnapshot({ lcp: 3000 }),
    ];
    expect(avgNum(snapshots, 'lcp')).toBe(2000);
  });

  it('treats missing/undefined field values as 0 (partial presence)', () => {
    const snapshots = [
      makeSnapshot({ inp: 100 }),
      makeSnapshot({ inp: undefined }),
    ];
    // (100 + 0) / 2 = 50
    expect(avgNum(snapshots, 'inp')).toBe(50);
  });

  it('rounds the result (to 2 decimal places per implementation)', () => {
    const snapshots = [
      makeSnapshot({ fcp: 100 }),
      makeSnapshot({ fcp: 100 }),
      makeSnapshot({ fcp: 100 }),
    ];
    const fractional = [
      makeSnapshot({ fcp: 100 }),
      makeSnapshot({ fcp: 101 }),
      makeSnapshot({ fcp: 101 }),
    ];
    expect(avgNum(snapshots, 'fcp')).toBe(100);
    // sum = 302, /3 = 100.6666... -> rounds to 100.67
    expect(avgNum(fractional, 'fcp')).toBeCloseTo(100.67, 2);
  });
});

// ─── avgResourceBreakdown ────────────────────────────────────────────────────────

describe('avgResourceBreakdown', () => {
  it('returns undefined for an empty sessions array', () => {
    expect(avgResourceBreakdown([])).toBeUndefined();
  });

  it('returns undefined when no session has a resourceBreakdown', () => {
    const snapshots = [makeSnapshot(), makeSnapshot()];
    expect(avgResourceBreakdown(snapshots)).toBeUndefined();
  });

  it('averages only over sessions that have a resourceBreakdown (mixed presence)', () => {
    const snapshots = [
      makeSnapshot({ resourceBreakdown: makeBreakdown({ jsSize: 100, totalSize: 200, requestCount: 10 }) }),
      makeSnapshot(), // no resourceBreakdown — excluded
      makeSnapshot({ resourceBreakdown: makeBreakdown({ jsSize: 200, totalSize: 400, requestCount: 20 }) }),
    ];
    const result = avgResourceBreakdown(snapshots);
    expect(result).toBeDefined();
    // average over the 2 valid sessions only, not 3
    expect(result!.jsSize).toBe(150);
    expect(result!.totalSize).toBe(300);
    expect(result!.requestCount).toBe(15);
  });

  it('averages all ResourceBreakdown fields and rounds to 1 decimal place', () => {
    const snapshots = [
      makeSnapshot({
        resourceBreakdown: makeBreakdown({
          jsSize: 100, cssSize: 10, imageSize: 50, fontSize: 5, xhrSize: 20, totalSize: 185, requestCount: 11,
        }),
      }),
      makeSnapshot({
        resourceBreakdown: makeBreakdown({
          jsSize: 101, cssSize: 11, imageSize: 51, fontSize: 6, xhrSize: 21, totalSize: 190, requestCount: 12,
        }),
      }),
      makeSnapshot({
        resourceBreakdown: makeBreakdown({
          jsSize: 102, cssSize: 12, imageSize: 52, fontSize: 7, xhrSize: 22, totalSize: 195, requestCount: 13,
        }),
      }),
    ];
    const result = avgResourceBreakdown(snapshots);
    expect(result).toEqual({
      jsSize: 101,
      cssSize: 11,
      imageSize: 51,
      fontSize: 6,
      xhrSize: 21,
      totalSize: 190,
      requestCount: 12,
    });
  });

  it('rounds a fractional average to 1 decimal place', () => {
    const snapshots = [
      makeSnapshot({ resourceBreakdown: makeBreakdown({ jsSize: 10 }) }),
      makeSnapshot({ resourceBreakdown: makeBreakdown({ jsSize: 11 }) }),
      makeSnapshot({ resourceBreakdown: makeBreakdown({ jsSize: 11 }) }),
    ];
    const result = avgResourceBreakdown(snapshots);
    // sum = 32, / 3 = 10.6666... -> 10.7
    expect(result!.jsSize).toBe(10.7);
  });
});

// ─── INP fallback chain (lhInp ?? avgNum('inp')) ─────────────────────────────────

describe('INP fallback chain', () => {
  const computeInp = (lhInp: number | undefined, snapshots: WebVitalsSnapshot[]): number | undefined => {
    const avgInp = avgNum(snapshots, 'inp');
    return lhInp ?? (avgInp > 0 ? avgInp : undefined);
  };

  it('uses the Lighthouse INP value when present, taking precedence over PerformanceObserver average', () => {
    const snapshots = [makeSnapshot({ inp: 500 })];
    expect(computeInp(150, snapshots)).toBe(150);
  });

  it('falls back to the PerformanceObserver average when Lighthouse INP is absent', () => {
    const snapshots = [makeSnapshot({ inp: 250 })];
    expect(computeInp(undefined, snapshots)).toBe(250);
  });

  it('returns undefined when both Lighthouse INP is absent and PerformanceObserver INP averages to 0', () => {
    const snapshots = [makeSnapshot({ inp: 0 })];
    expect(computeInp(undefined, snapshots)).toBeUndefined();
  });

  it('returns undefined when Lighthouse INP is absent and no session reported inp at all', () => {
    const snapshots = [makeSnapshot()];
    expect(computeInp(undefined, snapshots)).toBeUndefined();
  });
});
