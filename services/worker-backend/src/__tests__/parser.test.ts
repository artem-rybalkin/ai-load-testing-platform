import { describe, it, expect } from 'vitest';
import { parseK6Output, aggregateWindow, parseK6Errors, parseK6GroupMetrics, parseK6JsonOutput, LIVE_WINDOW_SEC } from '../parser';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const makeK6Output = ({
  total = 73,
  rps = 4.123,
  failPct = 56.16,
  avg = '231ms',
  p90 = '400ms',
  p95 = '450ms',
  p99 = '480ms',
} = {}): string => `
          /\\      Grafana   /‾‾/
     /\\  /  \\     |   (‾) ‾‾|   |‾‾|
    /  \\/    \\    |   |___) |   |  |
   /          \\   |        |   |  |
  / __________ \\  |________|   |__|

     execution: local
        script: /tmp/test.js

scenarios: (100.00%) 1 scenario, 10 max VUs, 1m0s max duration
default: 10 looping VUs for 30s (gracefulStop: 30s)

✓ status is 200

█ setup

http_reqs...................: ${total}     ${rps}/s
http_req_failed................: ${failPct}% ${Math.round(total * failPct / 100)} out of ${total}
http_req_duration..........: avg=${avg} min=100ms med=200ms max=500ms p(90)=${p90} p(95)=${p95} p(99)=${p99}
http_req_blocked...........: avg=1ms
http_req_connecting........: avg=0s
`;

const makeK6OutputWithUnit = (unit: string, avgVal: number, p95Val: number, p99Val: number): string => `
http_reqs...................: 10     2/s
http_req_failed................: 0.00% 0 out of 10
http_req_duration..........: avg=${avgVal}${unit} min=100${unit} med=200${unit} max=500${unit} p(90)=350${unit} p(95)=${p95Val}${unit} p(99)=${p99Val}${unit}
`;

const makeJsonPoint = (metric: string, value: number): string =>
  JSON.stringify({ type: 'Point', metric, data: { value, time: new Date().toISOString() } });

const makeMetricLine = (metric: string): string =>
  JSON.stringify({ type: 'Metric', metric, data: { name: metric, type: 'trend' } });

// ─── parseK6Output ────────────────────────────────────────────────────────────

