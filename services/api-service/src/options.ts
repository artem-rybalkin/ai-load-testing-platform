import { BackendTestOptions } from '@alt/shared';

export const buildK6Options = (opts: BackendTestOptions): string => {
  const { vus, duration, profile = 'load', peakVus, httpOptions } = opts;
  const peak = peakVus ?? vus * 10;

  // HTTP-level k6 options derived from httpOptions
  const httpK6 = {
    ...(httpOptions?.http2               ? { http2: true }                    : {}),
    ...(httpOptions?.discardResponseBodies ? { discardResponseBodies: true } : {}),
  };

  const obj = (() => {
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
        thresholds: { http_req_duration: ['p(95)<2000'], http_req_failed: ['rate<0.1'] }
      };
      case 'capacity': return {
        stages: [
          { duration: duration, target: peak },
          { duration: '30s',   target: 0    },
        ],
        thresholds: { http_req_duration: ['p(95)<2000'], http_req_failed: ['rate<0.05'] }
      };
      case 'soak': return {
        stages: [
          { duration: '1m',     target: vus },
          { duration: duration, target: vus },
          { duration: '30s',    target: 0   },
        ],
        thresholds: { http_req_duration: ['p(95)<500'], http_req_failed: ['rate<0.01'] }
      };
      default: return {
        stages: [
          { duration: '30s',    target: vus },
          { duration: duration, target: vus },
          { duration: '15s',    target: 0   },
        ],
        thresholds: { http_req_duration: ['p(95)<1000'], http_req_failed: ['rate<0.01'] }
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
