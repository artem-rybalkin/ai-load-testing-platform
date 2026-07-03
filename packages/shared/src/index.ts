export * from './aiProvider';
export * from './aiValidation';

/** Strip ANSI escape codes from a string (safe to call on every log line). */
export const stripAnsi = (s: string): string =>
  s.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');

export type TestType = 'backend' | 'client-side' | 'flow';

export type TestStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

// ── Auth / Teams / RBAC ───────────────────────────────────────────────────────

export type TeamRole = 'admin' | 'member' | 'viewer';

export interface TeamMembership {
  id: string;
  name: string;
  role: TeamRole;
}

// ── Organizations ────────────────────────────────────────────────────────────

export type OrgRole = 'owner' | 'admin' | 'member';

export interface OrgMembership {
  id: string;
  name: string;
  role: OrgRole;
}

/** Returned by /auth/register, /auth/login, /auth/me, /auth/switch-team */
export interface SessionUser {
  id: string;
  email: string;
  name?: string | null;
  teams: TeamMembership[];
  currentTeamId: string | null;
  role: TeamRole | null;
  orgs: OrgMembership[];
}

// ── Team Quotas ────────────────────────────────────────────────────────────────

export interface TeamQuota {
  maxConcurrentTests: number;
  maxVusPerTest: number;
  maxTestDurationSeconds: number;
  maxScheduledTests: number;
  maxGeminiCallsPerDay: number;
}

export const DEFAULT_TEAM_QUOTA: TeamQuota = {
  maxConcurrentTests: 5,
  maxVusPerTest: 1000,
  maxTestDurationSeconds: 3600,
  maxScheduledTests: 10,
  maxGeminiCallsPerDay: 100,
};

export interface TeamUsage {
  concurrentTests: number;
  scheduledTests: number;
  geminiCallsToday: number;
}

export interface SLOThresholds {
  p95?: number;            // ms — default 1000
  avg?: number;            // ms — default 500
  errorRate?: number;      // % — default 1
  serverErrorRate?: number;// % server (5xx) errors — default 1
  timeoutRate?: number;    // % timeout errors — default 1
  lcp?: number;            // ms — default 2500
  fcp?: number;            // ms — default 1800
  ttfb?: number;           // ms — default 800
  cls?: number;            // score — default 0.1
  inp?: number;            // ms — default 200 (Interaction to Next Paint)
  tbt?: number;            // ms — default 200 (Total Blocking Time)
}

export interface ErrorBreakdown {
  success: number;      // 2xx
  clientError: number;  // 4xx
  serverError: number;  // 5xx
  timeout: number;      // connection/read timeout (error_code 1020, 1210)
  networkError: number; // connection refused, DNS failure (error_code 1010, 1050)
}

export type ExtractSource = 'jsonpath' | 'header' | 'cookie' | 'regex';

export interface ExtractRule {
  source: ExtractSource; // 'jsonpath' is the default/backwards-compatible mode
  expression: string;    // JSONPath expression, header name, cookie name, or regex pattern
}

export interface FlowStep {
  name: string;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: string;
  headers?: Record<string, string>;
  extract?: Record<string, ExtractRule>; // variable_name → extraction rule
}

export interface StepMetrics {
  name: string;
  avgResponseTime: number;
  p95ResponseTime: number;
  requestsTotal: number;
  requestsFailed: number;
}

export interface TestRequest {
  id: string;
  type: TestType;
  targetUrl: string;
  description: string;
  options: BackendTestOptions | ClientTestOptions;
  thresholds?: SLOThresholds;
  steps?: FlowStep[];
  envVars?: Record<string, string>;
  testData?: Array<Record<string, string>>; // inline data table — stored in test_results.test_data for re-run restoration
  csvData?: string;                          // base64-encoded CSV content
  csvFilename?: string;                      // original filename hint
  customScript?: string;                     // user-supplied k6 script; bypasses AI generation entirely
  projectId?: string;                        // set by api-service from session; filters DB scope
  workspaceId?: string;                      // optional sub-project grouping within a team
  createdAt: string;
}