describe('parseK6Output', () => {
  it('parses full k6 output correctly', () => {
    const result = parseK6Output(makeK6Output());

    expect(result.type).toBe('backend');
    expect(result.requestsTotal).toBe(73);
    expect(result.requestsFailed).toBe(41);     // round(73 * 56.16 / 100)
    expect(result.rps).toBeCloseTo(4.123, 2);
    expect(result.avgResponseTime).toBe(231);
    expect(result.p95ResponseTime).toBe(450);
    expect(result.p99ResponseTime).toBe(480);
  });

  it('converts microseconds (µs) to milliseconds', () => {
    const result = parseK6Output(makeK6OutputWithUnit('µs', 500000, 750000, 780000));

    expect(result.avgResponseTime).toBe(500);
    expect(result.p95ResponseTime).toBe(750);
    expect(result.p99ResponseTime).toBe(780);
  });

  it('converts seconds (s) to milliseconds', () => {
    const result = parseK6Output(makeK6OutputWithUnit('s', 0.5, 0.75, 0.78));

    expect(result.avgResponseTime).toBe(500);
    expect(result.p95ResponseTime).toBe(750);
    expect(result.p99ResponseTime).toBe(780);
  });

  it('parses output with threshold violations (non-zero exit) the same way', () => {
    const outputWithViolation = makeK6Output({ total: 100, failPct: 15 }) +
      '\nERRO[0031] thresholds on metrics \'http_req_failed\' were not met';

    const result = parseK6Output(outputWithViolation);

    expect(result.requestsTotal).toBe(100);
    expect(result.requestsFailed).toBe(15);
  });

  it('returns zeroes for empty output without crashing', () => {
    const result = parseK6Output('');

    expect(result.type).toBe('backend');
    expect(result.requestsTotal).toBe(0);
    expect(result.requestsFailed).toBe(0);
    expect(result.avgResponseTime).toBe(0);
    expect(result.p95ResponseTime).toBe(0);
    expect(result.p99ResponseTime).toBe(0);
    expect(result.rps).toBe(0);
  });

  it('handles p95 and p99 equal to avg', () => {
    const result = parseK6Output(makeK6Output({ avg: '200ms', p95: '200ms', p99: '200ms' }));

    expect(result.avgResponseTime).toBe(200);
    expect(result.p95ResponseTime).toBe(200);
    expect(result.p99ResponseTime).toBe(200);
  });

  it('handles zero failed requests', () => {
    const result = parseK6Output(makeK6Output({ total: 50, failPct: 0 }));

    expect(result.requestsFailed).toBe(0);
  });

  it('returns zeroes when output has no http_ metrics (e.g. WebSocket-only script)', () => {
    const noHttpOutput = `
      execution: local
         script: /tmp/ws-test.js
      vus_max.............: 10
      iteration_duration..: avg=1.2s
    `;

    const result = parseK6Output(noHttpOutput);

    expect(result.type).toBe('backend');
    expect(result.requestsTotal).toBe(0);
    expect(result.requestsFailed).toBe(0);
    expect(result.avgResponseTime).toBe(0);
    expect(result.p95ResponseTime).toBe(0);
    expect(result.rps).toBe(0);
  });

  it('returns zero requestsFailed when http_req_failed line is missing', () => {
    const noFailLine = `
http_reqs...................: 100     5/s
http_req_duration..........: avg=200ms min=100ms med=180ms max=400ms p(90)=300ms p(95)=350ms p(99)=390ms
    `;

    const result = parseK6Output(noFailLine);

    expect(result.requestsTotal).toBe(100);
    expect(result.requestsFailed).toBe(0);
  });

  it('handles large request counts without overflow', () => {
    const result = parseK6Output(makeK6Output({ total: 1000000, rps: 3333.33, failPct: 0.01 }));

    expect(result.requestsTotal).toBe(1000000);
    expect(result.requestsFailed).toBe(Math.round(1000000 * 0.01 / 100));
    expect(result.rps).toBeCloseTo(3333.33, 1);
  });

  it('returns zero percentiles when the http_req_duration line has no avg=/p()= values', () => {
    const malformed = `
http_reqs...................: 42     1.5/s
http_req_failed................: 0.00% 0 out of 42
http_req_duration..........: min=100ms max=500ms
    `;

    const result = parseK6Output(malformed);

    expect(result.requestsTotal).toBe(42);
    expect(result.avgResponseTime).toBe(0);
    expect(result.p50ResponseTime).toBe(0);
    expect(result.p95ResponseTime).toBe(0);
    expect(result.p99ResponseTime).toBe(0);
  });

  it('returns zero p50 when neither p(50)= nor med= is present', () => {
    const noMed = `
http_reqs...................: 10     1/s
http_req_failed................: 0.00% 0 out of 10
http_req_duration..........: avg=200ms min=100ms max=500ms p(90)=350ms p(95)=400ms p(99)=450ms
    `;

    const result = parseK6Output(noMed);

    expect(result.avgResponseTime).toBe(200);
    expect(result.p50ResponseTime).toBe(0);
    expect(result.p95ResponseTime).toBe(400);
    expect(result.p99ResponseTime).toBe(450);
  });

  it('falls back to med= for p50 when p(50)= is absent', () => {
    const withMed = `
http_reqs...................: 10     1/s
http_req_failed................: 0.00% 0 out of 10
http_req_duration..........: avg=200ms min=100ms med=180ms max=500ms p(90)=350ms p(95)=400ms p(99)=450ms
    `;

    const result = parseK6Output(withMed);

    expect(result.p50ResponseTime).toBe(180);
  });

  it('does not crash and returns zero rps/requestsTotal when http_reqs line is entirely missing', () => {
    const noReqsLine = `
http_req_duration..........: avg=200ms min=100ms med=180ms max=500ms p(90)=350ms p(95)=400ms p(99)=450ms
    `;

    const result = parseK6Output(noReqsLine);

    expect(result.requestsTotal).toBe(0);
    expect(result.rps).toBe(0);
    // avg/percentiles still parsed from http_req_duration line even with no http_reqs
    expect(result.avgResponseTime).toBe(200);
  });

  it('does not produce NaN when given garbage/non-numeric input', () => {
    const garbage = 'completely unrelated text with no metrics whatsoever\n!!! @@@ ###';

    const result = parseK6Output(garbage);

    expect(Number.isNaN(result.requestsTotal)).toBe(false);
    expect(Number.isNaN(result.avgResponseTime)).toBe(false);
    expect(Number.isNaN(result.p95ResponseTime)).toBe(false);
    expect(Number.isNaN(result.rps)).toBe(false);
    expect(result.requestsTotal).toBe(0);
    expect(result.avgResponseTime).toBe(0);
  });
});

