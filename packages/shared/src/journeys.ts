import type { FlowStep } from './index';

/**
 * One parallel k6 scenario covering a prefix of a flow's steps.
 * `execName` is 'default' when there's only one journey (the common,
 * backward-compatible case) — it maps to k6's plain `export default
 * function`, not a named `exec`/`scenarios` entry.
 */
export interface Journey {
  stepCount: number;
  vus: number;
  execName: string;
}

// Missing userPercent inherits the previous step's effective value; step 1
// defaults to 100 (all VUs start the flow) when unset.
const effectivePercents = (steps: FlowStep[]): number[] => {
  let prev = 100;
  return steps.map(s => {
    const p = s.userPercent ?? prev;
    prev = p;
    return p;
  });
};

/**
 * Splits totalVus across parallel "journeys" — prefixes of the flow's steps —
 * based on each step's effective % of users still active. Steps are grouped
 * into maximal runs of equal effective percent; each run becomes one journey
 * ending at that run's last step. A run's VU share is (runPercent -
 * nextRunPercent) / firstStepPercent, so the split always sums to exactly
 * totalVus even when step 1 itself is explicitly set below 100 (an edge case
 * where redistributing proportionally beats leaving VUs silently idle).
 * Collapses to a single 'default'-exec journey covering all steps whenever
 * there's only one behavioral group — the byte-for-byte backward-compat case.
 */
export const computeJourneys = (steps: FlowStep[], totalVus: number): Journey[] => {
  const percents = effectivePercents(steps);
  const firstPercent = percents[0] ?? 100;

  const runs: Array<{ percent: number; stepCount: number }> = [];
  percents.forEach((p, i) => {
    const last = runs[runs.length - 1];
    if (last && last.percent === p) last.stepCount = i + 1;
    else runs.push({ percent: p, stepCount: i + 1 });
  });

  if (runs.length === 1) {
    return [{ stepCount: steps.length, vus: totalVus, execName: 'default' }];
  }

  const shares = runs.map((run, i) => {
    const nextPercent = runs[i + 1]?.percent ?? 0;
    return (run.percent - nextPercent) / firstPercent;
  });

  const raw = shares.map(share => share * totalVus);
  const floors = raw.map(Math.floor);
  let remainder = totalVus - floors.reduce((a, b) => a + b, 0);
  // Give the leftover VUs to the runs with the largest fractional remainder first.
  const byFracDesc = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  const vusPerRun = [...floors];
  for (let k = 0; k < byFracDesc.length && remainder > 0; k++, remainder--) {
    vusPerRun[byFracDesc[k]!.i]!++;
  }

  const journeys = runs
    .map((run, i) => ({ stepCount: run.stepCount, vus: vusPerRun[i]!, execName: `journey${i + 1}` }))
    .filter(j => j.vus > 0); // totalVus too small to give every tier a VU — drop the empty ones

  if (journeys.length === 1) {
    return [{ stepCount: journeys[0]!.stepCount, vus: totalVus, execName: 'default' }];
  }
  return journeys;
};

/**
 * Validates effective (post-inheritance) percents: each must be 0-100, and
 * non-increasing down the step list (a funnel can only shrink). Returns a
 * descriptive error on the first violation, else null.
 */
export const validateStepPercents = (steps: FlowStep[]): string | null => {
  const percents = effectivePercents(steps);
  for (let i = 0; i < percents.length; i++) {
    const p = percents[i]!;
    if (p < 0 || p > 100) {
      return `Step ${i + 1}'s user percent (${p}) must be between 0 and 100`;
    }
    if (i > 0 && p > percents[i - 1]!) {
      return `Step ${i + 1}'s user percent (${p}) cannot exceed step ${i}'s (${percents[i - 1]})`;
    }
  }
  return null;
};