export interface Workspace {
  id: string;
  teamId: string;
  name: string;
  description?: string | null;
  createdAt: string;
}

export type LoadProfile = 'load' | 'spike' | 'capacity' | 'soak';

/** Live-metrics chart aggregation window, in seconds. Admin-configurable via
 *  the Settings page (GET/PUT /system/live-metric-window) — applies to new
 *  tests only, not tests already running when the setting changes. */
export type LiveMetricWindowSec = 10 | 30 | 60;
export const DEFAULT_LIVE_METRIC_WINDOW_SEC: LiveMetricWindowSec = 10;

export interface HttpOptions {
  keepAlive?: boolean;             // default true in k6
  timeout?: string;                // per-request timeout, e.g. "30s"
  discardResponseBodies?: boolean; // skip body parsing — saves memory on large responses
}

export interface BackendTestOptions {
  vus: number;
  duration: string;
  rampUp?: string;
  profile?: LoadProfile;
  peakVus?: number;
  httpOptions?: HttpOptions;
  headers?: Record<string, string>; // custom request headers sent with every HTTP request
}

export interface ClientTestOptions {
  sessions: number;
  duration: string;
  collectWebVitals: boolean;
  headers?: Record<string, string>; // custom headers set via page.setExtraHTTPHeaders
}

// ── Chat-based "one prompt" test creation ───────────────────────────────────

/** Which input mode the user chose at the start of a chat session. */
export type ChatMode = 'english' | 'swagger' | 'context';

export type ChatAttachmentType = 'swagger_url' | 'documentation' | 'codebase' | 'har';

export interface ChatAttachment {
  type: ChatAttachmentType;
  /** URL for swagger_url; raw text for documentation/codebase; JSON string for har */
  content: string;
  filename?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  attachments?: ChatAttachment[];
}

export interface ParsedTestIntent {
  type: 'backend' | 'client-side';
  targetUrl: string;
  description: string;                            // human-readable summary; becomes TestRequest.description
  options: BackendTestOptions | ClientTestOptions;
  thresholds?: SLOThresholds;
}

export interface FlowTestConfig {
  steps: FlowStep[];
  targetUrl: string;
  description: string;
  options: BackendTestOptions;
  thresholds?: SLOThresholds;
}

export type ChatParseResponse =
  | { status: 'needsClarification'; question: string }
  | { status: 'ready'; config: ParsedTestIntent }
  | { status: 'flowReady'; flow: FlowTestConfig }
  | { status: 'redirectToFlowBuilder'; reason: string };

export interface AiInsights {
  narrative: string;
  anomalies: string[];
  rootCauses: string[];
  recommendations: string[];
  severity: 'critical' | 'warning' | 'info';
}

export interface MetricDiff {
  metric: string;
  current: number;
  previous: number;
  diffPercent: number;
  status: 'better' | 'same' | 'worse';
}

export interface AnalysisResult {
  perfStatus: 'passed' | 'degraded' | 'failed';
  diffs: MetricDiff[];
  summary: string;
  thresholdViolations: string[];
  aiInsights?: AiInsights;
}

export interface TestResult {
  testId: string;
  targetUrl: string;
  status: TestStatus;
  metrics: BackendMetrics | ClientMetrics;
  thresholds?: SLOThresholds;
  scriptId?: string;       // set by workers; consumer saves it to test_results.script_id
  reusedScript?: boolean;  // set by workers; consumer saves it to test_results.reused_script
  projectId?: string;      // set by workers from test.projectId; consumer saves it to test_results.project_id
  startedAt: string;
  completedAt?: string;
  perfStatus?: 'passed' | 'degraded' | 'failed';
  analysis?: AnalysisResult;
  executionLog?: string;   // ANSI-stripped, severity-prefixed lines joined by \n; capped at 5000 lines / 100 KB
}

export interface BackendMetrics {
  type: 'backend';
  requestsTotal: number;
  requestsFailed: number;
  avgResponseTime: number;
  p50ResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  rps: number;
  statusCodes?: Record<string, number>;
  errorBreakdown?: ErrorBreakdown;
  stepMetrics?: StepMetrics[];
}