// ─── aggregateWindow ──────────────────────────────────────────────────────────

describe('aggregateWindow', () => {
  it('returns null for empty array', () => {
    expect(aggregateWindow([])).toBeNull();
  });

  it('returns null when only Metric lines (no Point data)', () => {
    const lines = [
      makeMetricLine('http_req_duration'),
      makeMetricLine('vus'),
    ];
    expect(aggregateWindow(lines)).toBeNull();
  });

  it('aggregates vus, response time and error rate correctly', () => {
    const lines = [
      makeJsonPoint('vus', 5),
      makeJsonPoint('vus', 10),
      makeJsonPoint('http_req_duration', 200),
      makeJsonPoint('http_req_duration', 300),
      makeJsonPoint('http_req_failed', 0),
      makeJsonPoint('http_req_failed', 1),
      makeJsonPoint('http_reqs', 1),
      makeJsonPoint('http_reqs', 1),
    ];

    const result = aggregateWindow(lines);

    expect(result).not.toBeNull();
    expect(result!.vus).toBe(10);                    // max(5, 10)
    expect(result!.avgResponseTime).toBe(250);        // avg(200, 300)
    expect(result!.errorRate).toBeCloseTo(50, 1);     // avg(0, 1) * 100
    expect(result!.rps).toBeCloseTo(2 / 2, 2);        // 2 reqs / 2s window
  });

  it('skips malformed JSON lines and processes the rest', () => {
    const lines = [
      'not valid json',
      '{broken',
      makeJsonPoint('vus', 8),
      makeJsonPoint('http_req_duration', 150),
    ];

    const result = aggregateWindow(lines);

    expect(result).not.toBeNull();
    expect(result!.vus).toBe(8);
    expect(result!.avgResponseTime).toBe(150);
  });

  it('calculates rps as request count divided by 2-second window', () => {
    const lines = [
      makeJsonPoint('vus', 5),
      ...Array.from({ length: 20 }, () => makeJsonPoint('http_reqs', 1)),
    ];

    const result = aggregateWindow(lines);

    expect(result).not.toBeNull();
    expect(result!.rps).toBeCloseTo(20 / 2, 2);
  });

  it('returns zero errorRate when no http_req_failed points', () => {
    const lines = [
      makeJsonPoint('vus', 5),
      makeJsonPoint('http_req_duration', 100),
    ];

    const result = aggregateWindow(lines);

    expect(result!.errorRate).toBe(0);
  });

  const makeStatusPoint = (status: string): string =>
    JSON.stringify({ type: 'Point', metric: 'http_reqs', data: { value: 1, time: new Date().toISOString(), tags: { status } } });

  it('computes clientErrorRate/serverErrorRate from http_reqs status tags', () => {
    const lines = [
      makeJsonPoint('vus', 1),
      makeStatusPoint('200'),
      makeStatusPoint('200'),
      makeStatusPoint('404'),
      makeStatusPoint('500'),
    ];

    const result = aggregateWindow(lines);

    expect(result).not.toBeNull();
    expect(result!.clientErrorRate).toBeCloseTo(25, 1); // 1 of 4 requests was 4xx
    expect(result!.serverErrorRate).toBeCloseTo(25, 1); // 1 of 4 requests was 5xx
  });

  it('returns zero clientErrorRate/serverErrorRate when all requests succeed', () => {
    const lines = [makeJsonPoint('vus', 1), makeStatusPoint('200'), makeStatusPoint('201')];

    const result = aggregateWindow(lines);

    expect(result!.clientErrorRate).toBe(0);
    expect(result!.serverErrorRate).toBe(0);
  });

  it('returns zero clientErrorRate/serverErrorRate when no http_reqs points at all', () => {
    const lines = [makeJsonPoint('vus', 5), makeJsonPoint('http_req_duration', 100)];

    const result = aggregateWindow(lines);

    expect(result!.clientErrorRate).toBe(0);
    expect(result!.serverErrorRate).toBe(0);
  });

  it('returns zero rps when no http_reqs points', () => {
    const lines = [
      makeJsonPoint('vus', 5),
      makeJsonPoint('http_req_duration', 200),
    ];

    const result = aggregateWindow(lines);

    expect(result!.rps).toBe(0);
    expect(result!.errorRate).toBe(0);
  });

  it('handles only vus points (no duration) without returning null', () => {
    const lines = [makeJsonPoint('vus', 15)];

    const result = aggregateWindow(lines);

    expect(result).not.toBeNull();
    expect(result!.vus).toBe(15);
    expect(result!.avgResponseTime).toBe(0);
  });

  // ─── windowSec parameter (admin-configurable live metrics window) ──────────

  describe('windowSec parameter', () => {
    // aggregateWindow returns null unless there's at least one duration or vus
    // point — http_reqs alone isn't enough, so every fixture includes one vus point.
    const reqLines = (n: number): string[] => [
      makeJsonPoint('vus', 1),
      ...Array.from({ length: n }, () => makeJsonPoint('http_reqs', 1)),
    ];

    it('defaults to LIVE_WINDOW_SEC (2) when no windowSec argument is given', () => {
      const result = aggregateWindow(reqLines(10));
      expect(result!.rps).toBeCloseTo(10 / LIVE_WINDOW_SEC, 2);
    });

    it('divides by the given windowSec instead of the default', () => {
      const result = aggregateWindow(reqLines(30), 30);
      expect(result!.rps).toBeCloseTo(1, 2); // 30 reqs / 30s
    });

    it('supports the 10s bucket', () => {
      const result = aggregateWindow(reqLines(25), 10);
      expect(result!.rps).toBeCloseTo(2.5, 2);
    });

    it('supports the 60s (1min) bucket', () => {
      const result = aggregateWindow(reqLines(120), 60);
      expect(result!.rps).toBeCloseTo(2, 2);
    });

    it('applies windowSec to per-step rps as well as the aggregate rps', () => {
      const lines = [
        ...Array.from({ length: 6 }, () => makeGroupJsonPoint('http_reqs', 1, 'Login')),
        makeGroupJsonPoint('http_req_duration', 100, 'Login'),
      ];
      const result = aggregateWindow(lines, 30);
      const login = result!.stepMetrics!.find(s => s.name === 'Login');
      expect(login!.rps).toBeCloseTo(6 / 30, 2);
    });
  });

  // ─── per-step stepMetrics branch ────────────────────────────────────────────

  const makeGroupJsonPoint = (metric: string, value: number, group: string): string =>
    JSON.stringify({ type: 'Point', metric, data: { value, time: new Date().toISOString(), tags: { group: `::${group}` } } });

  it('computes stepMetrics for multiple groups with avgResponseTime, rps and errorRate', () => {
    const lines = [
      // Login: 2 durations, 2 reqs, 0 failures
      makeGroupJsonPoint('http_req_duration', 100, 'Login'),
      makeGroupJsonPoint('http_req_duration', 200, 'Login'),
      makeGroupJsonPoint('http_reqs', 1, 'Login'),
      makeGroupJsonPoint('http_reqs', 1, 'Login'),
      makeGroupJsonPoint('http_req_failed', 0, 'Login'),
      makeGroupJsonPoint('http_req_failed', 0, 'Login'),
      // Checkout: 2 durations, 4 reqs, 1 failure (avg failed value = 0.5)
      makeGroupJsonPoint('http_req_duration', 300, 'Checkout'),
      makeGroupJsonPoint('http_req_duration', 500, 'Checkout'),
      makeGroupJsonPoint('http_reqs', 1, 'Checkout'),
      makeGroupJsonPoint('http_reqs', 1, 'Checkout'),
      makeGroupJsonPoint('http_reqs', 1, 'Checkout'),
      makeGroupJsonPoint('http_reqs', 1, 'Checkout'),
      makeGroupJsonPoint('http_req_failed', 1, 'Checkout'),
      makeGroupJsonPoint('http_req_failed', 0, 'Checkout'),
    ];

    const result = aggregateWindow(lines);

    expect(result).not.toBeNull();
    expect(result!.stepMetrics).toBeDefined();
    const byName = Object.fromEntries(result!.stepMetrics!.map(s => [s.name, s]));

    expect(byName['Login']).toBeDefined();
    expect(byName['Login'].avgResponseTime).toBe(150); // avg(100, 200)
    expect(byName['Login'].rps).toBeCloseTo(2 / LIVE_WINDOW_SEC, 2);
    expect(byName['Login'].errorRate).toBe(0);

    expect(byName['Checkout']).toBeDefined();
    expect(byName['Checkout'].avgResponseTime).toBe(400); // avg(300, 500)
    expect(byName['Checkout'].rps).toBeCloseTo(4 / LIVE_WINDOW_SEC, 2);
    expect(byName['Checkout'].errorRate).toBeCloseTo(50, 1); // avg(1, 0) * 100
  });

  it('falls back to duration count for rps and 0 errorRate when http_req_failed points are absent for a group', () => {
    const lines = [
      makeGroupJsonPoint('http_req_duration', 100, 'Login'),
      makeGroupJsonPoint('http_req_duration', 200, 'Login'),
    ];

    const result = aggregateWindow(lines);

    expect(result!.stepMetrics).toEqual([
      { name: 'Login', avgResponseTime: 150, rps: parseFloat((2 / LIVE_WINDOW_SEC).toFixed(2)), errorRate: 0 },
    ]);
  });

  it('omits stepMetrics entirely when no group-tagged points exist', () => {
    const lines = [
      makeJsonPoint('vus', 5),
      makeJsonPoint('http_req_duration', 100),
      makeJsonPoint('http_reqs', 1),
    ];

    const result = aggregateWindow(lines);

    expect(result!.stepMetrics).toBeUndefined();
  });
});

