import { BackendMetrics, ClientMetrics, LighthouseScore } from '@alt/shared';

export type PerfStatus = 'passed' | 'degraded' | 'failed';

export interface MetricDiff {
  metric: string;
  current: number;
  previous: number;
  diffPercent: number;
  status: 'better' | 'same' | 'worse';
}

export interface AnalysisResult {
  perfStatus: PerfStatus;
  diffs: MetricDiff[];
  summary: string;
  thresholdViolations: string[];
}

// Thresholds — межі для визначення статусу
const BACKEND_THRESHOLDS = {
  p95ResponseTime: 1000,  // p95 < 1000ms
  avgResponseTime: 500,   // avg < 500ms
  errorRate: 1,           // error rate < 1%
};

const CLIENT_THRESHOLDS = {
  lcp:  2500,   // LCP < 2500ms (Google "good")
  fcp:  1800,   // FCP < 1800ms
  ttfb: 800,    // TTFB < 800ms
  cls:  0.1,    // CLS < 0.1
};

const LIGHTHOUSE_THRESHOLD_PERFORMANCE = 50; // score 0-100

const getDiffStatus = (diffPercent: number, metric: string): 'better' | 'same' | 'worse' => {
  const threshold = 10; // 10% зміна вважається значущою
  // Для CLS менше = краще
  if (Math.abs(diffPercent) < threshold) return 'same';
  return diffPercent < 0 ? 'better' : 'worse';
};

const analyzeBackend = (
  current: BackendMetrics,
  previous: BackendMetrics | null
): AnalysisResult => {
  const thresholdViolations: string[] = [];
  const diffs: MetricDiff[] = [];

  // Перевіряємо threshold violations
  const currentErrorRate = current.requestsTotal > 0
    ? (current.requestsFailed / current.requestsTotal) * 100
    : 0;

  if (current.p95ResponseTime > BACKEND_THRESHOLDS.p95ResponseTime) {
    thresholdViolations.push(`p95 response time ${Math.round(current.p95ResponseTime)}ms exceeds threshold ${BACKEND_THRESHOLDS.p95ResponseTime}ms`);
  }
  if (current.avgResponseTime > BACKEND_THRESHOLDS.avgResponseTime) {
    thresholdViolations.push(`avg response time ${Math.round(current.avgResponseTime)}ms exceeds threshold ${BACKEND_THRESHOLDS.avgResponseTime}ms`);
  }
  if (currentErrorRate > BACKEND_THRESHOLDS.errorRate) {
    thresholdViolations.push(`error rate ${currentErrorRate.toFixed(2)}% exceeds threshold ${BACKEND_THRESHOLDS.errorRate}%`);
  }

  // Порівнюємо з попереднім тестом
  if (previous) {
    const metrics: Array<{ key: keyof BackendMetrics; label: string }> = [
      { key: 'avgResponseTime', label: 'Avg response time' },
      { key: 'p95ResponseTime', label: 'p95 response time' },
      { key: 'p99ResponseTime', label: 'p99 response time' },
      { key: 'rps',             label: 'Requests/sec' },
    ];

    for (const { key, label } of metrics) {
      const curr = current[key] as number;
      const prev = previous[key] as number;
      if (!prev) continue;

      // Для rps більше = краще, тому інвертуємо diff
      const rawDiff = ((curr - prev) / prev) * 100;
      const diffPercent = key === 'rps' ? -rawDiff : rawDiff;

      diffs.push({
        metric: label,
        current: Math.round(curr * 10) / 10,
        previous: Math.round(prev * 10) / 10,
        diffPercent: Math.round(rawDiff * 10) / 10,
        status: getDiffStatus(diffPercent, key)
      });
    }
  }

  // Визначаємо загальний статус
  const hasFailures = thresholdViolations.length > 0;
  const hasDegradation = diffs.some(d => d.status === 'worse' && Math.abs(d.diffPercent) > 20);

  const perfStatus: PerfStatus = hasFailures ? 'failed' : hasDegradation ? 'degraded' : 'passed';

  const summary = perfStatus === 'passed'
    ? previous ? 'Performance is good and stable compared to previous run' : 'Performance is within acceptable thresholds'
    : perfStatus === 'degraded'
    ? 'Performance has degraded compared to previous run'
    : `Performance issues detected: ${thresholdViolations[0]}`;

  return { perfStatus, diffs, summary, thresholdViolations };
};

