import { BackendMetrics, ErrorBreakdown, LiveMetricPoint, LiveStepMetric, StepMetrics } from '@alt/shared';

const toMs = (val: number, unit: string | undefined): number => {
  if (unit === 's')  return Math.round(val * 1000);
  if (unit === 'µs') return Math.round(val / 1000);
  return Math.round(val);
};

export const parseK6Output = (output: string): BackendMetrics => {
  const getAvg = (metric: string): number => {
    const m = output.match(new RegExp(`${metric}[^\\n]*\\bavg=([\\d.]+)(ms|s|µs)?`));
    return m ? toMs(parseFloat(m[1]), m[2]) : 0;
  };

  const getPercentile = (metric: string, p: string): number => {
    const m = output.match(new RegExp(`${metric}[^\\n]*\\bp\\(${p}\\)=([\\d.]+)(ms|s|µs)?`));
    if (m) return toMs(parseFloat(m[1]), m[2]);
    // k6 default output uses "med=" for p50 instead of "p(50)="
    if (p === '50') {
      const med = output.match(new RegExp(`${metric}[^\\n]*\\bmed=([\\d.]+)(ms|s|µs)?`));
      return med ? toMs(parseFloat(med[1]), med[2]) : 0;
    }
    return 0;
  };

  const getCount = (metric: string): number => {
    const m = output.match(new RegExp(`${metric}[^:]*:\\s*(\\d+)\\s+[\\d.]+\\/s`));
    return m ? parseInt(m[1]) : 0;
  };

  const getRate = (metric: string): number => {
    const m = output.match(new RegExp(`${metric}[^:]*:\\s*\\d+\\s+([\\d.]+)\\/s`));
    return m ? parseFloat(m[1]) : 0;
  };

  const getFailRate = (): number => {
    const m = output.match(/http_req_failed[^:]*:\s*([\d.]+)%/);
    return m ? parseFloat(m[1]) : 0;
  };

  const total = getCount('http_reqs');

  return {
    type: 'backend',
    requestsTotal: total,
    requestsFailed: Math.round(total * getFailRate() / 100),
    avgResponseTime: getAvg('http_req_duration'),
    p50ResponseTime: getPercentile('http_req_duration', '50'),
    p95ResponseTime: getPercentile('http_req_duration', '95'),
    p99ResponseTime: getPercentile('http_req_duration', '99'),
    rps: getRate('http_reqs'),
  };
};

// Single-pass parser: processes the k6 JSON output once and extracts all
// post-test data. Called by the two public wrappers below and directly from
// the worker to avoid parsing the same file twice.
const parseK6All = (jsonContent: string): {
  statusCodes: Record<string, number>;
  errorBreakdown: ErrorBreakdown;
  stepMetrics: StepMetrics[];
} => {
  const statusCodes: Record<string, number> = {};
  const breakdown: ErrorBreakdown = { success: 0, clientError: 0, serverError: 0, timeout: 0, networkError: 0 };
  const durationsByGroup: Record<string, number[]> = {};
  const countByGroup:     Record<string, number>   = {};
  const failedByGroup:    Record<string, number[]> = {};

  for (const line of jsonContent.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type !== 'Point') continue;

      const rawGroup: string = obj.data?.tags?.group ?? '';
      const groupName = rawGroup && rawGroup !== '::' ? rawGroup.replace(/^::/, '') : null;

      if (obj.metric === 'http_reqs') {
        const status: string = obj.data?.tags?.status ?? '';
        if (status) {
          statusCodes[status] = (statusCodes[status] ?? 0) + 1;
          const code = parseInt(status, 10);
          // 3xx redirects are normal responses, not errors — count as success
          if (code >= 200 && code < 400) breakdown.success++;
          else if (code >= 400 && code < 500) breakdown.clientError++;
          else if (code >= 500) breakdown.serverError++;
        }
        if (groupName) countByGroup[groupName] = (countByGroup[groupName] ?? 0) + 1;
      }

      if (obj.metric === 'http_req_duration' && groupName) {
        (durationsByGroup[groupName] ??= []).push(obj.data.value);
      }

      if (obj.metric === 'http_req_failed') {
        if (obj.data?.value === 1) {
          const errorCode: string = obj.data?.tags?.error_code ?? '';
          const code = parseInt(errorCode, 10);
          if (code >= 1020 && code < 1030) breakdown.timeout++;
          else if (code === 1210) breakdown.timeout++;
          else if ((code >= 1010 && code < 1020) || code === 1050) breakdown.networkError++;
          else if (errorCode && !obj.data?.tags?.status) breakdown.networkError++;
        }
        if (groupName) (failedByGroup[groupName] ??= []).push(obj.data.value);
      }
    } catch { /* skip malformed */ }
  }

  const stepMetrics: StepMetrics[] = Object.entries(durationsByGroup).map(([name, durations]) => {
    const total = countByGroup[name] ?? durations.length;
    const failedVals = failedByGroup[name] ?? [];
    const failedCount = failedVals.length
      ? Math.round(failedVals.reduce((a, b) => a + b, 0) / failedVals.length * total)
      : 0;
    const sorted = [...durations].sort((a, b) => a - b);
    const p95idx = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
    return {
      name,
      avgResponseTime: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      p95ResponseTime: Math.round(sorted[p95idx] ?? 0),
      requestsTotal: total,
      requestsFailed: failedCount,
    };
  });

  return { statusCodes, errorBreakdown: breakdown, stepMetrics };
};