export interface LighthouseScore {
  performance: number;    // 0-100
  accessibility: number;  // 0-100
  bestPractices: number;  // 0-100
  seo: number;            // 0-100
}

export interface ResourceBreakdown {
  jsSize: number;      // KB
  cssSize: number;     // KB
  imageSize: number;   // KB
  fontSize: number;    // KB
  xhrSize: number;     // KB
  totalSize: number;   // KB
  requestCount: number;
}

export interface ClientMetrics {
  type: 'client';
  lcp: number;
  fid: number;
  cls: number;
  ttfb: number;
  fcp: number;
  inp?: number;              // Interaction to Next Paint (ms) — CWV since March 2024
  tbt?: number;              // Total Blocking Time (ms) — from Lighthouse
  tti?: number;              // Time to Interactive (ms) — from Lighthouse
  jsErrors?: number;         // JS errors thrown during page load
  longTaskCount?: number;    // Tasks >50ms blocking main thread
  domNodeCount?: number;     // DOM node count at load — from Lighthouse
  pageLoadCount?: number;    // Number of times the page was navigated/opened (sessions + Lighthouse audit)
  resourceBreakdown?: ResourceBreakdown;
  lighthouseScore?: LighthouseScore;
}
export interface TestScript {
  id: string;
  targetUrl: string;
  testType: TestType;
  script: string;
  description?: string | null;
  usedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface EnrichedTestRequest extends TestRequest {
  generatedScript?: string;
  scriptId?: string;
  reusedScript?: boolean;
  scriptCacheKey?: string; // for flow tests: hash key used in test_scripts table
  cachedScript?: string;             // carried to ai-service when description comparison is needed
  cachedScriptDescription?: string | null; // stored description of the cached script
}

export interface LiveStepMetric {
  name: string;
  avgResponseTime: number;
  rps: number;
  errorRate: number;
}

export interface LiveMetricPoint {
  timestamp: string;
  vus: number;
  rps: number;
  avgResponseTime: number;
  errorRate: number;
  stepMetrics?: LiveStepMetric[];
}

// ── Flow Recording ────────────────────────────────────────────────────────────

/** A single captured HTTP exchange during a recording session */
export interface RecordedRequest {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody?: string; // only for JSON responses; used by AI correlation
  timestamp?: number;    // epoch ms when the request was initiated; used for think-time computation
}

/** Recording session state returned by the recorder-service */
export interface RecordingSession {
  id: string;
  status: 'active' | 'stopping' | 'completed' | 'error';
  noVncUrl: string;   // e.g. "http://localhost:6080"
  steps?: FlowStep[]; // populated after stop + AI correlation
  stepCount?: number; // live count while recording is active
  error?: string;
}

// ── Deterministic performance analyser ───────────────────────────────────────
// Shared between results-service (fallback) and analyser-service (primary).

export type PerfStatus = 'passed' | 'degraded' | 'failed';

const BACKEND_THRESHOLDS = {
  p95ResponseTime: 1000,
  avgResponseTime: 500,
  errorRate: 1,
};

const CLIENT_THRESHOLDS = {
  lcp:  2500,
  fcp:  1800,
  ttfb: 800,
  cls:  0.1,
  inp:  200,
  tbt:  200,
};

const LIGHTHOUSE_THRESHOLD_PERFORMANCE = 50;

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

  if (current.p95ResponseTime > t.p95ResponseTime)
    thresholdViolations.push(`p95 response time ${Math.round(current.p95ResponseTime)}ms exceeds threshold ${t.p95ResponseTime}ms`);
  if (current.avgResponseTime > t.avgResponseTime)
    thresholdViolations.push(`avg response time ${Math.round(current.avgResponseTime)}ms exceeds threshold ${t.avgResponseTime}ms`);
  if (currentErrorRate > t.errorRate)
    thresholdViolations.push(`error rate ${currentErrorRate.toFixed(2)}% exceeds threshold ${t.errorRate}%`);

