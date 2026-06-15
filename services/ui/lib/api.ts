import type { ExtractSource, ExtractRule, FlowStep, SessionUser, TeamRole, TeamQuota, TeamUsage, OrgRole, SLOThresholds } from '@alt/shared';

export type { ExtractSource, ExtractRule, FlowStep, SessionUser, TeamRole, TeamQuota, TeamUsage, OrgRole };

// Base paths — all routed through Vite proxy (same-origin, cookies work)
const API_URL     = '/api';
const RESULTS_URL = '/data';
// RECORDER_URL keeps its absolute URL for the opener window
export const RECORDER_URL = import.meta.env.VITE_RECORDER_URL || 'http://localhost:3007';
const API_KEY = import.meta.env.VITE_API_KEY || '';

const authHeaders = (): Record<string, string> =>
  API_KEY ? { 'X-API-Key': API_KEY } : {};

// All fetch calls use credentials: 'include' so the session cookie is sent
const f = (url: string, init?: RequestInit) =>
  fetch(url, { ...init, credentials: 'include', headers: { ...authHeaders(), ...(init?.headers ?? {}) } });

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

export const createTest = async (data: TestRequest) => {
  const res = await f(`${API_URL}/tests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
};

export const getResults = async (before?: string, limit = 50): Promise<{ results: TestResult[]; nextBefore: string | null }> => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set('before', before);
  const res = await f(`${RESULTS_URL}/results?${params}`, { cache: 'no-store' });
  return res.json();
};

export const getResult = async (testId: string): Promise<{ result: TestResult }> => {
  const res = await f(`${RESULTS_URL}/results/${testId}`, { cache: 'no-store' });
  return res.json();
};

export const getScripts = async () => {
  const res = await f(`${RESULTS_URL}/scripts`, { cache: 'no-store' });
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
  const res = await f(`${RESULTS_URL}/results/active`, { cache: 'no-store' });
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
  const res = await f(`${RESULTS_URL}/results/${testId}/live`, { cache: 'no-store' });
  return res.json();
};

export const cancelTest = async (testId: string): Promise<void> => {
  await f(`${API_URL}/tests/${testId}/cancel`, { method: 'POST' });
};

export const setBaseline = async (testId: string): Promise<void> => {
  await f(`${RESULTS_URL}/results/${testId}/baseline`, { method: 'POST' });
};

export const clearBaseline = async (testId: string): Promise<void> => {
  await f(`${RESULTS_URL}/results/${testId}/baseline`, { method: 'DELETE' });
};

export const compareResults = async (a: string, b: string): Promise<{ resultA: TestResult; resultB: TestResult }> => {
  const res = await f(`${RESULTS_URL}/results/compare?a=${a}&b=${b}`, { cache: 'no-store' });
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
  const res = await f(`${RESULTS_URL}/results/trend?url=${encodeURIComponent(url)}`, { cache: 'no-store' });
  return res.json();
};

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  format: 'generic' | 'slack' | 'pagerduty' | 'opsgenie';
  created_at: string;
}

export const getWebhooks = async (): Promise<{ webhooks: Webhook[] }> => {
  const res = await f(`${RESULTS_URL}/webhooks`, { cache: 'no-store' });
  return res.json();
};

export const createWebhook = async (url: string, events?: string[], format?: string): Promise<{ webhook: Webhook }> => {
  const res = await f(`${RESULTS_URL}/webhooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, events, format })
  });
  return res.json();
};

export const deleteWebhook = async (id: string): Promise<void> => {
  await f(`${RESULTS_URL}/webhooks/${id}`, { method: 'DELETE' });
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
  const res = await f(`${RESULTS_URL}/schedules`, { cache: 'no-store' });
  return res.json();
};

