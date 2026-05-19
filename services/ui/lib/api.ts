const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const RESULTS_URL = process.env.NEXT_PUBLIC_RESULTS_URL || 'http://localhost:3004';
const API_KEY = process.env.NEXT_PUBLIC_API_KEY || '';

const authHeaders = (): Record<string, string> =>
  API_KEY ? { 'X-API-Key': API_KEY } : {};

export interface FlowStep {
  name: string;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: string;
  headers?: Record<string, string>;
  extract?: Record<string, string>;
}

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
  };
  steps?: FlowStep[];
  envVars?: Record<string, string>;
  thresholds?: {
    p95?: number; avg?: number; errorRate?: number;
    lcp?: number; fcp?: number; ttfb?: number; cls?: number;
  };
}

export interface TestResult {
  id: string;
  test_id: string;
  type: string;
  target_url: string;
  status: string;
  metrics: Record<string, number>;
  script: string | null;
  reused_script: boolean;
  is_baseline: boolean;
  duration_seconds: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  perf_status?: string;
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
  };
}

export const createTest = async (data: TestRequest) => {
  const res = await fetch(`${API_URL}/tests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data)
  });
  return res.json();
};

export const getResults = async (): Promise<{ results: TestResult[] }> => {
  const res = await fetch(`${RESULTS_URL}/results`, { cache: 'no-store', headers: authHeaders() });
  return res.json();
};

export const getResult = async (testId: string): Promise<{ result: TestResult }> => {
  const res = await fetch(`${RESULTS_URL}/results/${testId}`, { cache: 'no-store', headers: authHeaders() });
  return res.json();
};

export const getScripts = async () => {
  const res = await fetch(`${RESULTS_URL}/scripts`, { cache: 'no-store', headers: authHeaders() });
  return res.json();
};
export interface ActiveTest {
  test_id: string;
  type: string;
  target_url: string;
  status: string;
  created_at: string;
}

export const getActiveTests = async (): Promise<{ active: ActiveTest[] }> => {
  const res = await fetch(`${RESULTS_URL}/results/active`, { cache: 'no-store', headers: authHeaders() });
  return res.json();
};

export interface LiveMetricPoint {
  timestamp: string;
  vus: number;
  rps: number;
  avgResponseTime: number;
  errorRate: number;
  stepMetrics?: Array<{ name: string; avgResponseTime: number; rps: number; errorRate: number }>;
}

export const getLiveMetrics = async (testId: string): Promise<{ points: LiveMetricPoint[] }> => {
  const res = await fetch(`${RESULTS_URL}/results/${testId}/live`, { cache: 'no-store', headers: authHeaders() });
  return res.json();
};

export const cancelTest = async (testId: string): Promise<void> => {
  await fetch(`${API_URL}/tests/${testId}/cancel`, { method: 'POST', headers: authHeaders() });
};

export const setBaseline = async (testId: string): Promise<void> => {
  await fetch(`${RESULTS_URL}/results/${testId}/baseline`, { method: 'POST', headers: authHeaders() });
};

export const clearBaseline = async (testId: string): Promise<void> => {
  await fetch(`${RESULTS_URL}/results/${testId}/baseline`, { method: 'DELETE', headers: authHeaders() });
};

export const compareResults = async (a: string, b: string): Promise<{ resultA: TestResult; resultB: TestResult }> => {
  const res = await fetch(`${RESULTS_URL}/results/compare?a=${a}&b=${b}`, { cache: 'no-store', headers: authHeaders() });
  return res.json();
};

export interface TrendPoint {
  test_id: string;
  type: string;
  metrics: Record<string, number>;
  perf_status?: string;
  created_at: string;
}

export const getTrend = async (url: string): Promise<{ url: string; trend: TrendPoint[] }> => {
  const res = await fetch(`${RESULTS_URL}/results/trend?url=${encodeURIComponent(url)}`, { cache: 'no-store', headers: authHeaders() });
  return res.json();
};

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  created_at: string;
}

export const getWebhooks = async (): Promise<{ webhooks: Webhook[] }> => {
  const res = await fetch(`${RESULTS_URL}/webhooks`, { cache: 'no-store', headers: authHeaders() });
  return res.json();
};

export const createWebhook = async (url: string, events?: string[]): Promise<{ webhook: Webhook }> => {
  const res = await fetch(`${RESULTS_URL}/webhooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ url, events })
  });
  return res.json();
};

export const deleteWebhook = async (id: string): Promise<void> => {
  await fetch(`${RESULTS_URL}/webhooks/${id}`, { method: 'DELETE', headers: authHeaders() });
};

export interface Schedule {
  id: string;
  name: string;
  cron: string;
  type: 'backend' | 'client-side';
  target_url: string;
  description: string | null;
  options: Record<string, unknown>;
  thresholds: Record<string, unknown> | null;
  enabled: boolean;
  last_run_at: string | null;
  created_at: string;
}

export const getSchedules = async (): Promise<{ schedules: Schedule[] }> => {
  const res = await fetch(`${RESULTS_URL}/schedules`, { cache: 'no-store', headers: authHeaders() });
  return res.json();
};

export const createSchedule = async (data: Omit<Schedule, 'id' | 'last_run_at' | 'created_at'>): Promise<{ schedule: Schedule }> => {
  const res = await fetch(`${RESULTS_URL}/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  });
  return res.json();
};

export const updateSchedule = async (id: string, data: Partial<Omit<Schedule, 'id' | 'created_at'>>): Promise<{ schedule: Schedule }> => {
  const res = await fetch(`${RESULTS_URL}/schedules/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  });
  return res.json();
};

export const deleteSchedule = async (id: string): Promise<void> => {
  await fetch(`${RESULTS_URL}/schedules/${id}`, { method: 'DELETE', headers: authHeaders() });
};

export const runSchedule = async (id: string): Promise<void> => {
  await fetch(`${RESULTS_URL}/schedules/${id}/run`, { method: 'POST', headers: authHeaders() });
};

export interface Template {
  id: string;
  name: string;
  description: string | null;
  type: 'backend' | 'client-side';
  target_url: string | null;
  options: Record<string, unknown>;
  thresholds: Record<string, unknown> | null;
  used_count: number;
  created_at: string;
}

export const getTemplates = async (): Promise<{ templates: Template[] }> => {
  const res = await fetch(`${RESULTS_URL}/templates`, { cache: 'no-store', headers: authHeaders() });
  return res.json();
};

export const createTemplate = async (data: Omit<Template, 'id' | 'used_count' | 'created_at'>): Promise<{ template: Template }> => {
  const res = await fetch(`${RESULTS_URL}/templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  });
  return res.json();
};

export const getTemplate = async (id: string): Promise<{ template: Template }> => {
  const res = await fetch(`${RESULTS_URL}/templates/${id}`, { cache: 'no-store', headers: authHeaders() });
  return res.json();
};

export const deleteTemplate = async (id: string): Promise<void> => {
  await fetch(`${RESULTS_URL}/templates/${id}`, { method: 'DELETE', headers: authHeaders() });
};