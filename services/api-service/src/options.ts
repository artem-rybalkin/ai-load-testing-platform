import { BackendTestOptions, deriveMultiPercentileThresholds } from '@alt/shared';

// k6's object-form threshold — lets a threshold breach abort the run early
// instead of running the full configured duration after already proving the
// point. Used only for the capacity/breakpoint profile: the goal there is
// specifically to find where the system breaks, so once a threshold is
// breached there's nothing more to learn from continuing.
interface AbortingThreshold { threshold: string; abortOnFail: true; delayAbortEval: string }
type ThresholdEntry = string | AbortingThreshold;

// Multi-percentile http_req_duration thresholds instead of a single p(95)
// cliff-edge — mirrors the p50/p90/p95/p99 already computed and displayed in
// the platform's own results UI.
const durationThresholds = (p95: number): string[] => {
  const { p90, p99 } = deriveMultiPercentileThresholds(p95);
  return [`p(90)<${p90}`, `p(95)<${p95}`, `p(99)<${p99}`];
};

export const buildK6Options = (opts: BackendTestOptions): string => {
  const { vus, duration, profile = 'load', peakVus, httpOptions } = opts;
  const peak = peakVus ?? vus * 10;

  // HTTP-level k6 options derived from httpOptions
  const httpK6 = {
    ...(httpOptions?.discardResponseBodies ? { discardResponseBodies: true } : {}),
  };

  const obj = ((): { stages: { duration: string; target: number }[]; thresholds: Record<string, ThresholdEntry[]> } => {
    switch (profile) {
      case 'spike': return {
        stages: [
          { duration: '30s', target: vus  },
          { duration: '1m',  target: vus  },
          { duration: '10s', target: peak },
          { duration: '1m',  target: peak },
          { duration: '10s', target: vus  },
          { duration: '30s', target: 0    },
        ],
        thresholds: { http_req_duration: durationThresholds(2000), http_req_failed: ['rate<0.1'], checks: ['rate>0.9'] }
      };
      case 'capacity': {
        const { p90, p99 } = deriveMultiPercentileThresholds(2000);
        return {
          stages: [
            { duration: duration, target: peak },
            { duration: '30s',   target: 0    },
          ],
          // 10s delayAbortEval gives each new stage/VU-target a moment to
          // produce enough samples before the threshold is evaluated for
          // abort, so the very first slow request at a new ramp level doesn't
          // trigger a premature abort. Only p95 (the primary signal) aborts —
          // p90/p99 stay observational so a single tail outlier can't trigger
          // a premature abort on their own.
          thresholds: {
            http_req_duration: [
              `p(90)<${p90}`,
              { threshold: 'p(95)<2000', abortOnFail: true, delayAbortEval: '10s' },
              `p(99)<${p99}`,
            ],
            http_req_failed: [{ threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '10s' }],
            checks: ['rate>0.9'],
          }
        };
      }
      case 'soak': return {
        stages: [
          { duration: '1m',     target: vus },
          { duration: duration, target: vus },
          { duration: '30s',    target: 0   },
        ],
        thresholds: { http_req_duration: durationThresholds(500), http_req_failed: ['rate<0.01'], checks: ['rate>0.9'] }
      };
      default: return {
        stages: [
          { duration: '30s',    target: vus },
          { duration: duration, target: vus },
          { duration: '15s',    target: 0   },
        ],
        thresholds: { http_req_duration: durationThresholds(1000), http_req_failed: ['rate<0.01'], checks: ['rate>0.9'] }
      };
    }
  })();

  // Ensure consistent percentile output: k6 default uses "med=" for p50 and omits p99
  const summaryTrendStats = ['avg', 'min', 'med', 'max', 'p(50)', 'p(90)', 'p(95)', 'p(99)'];
  return JSON.stringify({ ...obj, ...httpK6, summaryTrendStats }, null, 2);
};

export const replaceK6Options = (script: string, newOptionsJson: string): string => {
  const keyword = 'export const options';
  const start = script.indexOf(keyword);
  if (start === -1) return script;

  const braceStart = script.indexOf('{', start);
  if (braceStart === -1) return script;

  let depth = 0;
  let i = braceStart;
  while (i < script.length) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}') {
      depth--;
      if (depth === 0) {
        const afterBrace = i + 1;
        const end = script[afterBrace] === ';' ? afterBrace + 1 : afterBrace;
        return (
          script.slice(0, start) +
          `export const options = ${newOptionsJson};` +
          script.slice(end)
        );
      }
    }
    i++;
  }

  return script;
};
