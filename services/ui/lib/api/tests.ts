import type { FlowStep, BackendMetrics, ClientMetrics, SLOThresholds } from '@alt/shared';
import { f, API_URL, RESULTS_URL } from './core';

export type { BackendMetrics, ClientMetrics };

export interface TestRequest {
  type: 'backend' | 'client-side' | 'flow';
  targetUrl: string;
  description: string;
  options: {
    vus?: number;
    duration: string;
    rampUp?: string;
    sessions?: number;
    collectWebVitals?: boolean;
    httpOptions?: {
      keepAlive?: boolean;
      timeout?: string;
      discardResponseBodies?: boolean;
    };
  };
  steps?: FlowStep[];
  envVars?: Record<string, string>;
  testData?: Array<Record<string, string>>;
  csvData?: string;
  csvFilename?: string;
  customScript?: string;
  thresholds?: {
    p95?: number; avg?: number; errorRate?: number; serverErrorRate?: number; timeoutRate?: number;
    lcp?: number; fcp?: number; ttfb?: number; cls?: number;
  };
  workspaceId?: string;
}

export interface TestResult {
  id: string;
  test_id: string;
  type: string;
  target_url: string;
  status: string;
  metrics: BackendMetrics | ClientMetrics | null;
  script: string | null;
  script_description: string | null;
  reused_script: boolean;
  is_baseline: boolean;
  duration_seconds: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  steps?: FlowStep[];
  test_data?: Array<Record<string, string>>;
  perf_status?: string;
  status_message?: string | null;
  analysis?: {
    perfStatus: string;
    diffs: Array<{
      metric: string;
      current: number;
      previous: number;
      diffPercent: number;
      status: 'better' | 'same' | 'worse';
    }>;
    summary: string;
    thresholdViolations: string[];
    aiInsights?: {
      narrative: string;
      anomalies: string[];
      rootCauses: string[];
      recommendations: string[];
      severity: 'critical' | 'warning' | 'info';
    };
  };
}

export interface ActiveTest {
  test_id: string;
  type: string;
  target_url: string;
  status: string;
  created_at: string;
}

export interface LiveMetricPoint {
  timestamp: string;
  vus: number;
  rps: number;
  avgResponseTime: number;
  errorRate: number;
  clientErrorRate?: number;
  serverErrorRate?: number;
  stepMetrics?: Array<{ name: string; avgResponseTime: number; rps: number; errorRate: number }>;
}

export interface TrendPoint {
  test_id: string;
  type: string;
  metrics: Record<string, number>;
  perf_status?: string;
  created_at: string;
}

export interface ThresholdPreview {
  available: boolean;
  perfStatus?: 'passed' | 'degraded' | 'failed';
  thresholdViolations?: string[];
  basedOn?: { testId: string; completedAt: string };
}

export const createTest = async (data: TestRequest) => {
  const res = await f(`${API_URL}/tests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
};

export const getResults = async (before?: string, limit = 50, workspaceId?: string | null): Promise<{ results: TestResult[]; nextBefore: string | null }> => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set('before', before);
  if (workspaceId) params.set('workspaceId', workspaceId);
  const res = await f(`${RESULTS_URL}/results?${params}`, { cache: 'no-store' });
  return res.json();
};

export const getResult = async (testId: string): Promise<{ result: TestResult }> => {
  const res = await f(`${RESULTS_URL}/results/${testId}`, { cache: 'no-store' });
  return res.json();
};

export const getScripts = async (workspaceId?: string | null) => {
  const params = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
  const res = await f(`${RESULTS_URL}/scripts${params}`, { cache: 'no-store' });
  return res.json();
};

export const getActiveTests = async (): Promise<{ active: ActiveTest[] }> => {
  const res = await f(`${RESULTS_URL}/results/active`, { cache: 'no-store' });
  return res.json();
};

export const getLiveMetrics = async (testId: string): Promise<{ points: LiveMetricPoint[] }> => {
  const res = await f(`${RESULTS_URL}/results/${testId}/live`, { cache: 'no-store' });
  return res.json();
};

export const getExecutionLog = async (testId: string): Promise<{ log: string | null }> => {
  const res = await f(`${RESULTS_URL}/results/${testId}/log`, { cache: 'no-store' });
  if (!res.ok) return { log: null };
  return res.json();
};

export const cancelTest = async (testId: string): Promise<void> => {
  const res = await f(`${API_URL}/tests/${testId}/cancel`, { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
};

export const setBaseline = async (testId: string): Promise<void> => {
  const res = await f(`${RESULTS_URL}/results/${testId}/baseline`, { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
};

export const clearBaseline = async (testId: string): Promise<void> => {
  const res = await f(`${RESULTS_URL}/results/${testId}/baseline`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
};

export const compareResults = async (a: string, b: string): Promise<{ resultA: TestResult; resultB: TestResult }> => {
  const res = await f(`${RESULTS_URL}/results/compare?a=${a}&b=${b}`, { cache: 'no-store' });
  return res.json();
};

export const getTrend = async (url: string): Promise<{ url: string; trend: TrendPoint[] }> => {
  const res = await f(`${RESULTS_URL}/results/trend?url=${encodeURIComponent(url)}`, { cache: 'no-store' });
  return res.json();
};

export const previewThresholds = async (url: string, type: string, thresholds: SLOThresholds): Promise<ThresholdPreview> => {
  const res = await f(
    `${RESULTS_URL}/results/preview-thresholds?url=${encodeURIComponent(url)}&type=${type}&thresholds=${encodeURIComponent(JSON.stringify(thresholds))}`,
    { cache: 'no-store' },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
};
