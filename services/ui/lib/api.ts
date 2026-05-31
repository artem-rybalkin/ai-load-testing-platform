const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const RESULTS_URL = import.meta.env.VITE_RESULTS_URL || 'http://localhost:3004';
export const RECORDER_URL = import.meta.env.VITE_RECORDER_URL || 'http://localhost:3007';
const API_KEY = import.meta.env.VITE_API_KEY || '';

const authHeaders = (): Record<string, string> =>
  API_KEY ? { 'X-API-Key': API_KEY } : {};

export type ExtractSource = 'jsonpath' | 'header' | 'cookie' | 'regex';

export interface ExtractRule {
  source: ExtractSource;
  expression: string;
}

export interface FlowStep {
  name: string;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: string;
  headers?: Record<string, string>;
  extract?: Record<string, ExtractRule>;
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
    httpOptions?: {
      keepAlive?: boolean;
      timeout?: string;
      http2?: boolean;
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
}

export interface TestResult {
  id: string;
  test_id: string;
  type: string;
  target_url: string;
  status: string;
  metrics: Record<string, number>;
  script: string | null;
  script_description: string | null;
  reused_script: boolean;
  is_baseline: boolean;
  duration_seconds: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  steps?: FlowStep[];
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

export interface Preset {
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

export const getPresets = async (): Promise<{ presets: Preset[] }> => {
  const res = await fetch(`${RESULTS_URL}/presets`, { cache: 'no-store', headers: authHeaders() });
  return res.json();
};

export const createPreset = async (data: Omit<Preset, 'id' | 'used_count' | 'created_at'>): Promise<{ preset: Preset }> => {
  const res = await fetch(`${RESULTS_URL}/presets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  });
  return res.json();
};

export const getPreset = async (id: string): Promise<{ preset: Preset }> => {
  const res = await fetch(`${RESULTS_URL}/presets/${id}`, { cache: 'no-store', headers: authHeaders() });
  return res.json();
};

export const deletePreset = async (id: string): Promise<void> => {
  await fetch(`${RESULTS_URL}/presets/${id}`, { method: 'DELETE', headers: authHeaders() });
};

export interface WorkerMetrics {
  cpuPercent: number;
  memoryMb: number;
  memoryPercent: number;
  activeTests: number;
  maxTests: number;
}

export interface ServiceHealth {
  name: string;
  status: 'ok' | 'degraded' | 'saturated' | 'unreachable';
  checks: Record<string, string>;
  metrics?: WorkerMetrics;
}

export interface SystemHealth {
  healthy: boolean;
  services: ServiceHealth[];
}

export const getSystemHealth = async (): Promise<SystemHealth> => {
  const res = await fetch(`${RESULTS_URL}/system/health`, { cache: 'no-store', headers: authHeaders() });
  return res.json();
};

export interface AIStatus {
  quotaExceeded: boolean;
  message?: string;
  since?: string;
}

export const getAIStatus = async (): Promise<AIStatus> => {
  const res = await fetch(`${RESULTS_URL}/system/ai-status`, { cache: 'no-store' });
  return res.json();
};

// ── Log Sources ──────────────────────────────────────────────────────────────

export interface LogSource {
  id: string;
  name: string;
  platform: string | null;
  url_template: string;
  created_at: string;
}

/**
 * Interpolates template variables in a log source URL for a specific test result.
 *
 * Supported variables:
 *   {startedAtMs}      — started_at as epoch milliseconds
 *   {completedAtMs}    — completed_at as epoch milliseconds (falls back to now)
 *   {startedAtISO}     — started_at as ISO 8601 string
 *   {completedAtISO}   — completed_at as ISO 8601 string
 *   {targetUrl}        — raw target URL
 *   {targetUrlEncoded} — URL-encoded target URL
 *   {testId}           — test UUID
 */
export const interpolateLogSourceUrl = (
  template: string,
  result: Pick<TestResult, 'test_id' | 'target_url' | 'started_at' | 'completed_at'>
): string => {
  const startedAt  = result.started_at  ? new Date(result.started_at)  : new Date();
  const completedAt = result.completed_at ? new Date(result.completed_at) : new Date();

  return template
    .replaceAll('{startedAtMs}',      String(startedAt.getTime()))
    .replaceAll('{completedAtMs}',    String(completedAt.getTime()))
    .replaceAll('{startedAtISO}',     startedAt.toISOString())
    .replaceAll('{completedAtISO}',   completedAt.toISOString())
    .replaceAll('{targetUrl}',        result.target_url)
    .replaceAll('{targetUrlEncoded}', encodeURIComponent(result.target_url))
    .replaceAll('{testId}',           result.test_id);
};

export const getLogSources = async (): Promise<{ logSources: LogSource[] }> => {
  const res = await fetch(`${RESULTS_URL}/log-sources`, { cache: 'no-store', headers: authHeaders() });
  return res.json();
};

export const createLogSource = async (data: { name: string; platform?: string; urlTemplate: string }): Promise<{ logSource: LogSource }> => {
  const res = await fetch(`${RESULTS_URL}/log-sources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  });
  return res.json();
};

export const deleteLogSource = async (id: string): Promise<void> => {
  await fetch(`${RESULTS_URL}/log-sources/${id}`, { method: 'DELETE', headers: authHeaders() });
};

// ── Flow Recording ────────────────────────────────────────────────────────────

export interface RecordingSession {
  id: string;
  status: 'active' | 'stopping' | 'completed' | 'error';
  noVncUrl: string;
  steps?: FlowStep[];
  stepCount?: number;
  error?: string;
}

export const startRecording = async (targetUrl?: string, ignorePatterns?: string[]): Promise<RecordingSession> => {
  const res = await fetch(`${RECORDER_URL}/recordings/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetUrl, ignorePatterns }),
  });
  if (!res.ok) throw new Error(`Recorder error: ${res.status}`);
  return res.json();
};

export const stopRecording = async (id: string): Promise<RecordingSession> => {
  const res = await fetch(`${RECORDER_URL}/recordings/${id}/stop`, { method: 'POST' });
  if (!res.ok) throw new Error(`Recorder error: ${res.status}`);
  return res.json();
};

export const getRecording = async (id: string): Promise<RecordingSession> => {
  const res = await fetch(`${RECORDER_URL}/recordings/${id}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Recorder error: ${res.status}`);
  return res.json();
};