export const createSchedule = async (data: Omit<Schedule, 'id' | 'last_run_at' | 'created_at'>): Promise<{ schedule: Schedule }> => {
  const res = await f(`${RESULTS_URL}/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
};

export const updateSchedule = async (id: string, data: Partial<Omit<Schedule, 'id' | 'created_at'>>): Promise<{ schedule: Schedule }> => {
  const res = await f(`${RESULTS_URL}/schedules/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
};

export const deleteSchedule = async (id: string): Promise<void> => {
  await f(`${RESULTS_URL}/schedules/${id}`, { method: 'DELETE' });
};

export const runSchedule = async (id: string): Promise<void> => {
  await f(`${RESULTS_URL}/schedules/${id}/run`, { method: 'POST' });
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
  const res = await f(`${RESULTS_URL}/presets`, { cache: 'no-store' });
  return res.json();
};

export const createPreset = async (data: Omit<Preset, 'id' | 'used_count' | 'created_at'>): Promise<{ preset: Preset }> => {
  const res = await f(`${RESULTS_URL}/presets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
};

export const getPreset = async (id: string): Promise<{ preset: Preset }> => {
  const res = await f(`${RESULTS_URL}/presets/${id}`, { cache: 'no-store' });
  return res.json();
};

export const deletePreset = async (id: string): Promise<void> => {
  await f(`${RESULTS_URL}/presets/${id}`, { method: 'DELETE' });
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
  const res = await f(`${RESULTS_URL}/system/health`, { cache: 'no-store' });
  return res.json();
};

export interface AIStatus {
  quotaExceeded: boolean;
  message?: string;
  since?: string;
}

export const getAIStatus = async (): Promise<AIStatus> => {
  const res = await f(`${RESULTS_URL}/system/ai-status`, { cache: 'no-store' });
  return res.json();
};

// ── Log Sources ──────────────────────────────────────────────────────────────

export interface LogSource {
  id: string;
  name: string;
  platform: string | null;
  url_template: string;
  metrics_endpoint_template: string | null;
  auth_header: string | null;
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
    .replaceAll('{startedAtS}',       String(Math.floor(startedAt.getTime() / 1000)))
    .replaceAll('{completedAtS}',     String(Math.floor(completedAt.getTime() / 1000)))
    .replaceAll('{startedAtISO}',     startedAt.toISOString())
    .replaceAll('{completedAtISO}',   completedAt.toISOString())
    .replaceAll('{targetUrl}',        result.target_url)
    .replaceAll('{targetUrlEncoded}', encodeURIComponent(result.target_url))
    .replaceAll('{testId}',           result.test_id);
};

export const getLogSources = async (): Promise<{ logSources: LogSource[] }> => {
  const res = await f(`${RESULTS_URL}/log-sources`, { cache: 'no-store' });
  return res.json();
};

export const createLogSource = async (data: { name: string; platform?: string; urlTemplate: string; metricsEndpointTemplate?: string; authHeader?: string }): Promise<{ logSource: LogSource }> => {
  const res = await f(`${RESULTS_URL}/log-sources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
};

export const updateLogSource = async (id: string, data: Partial<{ name: string; platform: string | null; urlTemplate: string; metricsEndpointTemplate: string | null; authHeader: string | null }>): Promise<{ logSource: LogSource }> => {
  const res = await f(`${RESULTS_URL}/log-sources/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
};

export const deleteLogSource = async (id: string): Promise<void> => {
  await f(`${RESULTS_URL}/log-sources/${id}`, { method: 'DELETE' });
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
  const res = await fetch(`/recordings/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ targetUrl, ignorePatterns }),
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Recorder error: ${res.status}`);
  return res.json();
};

export const stopRecording = async (id: string): Promise<RecordingSession> => {
  const res = await fetch(`/recordings/${id}/stop`, {
    method: 'POST',
    headers: { ...authHeaders() },
    signal: AbortSignal.timeout(120_000), // 2 min — AI correlation can be slow
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Recorder error: ${res.status}`);
  return res.json();
};

export const getRecording = async (id: string): Promise<RecordingSession> => {
  const res = await fetch(`/recordings/${id}`, { cache: 'no-store', headers: authHeaders(), credentials: 'include' });
  if (!res.ok) throw new Error(`Recorder error: ${res.status}`);
  return res.json();
};

// ── AI features ──────────────────────────────────────────────────────────────

export interface ThresholdSuggestion {
  p95: number;
  avg: number;
  errorRate: number;
  reasoning: string;
}

export interface ErrorDiagnosis {
  category: 'serverError' | 'clientError' | 'timeout' | 'networkError';
  count: number;
  likelyCause: string;
  nextStep: string;
}

export const diagnoseErrors = async (testId: string): Promise<{ diagnoses: ErrorDiagnosis[]; message?: string }> => {
  const res = await f(`${RESULTS_URL}/results/${testId}/diagnose`, { cache: 'no-store' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
};

export const predictWebhookNoise = async (events: string[]): Promise<{ level: string; warning: string | null; message: string }> => {
  const res = await f(`${RESULTS_URL}/ai/webhook-noise`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  });
  if (!res.ok) { const b = await res.json().catch(() => ({})) as { error?: string }; throw new Error(b.error ?? `HTTP ${res.status}`); }
  return res.json();
};

export const suggestPresetName = async (params: { url: string; type: string; vus?: number; duration?: string; profile?: string; stepCount?: number }): Promise<{ name: string; tags: string[] }> => {
  const res = await f(`${RESULTS_URL}/ai/preset-name`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) { const b = await res.json().catch(() => ({})) as { error?: string }; throw new Error(b.error ?? `HTTP ${res.status}`); }
  return res.json();
};

export const suggestParamColumns = async (steps: FlowStep[]): Promise<{ columns: string[]; reasoning: string }> => {
  const res = await f(`${RESULTS_URL}/ai/param-suggestions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ steps: steps.map(s => ({ url: s.url, method: s.method, body: s.body })) }),
  });
  if (!res.ok) { const b = await res.json().catch(() => ({})) as { error?: string }; throw new Error(b.error ?? `HTTP ${res.status}`); }
  return res.json();
};

export const translatePlaywright = async (script: string, targetUrl?: string): Promise<{ k6Script: string }> => {
  const res = await f(`${API_URL}/translate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script, targetUrl }),
  });
  if (!res.ok) { const b = await res.json().catch(() => ({})) as { error?: string }; throw new Error(b.error ?? `HTTP ${res.status}`); }
  return res.json();
};

