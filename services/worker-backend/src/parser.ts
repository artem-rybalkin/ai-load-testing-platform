import { BackendMetrics, LiveMetricPoint, LiveStepMetric, StepMetrics } from '@alt/shared';

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
    return m ? toMs(parseFloat(m[1]), m[2]) : 0;
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

export const parseK6StatusCodes = (jsonContent: string): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const line of jsonContent.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type !== 'Point' || obj.metric !== 'http_reqs') continue;
      const status: string = obj.data?.tags?.status;
      if (status) counts[status] = (counts[status] ?? 0) + 1;
    } catch { /* skip malformed */ }
  }
  return counts;
};

export const parseK6GroupMetrics = (jsonContent: string): StepMetrics[] => {
  const durationsByGroup: Record<string, number[]> = {};
  const countByGroup:    Record<string, number>    = {};
  const failedByGroup:   Record<string, number[]>  = {};

  for (const line of jsonContent.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type !== 'Point') continue;
      const rawGroup: string = obj.data?.tags?.group ?? '';
      if (!rawGroup || rawGroup === '::') continue;
      const name = rawGroup.replace(/^::/, ''); // strip k6's leading ::
      switch (obj.metric) {
        case 'http_req_duration':
          (durationsByGroup[name] ??= []).push(obj.data.value);
          break;
        case 'http_reqs':
          countByGroup[name] = (countByGroup[name] ?? 0) + 1;
          break;
        case 'http_req_failed':
          (failedByGroup[name] ??= []).push(obj.data.value);
          break;
      }
    } catch { /* skip malformed */ }
  }

  return Object.entries(durationsByGroup).map(([name, durations]) => {
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
};

interface K6JsonPoint {
  type: string;
  metric: string;
  data: { value: number; time: string; tags?: Record<string, string> };
}

const LIVE_WINDOW_SEC = 5;

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
