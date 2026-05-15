import { BackendMetrics, LiveMetricPoint } from '@alt/shared';

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

interface K6JsonPoint {
  type: string;
  metric: string;
  data: { value: number; time: string };
}

const LIVE_WINDOW_SEC = 5;

export const aggregateWindow = (lines: string[]): Omit<LiveMetricPoint, 'timestamp'> | null => {
  const durations: number[] = [];
  const vusValues: number[] = [];
  const failedValues: number[] = [];
  let requestCount = 0;

  for (const line of lines) {
    try {
      const obj: K6JsonPoint = JSON.parse(line);
      if (obj.type !== 'Point') continue;
      switch (obj.metric) {
        case 'http_req_duration': durations.push(obj.data.value);   break;
        case 'vus':               vusValues.push(obj.data.value);   break;
        case 'http_req_failed':   failedValues.push(obj.data.value);break;
        case 'http_reqs':         requestCount++;                    break;
      }
    } catch { /* skip malformed lines */ }
  }

  if (durations.length === 0 && vusValues.length === 0) return null;

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const max = (arr: number[]) => Math.max(...arr);

  return {
    vus:             vusValues.length   ? Math.round(max(vusValues))              : 0,
    rps:             parseFloat((requestCount / LIVE_WINDOW_SEC).toFixed(2)),
    avgResponseTime: durations.length   ? Math.round(avg(durations))              : 0,
    errorRate:       failedValues.length? parseFloat((avg(failedValues)*100).toFixed(2)): 0,
  };
};