// ─── parseK6Errors ───────────────────────────────────────────────────────────

describe('parseK6Errors', () => {
  const makeHttpReqPoint = (status: string): string =>
    JSON.stringify({ type: 'Point', metric: 'http_reqs', data: { value: 1, time: new Date().toISOString(), tags: { status } } });

  const makeFailedPoint = (errorCode: string): string =>
    JSON.stringify({ type: 'Point', metric: 'http_req_failed', data: { value: 1, time: new Date().toISOString(), tags: { error_code: errorCode } } });

  it('counts requests by status code', () => {
    const json = [
      makeHttpReqPoint('200'),
      makeHttpReqPoint('200'),
      makeHttpReqPoint('500'),
    ].join('\n');

    const { statusCodes, errorBreakdown } = parseK6Errors(json);

    expect(statusCodes['200']).toBe(2);
    expect(statusCodes['500']).toBe(1);
    expect(errorBreakdown.success).toBe(2);
    expect(errorBreakdown.serverError).toBe(1);
  });

  it('categorizes timeout errors from error_code', () => {
    const json = [makeFailedPoint('1020'), makeFailedPoint('1210')].join('\n');
    const { errorBreakdown } = parseK6Errors(json);
    expect(errorBreakdown.timeout).toBe(2);
  });

  it('categorizes network errors from error_code', () => {
    const json = [makeFailedPoint('1010'), makeFailedPoint('1050')].join('\n');
    const { errorBreakdown } = parseK6Errors(json);
    expect(errorBreakdown.networkError).toBe(2);
  });

  it('returns empty breakdown for empty input', () => {
    const { statusCodes, errorBreakdown } = parseK6Errors('');
    expect(statusCodes).toEqual({});
    expect(errorBreakdown.success).toBe(0);
  });

  it('skips non-http_reqs metrics and malformed lines', () => {
    const json = [
      makeJsonPoint('vus', 5),
      'not json',
      makeHttpReqPoint('404'),
    ].join('\n');

    const { statusCodes } = parseK6Errors(json);

    expect(Object.keys(statusCodes)).toEqual(['404']);
  });

  it('ignores points without status tag', () => {
    const noStatus = JSON.stringify({ type: 'Point', metric: 'http_reqs', data: { value: 1, tags: {} } });
    const { statusCodes } = parseK6Errors(noStatus);
    expect(statusCodes).toEqual({});
  });

  it('counts many different status codes and categorizes correctly', () => {
    const lines = [
      makeHttpReqPoint('200'), makeHttpReqPoint('200'), makeHttpReqPoint('200'),
      makeHttpReqPoint('201'),
      makeHttpReqPoint('400'), makeHttpReqPoint('400'),
      makeHttpReqPoint('500'),
      makeHttpReqPoint('503'),
    ].join('\n');

    const { statusCodes, errorBreakdown } = parseK6Errors(lines);

    expect(statusCodes['200']).toBe(3);
    expect(statusCodes['201']).toBe(1);
    expect(statusCodes['400']).toBe(2);
    expect(statusCodes['500']).toBe(1);
    expect(statusCodes['503']).toBe(1);
    expect(Object.keys(statusCodes)).toHaveLength(5);
    expect(errorBreakdown.success).toBe(4);
    expect(errorBreakdown.clientError).toBe(2);
    expect(errorBreakdown.serverError).toBe(2);
  });

  it('categorizes 3xx redirects as success, not as an error or omitted', () => {
    const json = [
      makeHttpReqPoint('200'),
      makeHttpReqPoint('301'),
      makeHttpReqPoint('302'),
    ].join('\n');

    const { statusCodes, errorBreakdown } = parseK6Errors(json);

    expect(statusCodes['301']).toBe(1);
    expect(statusCodes['302']).toBe(1);
    expect(errorBreakdown.success).toBe(3);
    expect(errorBreakdown.clientError).toBe(0);
    expect(errorBreakdown.serverError).toBe(0);
  });

  it('categorizes unknown error_code with no status tag as networkError (catch-all)', () => {
    // error_code present but doesn't match 1010-1019, 1020-1029, 1050, or 1210 —
    // and no status tag — lands in the catch-all networkError branch (line 86 of parser.ts)
    const point = JSON.stringify({
      type: 'Point',
      metric: 'http_req_failed',
      data: { value: 1, time: new Date().toISOString(), tags: { error_code: '9999' } },
    });
    const { errorBreakdown } = parseK6Errors(point);
    expect(errorBreakdown.networkError).toBe(1);
    expect(errorBreakdown.timeout).toBe(0);
  });
});