export const convertCron = async (phrase: string): Promise<{ cron: string; preview: string }> => {
  const res = await f(`${RESULTS_URL}/ai/cron`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phrase }),
  });
  if (!res.ok) { const b = await res.json().catch(() => ({})) as { error?: string }; throw new Error(b.error ?? `HTTP ${res.status}`); }
  return res.json();
};

export interface SettingsSuggestion { vus: number; duration: string; profile: string; reasoning: string }
export const suggestSettings = async (url: string, type = 'backend'): Promise<SettingsSuggestion> => {
  const res = await f(`${RESULTS_URL}/results/suggest-settings?url=${encodeURIComponent(url)}&type=${type}`, { cache: 'no-store' });
  if (!res.ok) { const b = await res.json().catch(() => ({})) as { error?: string }; throw new Error(b.error ?? `HTTP ${res.status}`); }
  return res.json();
};

export const getTrendNarrative = async (trend: Array<{ created_at: string; metrics: Record<string,number>; perf_status?: string }>): Promise<{ narrative: string }> => {
  const res = await f(`${RESULTS_URL}/ai/trend-narrative`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trend }),
  });
  if (!res.ok) { const b = await res.json().catch(() => ({})) as { error?: string }; throw new Error(b.error ?? `HTTP ${res.status}`); }
  return res.json();
};

export const suggestThresholds = async (url: string, type = 'backend'): Promise<{ suggestions: ThresholdSuggestion; runsAnalysed: number }> => {
  const res = await f(
    `${RESULTS_URL}/results/suggest-thresholds?url=${encodeURIComponent(url)}&type=${type}`,
    { cache: 'no-store' }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
};

export interface ThresholdPreview {
  available: boolean;
  perfStatus?: 'passed' | 'degraded' | 'failed';
  thresholdViolations?: string[];
  basedOn?: { testId: string; completedAt: string };
}

export const previewThresholds = async (url: string, type: string, thresholds: SLOThresholds): Promise<ThresholdPreview> => {
  const res = await f(
    `${RESULTS_URL}/results/preview-thresholds?url=${encodeURIComponent(url)}&type=${type}&thresholds=${encodeURIComponent(JSON.stringify(thresholds))}`,
    { cache: 'no-store' }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
};

const authJson = async (res: Response): Promise<SessionUser> => {
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
};

export const register = (email: string, password: string, teamName: string, name?: string): Promise<SessionUser> =>
  f(`${RESULTS_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, teamName, name }),
  }).then(authJson);

export const login = (email: string, password: string): Promise<SessionUser> =>
  f(`${RESULTS_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }).then(authJson);

export const logout = (): Promise<void> =>
  f(`${RESULTS_URL}/auth/logout`, { method: 'POST' }).then(() => undefined);

export const getMe = (): Promise<SessionUser> =>
  f(`${RESULTS_URL}/auth/me`).then(r => {
    if (!r.ok) throw new Error('Not authenticated');
    return r.json();
  });

export const switchTeam = (teamId: string): Promise<SessionUser> =>
  f(`${RESULTS_URL}/auth/switch-team`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId }),
  }).then(authJson);

export interface TeamMemberRow { userId: string; email: string; name: string | null; role: TeamRole }

export const getTeamMembers = (teamId: string): Promise<TeamMemberRow[]> =>
  f(`${RESULTS_URL}/teams/${teamId}/members`).then(r => r.json());

export const addTeamMember = (teamId: string, email: string, role: TeamRole = 'member'): Promise<{ success: boolean }> =>
  f(`${RESULTS_URL}/teams/${teamId}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, role }),
  }).then(async r => {
    if (!r.ok) {
      const body = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `HTTP ${r.status}`);
    }
    return r.json();
  });

export const updateTeamMemberRole = (teamId: string, userId: string, role: TeamRole): Promise<{ success: boolean }> =>
  f(`${RESULTS_URL}/teams/${teamId}/members/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  }).then(async r => {
    if (!r.ok) {
      const body = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `HTTP ${r.status}`);
    }
    return r.json();
  });

