import { BackendMetrics, ClientMetrics, LighthouseScore, SLOThresholds } from '@alt/shared';

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

const getDiffStatus = (diffPercent: number): 'better' | 'same' | 'worse' => {
  if (Math.abs(diffPercent) < 10) return 'same';
  return diffPercent < 0 ? 'better' : 'worse';
};

const analyzeBackend = (
  current: BackendMetrics,
  previous: BackendMetrics | null,
  thresholds?: SLOThresholds
): AnalysisResult => {
  const t = {
    p95ResponseTime: thresholds?.p95  ?? BACKEND_THRESHOLDS.p95ResponseTime,
    avgResponseTime: thresholds?.avg  ?? BACKEND_THRESHOLDS.avgResponseTime,
    errorRate:       thresholds?.errorRate ?? BACKEND_THRESHOLDS.errorRate,
    serverErrorRate: thresholds?.serverErrorRate ?? 1,
    timeoutRate:     thresholds?.timeoutRate ?? 1,
  };

  const thresholdViolations: string[] = [];
  const diffs: MetricDiff[] = [];

  const total = current.requestsTotal;
  const currentErrorRate = total > 0 ? (current.requestsFailed / total) * 100 : 0;

  if (current.p95ResponseTime > t.p95ResponseTime) {
    thresholdViolations.push(`p95 response time ${Math.round(current.p95ResponseTime)}ms exceeds threshold ${t.p95ResponseTime}ms`);
  }
  if (current.avgResponseTime > t.avgResponseTime) {
    thresholdViolations.push(`avg response time ${Math.round(current.avgResponseTime)}ms exceeds threshold ${t.avgResponseTime}ms`);
  }
  if (currentErrorRate > t.errorRate) {
    thresholdViolations.push(`error rate ${currentErrorRate.toFixed(2)}% exceeds threshold ${t.errorRate}%`);
  }

  // Granular error category thresholds
  if (current.errorBreakdown && total > 0) {
    const serverRate = (current.errorBreakdown.serverError / total) * 100;
    const timeoutRate = (current.errorBreakdown.timeout / total) * 100;
    if (serverRate > t.serverErrorRate) {
      thresholdViolations.push(`server error rate (5xx) ${serverRate.toFixed(2)}% exceeds threshold ${t.serverErrorRate}%`);
    }
    if (timeoutRate > t.timeoutRate) {
      thresholdViolations.push(`timeout rate ${timeoutRate.toFixed(2)}% exceeds threshold ${t.timeoutRate}%`);
    }
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
        status: getDiffStatus(diffPercent)
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
  previous: ClientMetrics | null,
  thresholds?: SLOThresholds
): AnalysisResult => {
  const t = {
    lcp:  thresholds?.lcp  ?? CLIENT_THRESHOLDS.lcp,
    fcp:  thresholds?.fcp  ?? CLIENT_THRESHOLDS.fcp,
    ttfb: thresholds?.ttfb ?? CLIENT_THRESHOLDS.ttfb,
    cls:  thresholds?.cls  ?? CLIENT_THRESHOLDS.cls,
  };

  const thresholdViolations: string[] = [];
  const diffs: MetricDiff[] = [];

  if (current.lcp > t.lcp) {
    thresholdViolations.push(`LCP ${Math.round(current.lcp)}ms exceeds threshold ${t.lcp}ms`);
  }
  if (current.fcp > t.fcp) {
    thresholdViolations.push(`FCP ${Math.round(current.fcp)}ms exceeds threshold ${t.fcp}ms`);
  }
  if (current.ttfb > t.ttfb) {
    thresholdViolations.push(`TTFB ${Math.round(current.ttfb)}ms exceeds threshold ${t.ttfb}ms`);
  }
  if (current.cls > t.cls) {
    thresholdViolations.push(`CLS ${current.cls.toFixed(3)} exceeds threshold ${t.cls}`);
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
        status: getDiffStatus(rawDiff)
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
          status: getDiffStatus(-rawDiff), // invert: higher score = better
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
  previousMetrics: BackendMetrics | ClientMetrics | null,
  thresholds?: SLOThresholds
): AnalysisResult => {
  if (currentMetrics.type === 'backend') {
    return analyzeBackend(
      currentMetrics as BackendMetrics,
      previousMetrics as BackendMetrics | null,
      thresholds
    );
  }
  return analyzeClient(
    currentMetrics as ClientMetrics,
    previousMetrics as ClientMetrics | null,
    thresholds
  );
};