// ─── parseK6GroupMetrics ──────────────────────────────────────────────────────

describe('parseK6GroupMetrics', () => {
  /** k6 emits group tags as '::GroupName'; the function strips the leading '::'. */
  const makeGroupPoint = (metric: string, value: number, group: string): string =>
    JSON.stringify({
      type: 'Point',
      metric,
      data: { value, time: new Date().toISOString(), tags: { group: `::${group}` } },
    });

  /** Root-group point — k6 tags for the top-level scope as just '::'. */
  const makeRootPoint = (metric: string, value: number): string =>
    JSON.stringify({
      type: 'Point',
      metric,
      data: { value, time: new Date().toISOString(), tags: { group: '::' } },
    });

  it('returns empty array for empty input', () => {
    expect(parseK6GroupMetrics('')).toEqual([]);
  });

  it('returns empty array when no group-tagged points exist', () => {
    const lines = [
      makeJsonPoint('http_req_duration', 200),
      makeJsonPoint('http_reqs', 1),
    ].join('\n');
    expect(parseK6GroupMetrics(lines)).toEqual([]);
  });

  it('returns one StepMetrics for a single group', () => {
    const lines = [
      makeGroupPoint('http_req_duration', 150, 'Login'),
      makeGroupPoint('http_req_duration', 250, 'Login'),
      makeGroupPoint('http_reqs', 1, 'Login'),
      makeGroupPoint('http_reqs', 1, 'Login'),
    ].join('\n');

    const result = parseK6GroupMetrics(lines);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Login');
    expect(result[0].avgResponseTime).toBe(200); // avg(150, 250)
    expect(result[0].requestsTotal).toBe(2);
    expect(result[0].requestsFailed).toBe(0);
  });

  it('strips the leading :: from the group name', () => {
    const lines = [makeGroupPoint('http_req_duration', 120, 'Step 1: POST /login')].join('\n');
    const result = parseK6GroupMetrics(lines);
    expect(result[0].name).toBe('Step 1: POST /login');
  });

  it('skips the root :: group (top-level k6 scope)', () => {
    const lines = [
      makeRootPoint('http_req_duration', 100),
      makeGroupPoint('http_req_duration', 200, 'Login'),
    ].join('\n');

    const result = parseK6GroupMetrics(lines);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Login');
  });

  it('returns StepMetrics for each distinct group', () => {
    const lines = [
      makeGroupPoint('http_req_duration', 100, 'Login'),
      makeGroupPoint('http_req_duration', 300, 'Profile'),
      makeGroupPoint('http_reqs', 1, 'Login'),
      makeGroupPoint('http_reqs', 1, 'Profile'),
    ].join('\n');

    const result = parseK6GroupMetrics(lines);

    expect(result).toHaveLength(2);
    const names = result.map(r => r.name);
    expect(names).toContain('Login');
    expect(names).toContain('Profile');
  });

  it('calculates p95 from the sorted duration distribution', () => {
    // 20 durations: 19 × 100 ms, 1 × 900 ms
    // sorted[19] = 900 → p95idx = floor(20 * 0.95) = 19
    const durations = [...Array(19).fill(100), 900];
    const lines = durations.map(d => makeGroupPoint('http_req_duration', d, 'Checkout')).join('\n');

    const result = parseK6GroupMetrics(lines);

    expect(result[0].p95ResponseTime).toBe(900);
    expect(result[0].avgResponseTime).toBe(Math.round((19 * 100 + 900) / 20));
  });

  it('calculates requestsFailed from averaged http_req_failed values', () => {
    // 4 requests, 2 failed (values 1,1,0,0) → avg=0.5 → round(0.5 * 4) = 2
    const lines = [
      makeGroupPoint('http_req_duration', 100, 'Login'),
      makeGroupPoint('http_req_duration', 200, 'Login'),
      makeGroupPoint('http_req_duration', 150, 'Login'),
      makeGroupPoint('http_req_duration', 300, 'Login'),
      makeGroupPoint('http_reqs', 1, 'Login'),
      makeGroupPoint('http_reqs', 1, 'Login'),
      makeGroupPoint('http_reqs', 1, 'Login'),
      makeGroupPoint('http_reqs', 1, 'Login'),
      makeGroupPoint('http_req_failed', 1, 'Login'),
      makeGroupPoint('http_req_failed', 1, 'Login'),
      makeGroupPoint('http_req_failed', 0, 'Login'),
      makeGroupPoint('http_req_failed', 0, 'Login'),
    ].join('\n');

    const result = parseK6GroupMetrics(lines);

    expect(result[0].requestsTotal).toBe(4);
    expect(result[0].requestsFailed).toBe(2);
  });

  it('uses durations.length as requestsTotal fallback when no http_reqs points', () => {
    const lines = [
      makeGroupPoint('http_req_duration', 100, 'Login'),
      makeGroupPoint('http_req_duration', 200, 'Login'),
      makeGroupPoint('http_req_duration', 300, 'Login'),
    ].join('\n');

    const result = parseK6GroupMetrics(lines);

    expect(result[0].requestsTotal).toBe(3);
  });

  it('returns zero requestsFailed when no http_req_failed points', () => {
    const lines = [
      makeGroupPoint('http_req_duration', 200, 'Login'),
      makeGroupPoint('http_reqs', 1, 'Login'),
    ].join('\n');

    expect(parseK6GroupMetrics(lines)[0].requestsFailed).toBe(0);
  });

  it('skips malformed JSON lines and continues processing', () => {
    const lines = [
      'not json at all',
      '{broken',
      makeGroupPoint('http_req_duration', 200, 'Login'),
    ].join('\n');

    const result = parseK6GroupMetrics(lines);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Login');
  });

  it('handles a single-item duration array (p95 = that single value)', () => {
    const lines = [makeGroupPoint('http_req_duration', 999, 'Checkout')].join('\n');
    const result = parseK6GroupMetrics(lines);
    expect(result[0].avgResponseTime).toBe(999);
    expect(result[0].p95ResponseTime).toBe(999);
  });
});