  if (current.errorBreakdown && total > 0) {
    const serverRate  = (current.errorBreakdown.serverError / total) * 100;
    const timeoutRate = (current.errorBreakdown.timeout     / total) * 100;
    if (serverRate  > t.serverErrorRate) thresholdViolations.push(`server error rate (5xx) ${serverRate.toFixed(2)}% exceeds threshold ${t.serverErrorRate}%`);
    if (timeoutRate > t.timeoutRate)     thresholdViolations.push(`timeout rate ${timeoutRate.toFixed(2)}% exceeds threshold ${t.timeoutRate}%`);
  }

  if (previous) {
    const keys: Array<{ key: keyof BackendMetrics; label: string }> = [
      { key: 'avgResponseTime', label: 'Avg response time' },
      { key: 'p95ResponseTime', label: 'p95 response time' },
      { key: 'p99ResponseTime', label: 'p99 response time' },
      { key: 'rps',             label: 'Requests/sec' },
    ];
    for (const { key, label } of keys) {
      const curr = current[key] as number;
      const prev = previous[key] as number;
      if (!prev) continue;
      const rawDiff    = ((curr - prev) / prev) * 100;
      const diffPercent = key === 'rps' ? -rawDiff : rawDiff;
      diffs.push({ metric: label, current: Math.round(curr * 10) / 10, previous: Math.round(prev * 10) / 10, diffPercent: Math.round(rawDiff * 10) / 10, status: getDiffStatus(diffPercent) });
    }
  }

  const hasFailures    = thresholdViolations.length > 0;
  const hasDegradation = diffs.some(d => d.status === 'worse' && Math.abs(d.diffPercent) > 20);
  const perfStatus     = hasFailures ? 'failed' : hasDegradation ? 'degraded' : 'passed';
  const summary        = perfStatus === 'passed'
    ? previous ? 'Performance is good and stable compared to previous run' : 'Performance is within acceptable thresholds'
    : perfStatus === 'degraded' ? 'Performance has degraded compared to previous run'
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
    inp:  thresholds?.inp  ?? CLIENT_THRESHOLDS.inp,
    tbt:  thresholds?.tbt  ?? CLIENT_THRESHOLDS.tbt,
  };

  const thresholdViolations: string[] = [];
  const diffs: MetricDiff[] = [];

  if (current.lcp  > t.lcp)  thresholdViolations.push(`LCP ${Math.round(current.lcp)}ms exceeds threshold ${t.lcp}ms`);
  if (current.fcp  > t.fcp)  thresholdViolations.push(`FCP ${Math.round(current.fcp)}ms exceeds threshold ${t.fcp}ms`);
  if (current.ttfb > t.ttfb) thresholdViolations.push(`TTFB ${Math.round(current.ttfb)}ms exceeds threshold ${t.ttfb}ms`);
  if (current.cls  > t.cls)  thresholdViolations.push(`CLS ${current.cls.toFixed(3)} exceeds threshold ${t.cls}`);
  if (current.inp  != null && current.inp  > t.inp)  thresholdViolations.push(`INP ${Math.round(current.inp)}ms exceeds threshold ${t.inp}ms`);
  if (current.tbt  != null && current.tbt  > t.tbt)  thresholdViolations.push(`TBT ${Math.round(current.tbt)}ms exceeds threshold ${t.tbt}ms`);
  if (current.lighthouseScore && current.lighthouseScore.performance < LIGHTHOUSE_THRESHOLD_PERFORMANCE)
    thresholdViolations.push(`Lighthouse performance score ${current.lighthouseScore.performance}/100 is below threshold (${LIGHTHOUSE_THRESHOLD_PERFORMANCE})`);

  if (previous) {
    const vitalKeys: Array<{ key: keyof Omit<ClientMetrics, 'type' | 'lighthouseScore' | 'resourceBreakdown'>; label: string }> = [
      { key: 'lcp', label: 'LCP' }, { key: 'fcp', label: 'FCP' },
      { key: 'ttfb', label: 'TTFB' }, { key: 'fid', label: 'FID' }, { key: 'cls', label: 'CLS' },
      { key: 'inp', label: 'INP' }, { key: 'tbt', label: 'TBT' },
    ];
    for (const { key, label } of vitalKeys) {
      const curr = current[key] as number;
      const prev = previous[key] as number;
      if (!prev) continue;
      const rawDiff = ((curr - prev) / prev) * 100;
      diffs.push({ metric: label, current: key === 'cls' ? Math.round(curr * 1000) / 1000 : Math.round(curr), previous: key === 'cls' ? Math.round(prev * 1000) / 1000 : Math.round(prev), diffPercent: Math.round(rawDiff * 10) / 10, status: getDiffStatus(rawDiff) });
    }
    if (current.lighthouseScore && previous.lighthouseScore) {
      const lhKeys: Array<{ key: keyof LighthouseScore; label: string }> = [
        { key: 'performance', label: 'Lighthouse performance' }, { key: 'accessibility', label: 'Lighthouse accessibility' },
        { key: 'bestPractices', label: 'Lighthouse best practices' }, { key: 'seo', label: 'Lighthouse SEO' },
      ];
      for (const { key, label } of lhKeys) {
        const curr = current.lighthouseScore[key];
        const prev = previous.lighthouseScore[key];
        if (!prev) continue;
        const rawDiff = ((curr - prev) / prev) * 100;
        diffs.push({ metric: label, current: curr, previous: prev, diffPercent: Math.round(rawDiff * 10) / 10, status: getDiffStatus(-rawDiff) });
      }
    }
  }

  const hasFailures    = thresholdViolations.length > 0;
  const hasDegradation = diffs.some(d => d.status === 'worse' && Math.abs(d.diffPercent) > 20);
  const perfStatus     = hasFailures ? 'failed' : hasDegradation ? 'degraded' : 'passed';
  const summary        = perfStatus === 'passed'
    ? previous ? 'Web Vitals are good and stable' : 'Web Vitals are within acceptable thresholds'
    : perfStatus === 'degraded' ? 'Web Vitals have degraded compared to previous run'
    : `Web Vitals issues: ${thresholdViolations[0]}`;

  return { perfStatus, diffs, summary, thresholdViolations };
};

