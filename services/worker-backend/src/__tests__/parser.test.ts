import { describe, it, expect } from 'vitest';
import { parseK6Output, aggregateWindow, parseK6StatusCodes } from '../parser';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const makeK6Output = ({
  total = 73,
  rps = 4.123,
  failPct = 56.16,
  avg = '231ms',
  p90 = '400ms',
  p95 = '450ms',
  p99 = '480ms',
} = {}) => `
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

const makeK6OutputWithUnit = (unit: string, avgVal: number, p95Val: number, p99Val: number) => `
http_reqs...................: 10     2/s
http_req_failed................: 0.00% 0 out of 10
http_req_duration..........: avg=${avgVal}${unit} min=100${unit} med=200${unit} max=500${unit} p(90)=350${unit} p(95)=${p95Val}${unit} p(99)=${p99Val}${unit}
`;

const makeJsonPoint = (metric: string, value: number) =>
  JSON.stringify({ type: 'Point', metric, data: { value, time: new Date().toISOString() } });

const makeMetricLine = (metric: string) =>
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
    expect(result!.rps).toBeCloseTo(2 / 5, 2);        // 2 reqs / 5s window
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

  it('calculates rps as request count divided by 5-second window', () => {
    const lines = [
      makeJsonPoint('vus', 5),
      ...Array.from({ length: 20 }, () => makeJsonPoint('http_reqs', 1)),
    ];

    const result = aggregateWindow(lines);

    expect(result).not.toBeNull();
    expect(result!.rps).toBeCloseTo(20 / 5, 2);
  });

  it('returns zero errorRate when no http_req_failed points', () => {
    const lines = [
      makeJsonPoint('vus', 5),
      makeJsonPoint('http_req_duration', 100),
    ];

    const result = aggregateWindow(lines);

    expect(result!.errorRate).toBe(0);
  });
});

// ─── parseK6StatusCodes ───────────────────────────────────────────────────────

describe('parseK6StatusCodes', () => {
  const makeHttpReqPoint = (status: string) =>
    JSON.stringify({ type: 'Point', metric: 'http_reqs', data: { value: 1, time: new Date().toISOString(), tags: { status } } });

  it('counts requests by status code', () => {
    const json = [
      makeHttpReqPoint('200'),
      makeHttpReqPoint('200'),
      makeHttpReqPoint('500'),
    ].join('\n');

    const result = parseK6StatusCodes(json);

    expect(result['200']).toBe(2);
    expect(result['500']).toBe(1);
  });

  it('returns empty object for empty input', () => {
    expect(parseK6StatusCodes('')).toEqual({});
  });

  it('skips non-http_reqs metrics and malformed lines', () => {
    const json = [
      makeJsonPoint('vus', 5),
      'not json',
      makeHttpReqPoint('404'),
    ].join('\n');

    const result = parseK6StatusCodes(json);

    expect(Object.keys(result)).toEqual(['404']);
  });

  it('ignores points without status tag', () => {
    const noStatus = JSON.stringify({ type: 'Point', metric: 'http_reqs', data: { value: 1, tags: {} } });
    expect(parseK6StatusCodes(noStatus)).toEqual({});
  });
});