const analyzeClient = (
  current: ClientMetrics,
  previous: ClientMetrics | null
): AnalysisResult => {
  const thresholdViolations: string[] = [];
  const diffs: MetricDiff[] = [];

  // Threshold violations
  if (current.lcp > CLIENT_THRESHOLDS.lcp) {
    thresholdViolations.push(`LCP ${Math.round(current.lcp)}ms exceeds threshold ${CLIENT_THRESHOLDS.lcp}ms`);
  }
  if (current.fcp > CLIENT_THRESHOLDS.fcp) {
    thresholdViolations.push(`FCP ${Math.round(current.fcp)}ms exceeds threshold ${CLIENT_THRESHOLDS.fcp}ms`);
  }
  if (current.ttfb > CLIENT_THRESHOLDS.ttfb) {
    thresholdViolations.push(`TTFB ${Math.round(current.ttfb)}ms exceeds threshold ${CLIENT_THRESHOLDS.ttfb}ms`);
  }
  if (current.cls > CLIENT_THRESHOLDS.cls) {
    thresholdViolations.push(`CLS ${current.cls.toFixed(3)} exceeds threshold ${CLIENT_THRESHOLDS.cls}`);
  }

  // Lighthouse threshold
  if (current.lighthouseScore !== undefined) {
    if (current.lighthouseScore.performance < LIGHTHOUSE_THRESHOLD_PERFORMANCE) {
      thresholdViolations.push(
        `Lighthouse performance score ${current.lighthouseScore.performance}/100 is below threshold (${LIGHTHOUSE_THRESHOLD_PERFORMANCE})`
      );
    }
  }

  // Порівняння з попереднім — Web Vitals
  if (previous) {
    const webVitalKeys: Array<{ key: keyof Omit<ClientMetrics, 'type' | 'lighthouseScore'>; label: string }> = [
      { key: 'lcp',  label: 'LCP' },
      { key: 'fcp',  label: 'FCP' },
      { key: 'ttfb', label: 'TTFB' },
      { key: 'fid',  label: 'FID' },
      { key: 'cls',  label: 'CLS' },
    ];

    for (const { key, label } of webVitalKeys) {
      const curr = current[key] as number;
      const prev = previous[key] as number;
      if (!prev) continue;

      const rawDiff = ((curr - prev) / prev) * 100;
      diffs.push({
        metric: label,
        current: key === 'cls' ? Math.round(curr * 1000) / 1000 : Math.round(curr),
        previous: key === 'cls' ? Math.round(prev * 1000) / 1000 : Math.round(prev),
        diffPercent: Math.round(rawDiff * 10) / 10,
        status: getDiffStatus(rawDiff, key)
      });
    }

    // Lighthouse score diffs (higher = better, so invert sign for getDiffStatus)
    if (current.lighthouseScore && previous.lighthouseScore) {
      const lhKeys: Array<{ key: keyof LighthouseScore; label: string }> = [
        { key: 'performance',   label: 'Lighthouse performance' },
        { key: 'accessibility', label: 'Lighthouse accessibility' },
        { key: 'bestPractices', label: 'Lighthouse best practices' },
        { key: 'seo',           label: 'Lighthouse SEO' },
      ];

      for (const { key, label } of lhKeys) {
        const curr = current.lighthouseScore[key];
        const prev = previous.lighthouseScore[key];
        if (!prev) continue;

        const rawDiff = ((curr - prev) / prev) * 100;
        diffs.push({
          metric: label,
          current: curr,
          previous: prev,
          diffPercent: Math.round(rawDiff * 10) / 10,
          status: getDiffStatus(-rawDiff, key), // invert: higher score = better
        });
      }
    }
  }

  const hasFailures = thresholdViolations.length > 0;
  const hasDegradation = diffs.some(d => d.status === 'worse' && Math.abs(d.diffPercent) > 20);
  const perfStatus: PerfStatus = hasFailures ? 'failed' : hasDegradation ? 'degraded' : 'passed';

  const summary = perfStatus === 'passed'
    ? previous ? 'Web Vitals are good and stable' : 'Web Vitals are within acceptable thresholds'
    : perfStatus === 'degraded'
    ? 'Web Vitals have degraded compared to previous run'
    : `Web Vitals issues: ${thresholdViolations[0]}`;

  return { perfStatus, diffs, summary, thresholdViolations };
};

export const analyzeResult = (
  currentMetrics: BackendMetrics | ClientMetrics,
  previousMetrics: BackendMetrics | ClientMetrics | null
): AnalysisResult => {
  if (currentMetrics.type === 'backend') {
    return analyzeBackend(
      currentMetrics as BackendMetrics,
      previousMetrics as BackendMetrics | null
    );
  }
  return analyzeClient(
    currentMetrics as ClientMetrics,
    previousMetrics as ClientMetrics | null
  );
};