export const analyzeResult = (
  currentMetrics: BackendMetrics | ClientMetrics,
  previousMetrics: BackendMetrics | ClientMetrics | null,
  thresholds?: SLOThresholds
): AnalysisResult =>
  currentMetrics.type === 'backend'
    ? analyzeBackend(currentMetrics as BackendMetrics, previousMetrics as BackendMetrics | null, thresholds)
    : analyzeClient(currentMetrics as ClientMetrics,  previousMetrics as ClientMetrics  | null, thresholds);

// ── PII detection / redaction ──────────────────────────────────────────────
//
// Used before sending recorded request/response bodies (or other free-text
// user data) to Gemini, so personal data captured during a recording session
// doesn't get forwarded to a third-party AI provider.

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const PHONE_RE = /\b(?:\+?\d{1,2}[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g;
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\b/g;
// Matches full 8-group IPv6 addresses and compressed forms containing "::"
// (e.g. "::1", "2001:db8::1", "fe80::1234:5678").
const IPV6_RE = /(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*)?::(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*)?/g;
// Candidate card numbers: 13-19 digits, optionally grouped with spaces/dashes
const CARD_CANDIDATE_RE = /\b(?:\d[ -]?){12,18}\d\b/g;

/** Luhn checksum — used to avoid flagging arbitrary numeric IDs as card numbers. */
function isValidLuhn(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

export type PiiCategory = 'email' | 'phone' | 'ssn' | 'creditCard' | 'ipAddress';

/** Replace PII matches in `text` with `[REDACTED_<CATEGORY>]` placeholders. */
export function redactPII(text: string): string {
  if (!text) return text;
  let result = text;
  result = result.replace(EMAIL_RE, '[REDACTED_EMAIL]');
  result = result.replace(SSN_RE, '[REDACTED_SSN]');
  result = result.replace(PHONE_RE, '[REDACTED_PHONE]');
  result = result.replace(CARD_CANDIDATE_RE, (match) => {
    const digits = match.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && isValidLuhn(digits)
      ? '[REDACTED_CARD]'
      : match;
  });
  result = result.replace(IPV4_RE, '[REDACTED_IP]');
  result = result.replace(IPV6_RE, '[REDACTED_IP]');
  return result;
}

/** Return the set of PII categories detected in `text`, without modifying it. */
export function detectPII(text: string): PiiCategory[] {
  if (!text) return [];
  const found = new Set<PiiCategory>();
  if (EMAIL_RE.test(text)) found.add('email');
  if (SSN_RE.test(text)) found.add('ssn');
  if (PHONE_RE.test(text)) found.add('phone');
  if (IPV4_RE.test(text)) found.add('ipAddress');
  if (IPV6_RE.test(text)) found.add('ipAddress');
  for (const match of text.match(CARD_CANDIDATE_RE) ?? []) {
    const digits = match.replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && isValidLuhn(digits)) {
      found.add('creditCard');
      break;
    }
  }
  // reset regex lastIndex state from global flags used with .test()
  EMAIL_RE.lastIndex = 0;
  SSN_RE.lastIndex = 0;
  PHONE_RE.lastIndex = 0;
  IPV4_RE.lastIndex = 0;
  IPV6_RE.lastIndex = 0;
  return Array.from(found);
}

// ── Unbounded capped-backoff connection supervisor ──────────────────────────
//
// Used by all queue-connected services (api-service, ai-service,
// worker-backend, worker-client, results-service) to connect/reconnect to
// RabbitMQ. Unlike a bounded retry loop, this never gives up: delays grow
// exponentially from `initialDelayMs` up to `maxDelayMs`, then hold steady,
// so the platform self-heals after a RabbitMQ outage of any length without
// operator intervention.

export interface BackoffOptions {
  /** Delay before the first retry, in ms. Default 1000. */
  initialDelayMs?: number;
  /** Upper bound on retry delay, in ms. Default 30000. */
  maxDelayMs?: number;
  /** Called after each failed attempt, before waiting `nextDelayMs`. */
  onRetry?: (err: Error, attempt: number, nextDelayMs: number) => void;
}

/** Repeatedly calls `connect()` until it resolves, waiting with capped exponential backoff between attempts. Never gives up. */
export async function connectWithBackoff<T>(connect: () => Promise<T>, options: BackoffOptions = {}): Promise<T> {
  const initialDelayMs = options.initialDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 30000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await connect();
    } catch (err) {
      const nextDelayMs = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
      options.onRetry?.(err as Error, attempt, nextDelayMs);
      await new Promise((resolve) => setTimeout(resolve, nextDelayMs));
    }
  }
}