export const removeTeamMember = (teamId: string, userId: string): Promise<{ success: boolean }> =>
  f(`${RESULTS_URL}/teams/${teamId}/members/${userId}`, { method: 'DELETE' }).then(async r => {
    if (!r.ok) {
      const body = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `HTTP ${r.status}`);
    }
    return r.json();
  });

export const getTeamQuota = (teamId: string): Promise<{ quota: TeamQuota; usage: TeamUsage }> =>
  f(`${RESULTS_URL}/teams/${teamId}/quotas`).then(async r => {
    if (!r.ok) {
      const body = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `HTTP ${r.status}`);
    }
    return r.json();
  });

export const updateTeamQuota = (teamId: string, quota: Partial<TeamQuota>): Promise<{ quota: TeamQuota }> =>
  f(`${RESULTS_URL}/teams/${teamId}/quotas`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(quota),
  }).then(async r => {
    if (!r.ok) {
      const body = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `HTTP ${r.status}`);
    }
    return r.json();
  });

export interface AuditLogEntry {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string;
  createdAt: string;
  userEmail: string | null;
}

export const getAuditLog = (teamId: string): Promise<{ entries: AuditLogEntry[] }> =>
  f(`${RESULTS_URL}/teams/${teamId}/audit-log`).then(async r => {
    if (!r.ok) {
      const body = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `HTTP ${r.status}`);
    }
    return r.json();
  });

export interface EraseTeamDataResult {
  success: boolean;
  deleted: { testResults: number; scripts: number; schedules: number };
}

export const eraseTeamData = (teamId: string): Promise<EraseTeamDataResult> =>
  f(`${RESULTS_URL}/teams/${teamId}/data`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).then(async r => {
    if (!r.ok) {
      const body = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `HTTP ${r.status}`);
    }
    return r.json();
  });

// ── Organizations ────────────────────────────────────────────────────────────

export interface OrgMemberRow { userId: string; email: string; name: string | null; role: OrgRole }
export interface OrgTeamSummary { id: string; name: string; quota: TeamQuota; usage: TeamUsage }
export interface OrgDetail {
  org: { id: string; name: string; createdAt: string };
  members: OrgMemberRow[];
  teams: OrgTeamSummary[];
  role: OrgRole;
}

const orgJson = <T>() => async (r: Response): Promise<T> => {
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${r.status}`);
  }
  return r.json();
};

export const createOrg = (name: string): Promise<{ id: string; name: string; role: OrgRole }> =>
  f(`${RESULTS_URL}/orgs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(orgJson<{ id: string; name: string; role: OrgRole }>());

export const getOrg = (orgId: string): Promise<OrgDetail> =>
  f(`${RESULTS_URL}/orgs/${orgId}`).then(orgJson<OrgDetail>());

export const addOrgMember = (orgId: string, email: string, role: OrgRole = 'member'): Promise<{ success: boolean }> =>
  f(`${RESULTS_URL}/orgs/${orgId}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, role }),
  }).then(orgJson<{ success: boolean }>());

export const updateOrgMemberRole = (orgId: string, userId: string, role: OrgRole): Promise<{ success: boolean }> =>
  f(`${RESULTS_URL}/orgs/${orgId}/members/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  }).then(orgJson<{ success: boolean }>());

export const removeOrgMember = (orgId: string, userId: string): Promise<{ success: boolean }> =>
  f(`${RESULTS_URL}/orgs/${orgId}/members/${userId}`, { method: 'DELETE' }).then(orgJson<{ success: boolean }>());

export const createOrgTeam = (orgId: string, name: string): Promise<{ id: string; name: string; role: TeamRole }> =>
  f(`${RESULTS_URL}/orgs/${orgId}/teams`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(orgJson<{ id: string; name: string; role: TeamRole }>());

// ── Per-team API keys ──────────────────────────────────────────────────────────

export interface TeamApiKeyRow { id: string; name: string; createdAt: string; lastUsedAt: string | null; revoked: boolean }
export interface TeamApiKeyCreated { id: string; name: string; key: string; createdAt: string }

export const getTeamApiKeys = (teamId: string): Promise<TeamApiKeyRow[]> =>
  f(`${RESULTS_URL}/teams/${teamId}/api-keys`).then(orgJson<TeamApiKeyRow[]>());

export const createTeamApiKey = (teamId: string, name: string): Promise<TeamApiKeyCreated> =>
  f(`${RESULTS_URL}/teams/${teamId}/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(orgJson<TeamApiKeyCreated>());

export const revokeTeamApiKey = (teamId: string, keyId: string): Promise<{ success: boolean }> =>
  f(`${RESULTS_URL}/teams/${teamId}/api-keys/${keyId}`, { method: 'DELETE' }).then(orgJson<{ success: boolean }>());