// ─── performance ───────────────────────────────────────────────────────────
//
// Regression guards (not strict benchmarks): synthetic k6 JSON-lines output
// spanning multiple step groups, sized at 1,000 and 10,000 lines, to ensure
// the single-pass parsers and live aggregation stay well within budget even
// for long/high-VU runs that emit large numbers of points.

describe('performance', () => {
  const STEP_GROUPS = ['Login', 'Browse', 'AddToCart', 'Checkout', 'Logout', 'Search', 'Profile', 'Wishlist'];

  /** Generates `count` k6 JSON-lines, cycling through http_reqs/http_req_duration/http_req_failed
   *  metrics and distributing points across STEP_GROUPS. */
  const makeSyntheticK6Lines = (count: number): string[] => {
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      const group = STEP_GROUPS[i % STEP_GROUPS.length];
      const time = new Date().toISOString();
      switch (i % 3) {
        case 0:
          lines.push(JSON.stringify({
            type: 'Point', metric: 'http_reqs',
            data: { value: 1, time, tags: { group: `::${group}`, status: i % 20 === 0 ? '500' : '200' } },
          }));
          break;
        case 1:
          lines.push(JSON.stringify({
            type: 'Point', metric: 'http_req_duration',
            data: { value: 50 + (i % 450), time, tags: { group: `::${group}` } },
          }));
          break;
        default:
          lines.push(JSON.stringify({
            type: 'Point', metric: 'http_req_failed',
            data: { value: i % 25 === 0 ? 1 : 0, time, tags: { group: `::${group}`, error_code: i % 25 === 0 ? '1020' : '' } },
          }));
      }
    }
    return lines;
  };

  it('parseK6JsonOutput handles 1,000 lines within budget', () => {
    const lines = makeSyntheticK6Lines(1000);
    const content = lines.join('\n');

    const start = performance.now();
    const result = parseK6JsonOutput(content);
    const elapsed = performance.now() - start;

    expect(result.stepMetrics.length).toBe(STEP_GROUPS.length);
    expect(elapsed).toBeLessThan(100);
  });

  it('parseK6JsonOutput handles 10,000 lines within budget', () => {
    const lines = makeSyntheticK6Lines(10000);
    const content = lines.join('\n');

    const start = performance.now();
    const result = parseK6JsonOutput(content);
    const elapsed = performance.now() - start;

    expect(result.stepMetrics.length).toBe(STEP_GROUPS.length);
    expect(Object.keys(result.statusCodes).length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
  });

  it('parseK6Errors handles 10,000 lines within budget', () => {
    const lines = makeSyntheticK6Lines(10000);
    const content = lines.join('\n');

    const start = performance.now();
    const { statusCodes, errorBreakdown } = parseK6Errors(content);
    const elapsed = performance.now() - start;

    expect(Object.keys(statusCodes).length).toBeGreaterThan(0);
    expect(errorBreakdown.success + errorBreakdown.serverError).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
  });

  it('parseK6GroupMetrics handles 10,000 lines within budget', () => {
    const lines = makeSyntheticK6Lines(10000);
    const content = lines.join('\n');

    const start = performance.now();
    const stepMetrics = parseK6GroupMetrics(content);
    const elapsed = performance.now() - start;

    expect(stepMetrics).toHaveLength(STEP_GROUPS.length);
    for (const step of stepMetrics) {
      expect(step.avgResponseTime).toBeGreaterThan(0);
      expect(Number.isNaN(step.p95ResponseTime)).toBe(false);
    }
    // Budget is intentionally generous (not a tight perf benchmark) — this only
    // needs to catch an accidental O(n²)-type regression, not measure exact
    // timing. A tight 500ms budget flaked on shared CI runners under
    // --coverage instrumentation (observed ~740ms there for legitimately
    // correct, unchanged code).
    expect(elapsed).toBeLessThan(2000);
  });

  it('aggregateWindow handles a 2,000-line live window (5-10 groups) within budget', () => {
    const lines = makeSyntheticK6Lines(2000);

    const start = performance.now();
    const result = aggregateWindow(lines);
    const elapsed = performance.now() - start;

    expect(result).not.toBeNull();
    expect(result!.stepMetrics?.length).toBe(STEP_GROUPS.length);
    expect(elapsed).toBeLessThan(500);
  });

  it('parseK6Output (text summary) stays fast regardless of test size', () => {
    // k6 CLI summary output is bounded/fixed-size regardless of request volume,
    // so this is mainly a sanity check that the regex-based parser is cheap.
    const output = makeK6Output({ total: 5_000_000, rps: 99999.99, failPct: 2.5 });

    const start = performance.now();
    const result = parseK6Output(output);
    const elapsed = performance.now() - start;

    expect(result.requestsTotal).toBe(5_000_000);
    expect(elapsed).toBeLessThan(20);
  });
});