// ── Internal service-to-service auth ────────────────────────────────────────
// Shared by api-service, ai-service, worker-backend, worker-client: every
// outbound HTTP call that targets results-service internal-callback endpoints
// must include X-Internal-Key when INTERNAL_API_KEY is set.

/** Returns headers for internal service-to-service calls, including X-Internal-Key when configured. */
export function internalHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    ...(process.env.INTERNAL_API_KEY ? { 'X-Internal-Key': process.env.INTERNAL_API_KEY } : {}),
    ...extra,
  };
}

// ── SSRF guard ──────────────────────────────────────────────────────────────
// RFC-1918 + link-local + loopback + Docker-internal SSRF blocklist.
// Shared by recorder-service (recording target URLs) and results-service
// (webhook URLs) — anywhere a server-side fetch/navigation is driven by a
// user-supplied URL.
const SSRF_BLOCKED_HOSTNAME_RE = /^(localhost|.*\.local|host\.docker\.internal|.*\.internal|metadata\.google\.internal)$/i;
const SSRF_PRIVATE_IPV4_RE = /^(0\.0\.0\.0|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|127\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+)$/;

/** Returns an error message if `raw` is unsafe to fetch/navigate to server-side (private/internal/link-local target), or null if it's safe. */
export const validateSsrfSafeUrl = (raw: string): string | null => {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return 'Invalid URL'; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'URL must use http or https';
  const host = parsed.hostname.toLowerCase();
  if (SSRF_BLOCKED_HOSTNAME_RE.test(host)) return 'URL targets a blocked internal hostname';
  if (SSRF_PRIVATE_IPV4_RE.test(host)) return 'URL targets a private/internal IP range';
  return null;
};