// Production entry-point: one call instead of two to avoid parsing the file twice.
export const parseK6JsonOutput = parseK6All;

// These remain exported so existing unit tests can call them independently.
export const parseK6Errors = (jsonContent: string): {
  statusCodes: Record<string, number>;
  errorBreakdown: ErrorBreakdown;
} => {
  const { statusCodes, errorBreakdown } = parseK6All(jsonContent);
  return { statusCodes, errorBreakdown };
};

export const parseK6GroupMetrics = (jsonContent: string): StepMetrics[] =>
  parseK6All(jsonContent).stepMetrics;

interface K6JsonPoint {
  type: string;
  metric: string;
  data: { value: number; time: string; tags?: Record<string, string> };
}

export const LIVE_WINDOW_SEC = 2;

export const aggregateWindow = (lines: string[]): Omit<LiveMetricPoint, 'timestamp'> | null => {
  const durations: number[] = [];
  const durationsByGroup: Record<string, number[]> = {};
  const countByGroup:     Record<string, number>   = {};
  const failedByGroup:    Record<string, number[]> = {};
  const vusValues: number[] = [];
  const failedValues: number[] = [];
  let requestCount = 0;

  for (const line of lines) {
    try {
      const obj: K6JsonPoint = JSON.parse(line);
      if (obj.type !== 'Point') continue;
      const rawGroup = obj.data.tags?.group ?? '';
      const groupName = rawGroup && rawGroup !== '::' ? rawGroup.replace(/^::/, '') : null;
      switch (obj.metric) {
        case 'http_req_duration':
          durations.push(obj.data.value);
          if (groupName) (durationsByGroup[groupName] ??= []).push(obj.data.value);
          break;
        case 'http_reqs':
          requestCount++;
          if (groupName) countByGroup[groupName] = (countByGroup[groupName] ?? 0) + 1;
          break;
        case 'http_req_failed':
          failedValues.push(obj.data.value);
          if (groupName) (failedByGroup[groupName] ??= []).push(obj.data.value);
          break;
        case 'vus':
          vusValues.push(obj.data.value);
          break;
      }
    } catch { /* skip malformed lines */ }
  }

  if (durations.length === 0 && vusValues.length === 0) return null;

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const max = (arr: number[]) => Math.max(...arr);

  const stepMetrics: LiveStepMetric[] = Object.entries(durationsByGroup).map(([name, d]) => ({
    name,
    avgResponseTime: Math.round(avg(d)),
    rps:             parseFloat(((countByGroup[name] ?? d.length) / LIVE_WINDOW_SEC).toFixed(2)),
    errorRate:       failedByGroup[name]?.length
                       ? parseFloat((avg(failedByGroup[name]) * 100).toFixed(2))
                       : 0,
  }));

  return {
    vus:             vusValues.length    ? Math.round(max(vusValues))                    : 0,
    rps:             parseFloat((requestCount / LIVE_WINDOW_SEC).toFixed(2)),
    avgResponseTime: durations.length    ? Math.round(avg(durations))                    : 0,
    errorRate:       failedValues.length ? parseFloat((avg(failedValues)*100).toFixed(2)): 0,
    ...(stepMetrics.length > 0 && { stepMetrics }),
  };
};
