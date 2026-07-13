export * from './aiProvider';
export * from './aiValidation';
export * from './contracts';

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
  p95?: number | undefined;            // ms — default 1000
  avg?: number | undefined;            // ms — default 500
  errorRate?: number | undefined;      // % — default 1
  serverErrorRate?: number | undefined;// % server (5xx) errors — default 1
  timeoutRate?: number | undefined;    // % timeout errors — default 1
  checksFailRate?: number | undefined; // % of k6 check() assertions allowed to fail — default 10 (i.e. ≥90% must pass)
  lcp?: number | undefined;            // ms — default 2500
  fcp?: number | undefined;            // ms — default 1800
  ttfb?: number | undefined;           // ms — default 800
  cls?: number | undefined;            // score — default 0.1
  inp?: number | undefined;            // ms — default 200 (Interaction to Next Paint)
  tbt?: number | undefined;            // ms — default 200 (Total Blocking Time)
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
  body?: string | undefined;
  headers?: Record<string, string> | undefined;
  extract?: Record<string, ExtractRule> | undefined; // variable_name → extraction rule
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
  thresholds?: SLOThresholds | undefined;
  steps?: FlowStep[] | undefined;
  envVars?: Record<string, string> | undefined;
  testData?: Array<Record<string, string>> | undefined; // inline data table — stored in test_results.test_data for re-run restoration
  csvData?: string | undefined;                          // base64-encoded CSV content
  csvFilename?: string | undefined;                      // original filename hint
  customScript?: string | undefined;                     // user-supplied k6 script; bypasses AI generation entirely
  setupFirstStep?: boolean | undefined;                  // flow tests only: run step 1 once via k6 setup() instead of every VU/iteration — for preconditions (e.g. login) that aren't the thing being measured
  projectId?: string | undefined;                        // set by api-service from session; filters DB scope
  workspaceId?: string | undefined;                      // optional sub-project grouping within a team
  createdAt: string;
}

export interface Workspace {
  id: string;
  teamId: string;
  name: string;
  description?: string | null;
  createdAt: string;
}

// 'realistic' is the open-model (arrival-rate) counterpart to 'load' — same
// steady-state intent, but k6 sends requests at a fixed rate instead of
// waiting for each response before the next one. Opt-in only: every AI
// suggestion/extraction path (chat, /suggest-settings) still only offers the
// original four, so existing behavior is untouched unless a user explicitly
// picks it in Advanced Settings.
export type LoadProfile = 'load' | 'spike' | 'capacity' | 'soak' | 'realistic';

/** Live-metrics chart aggregation window, in seconds. Admin-configurable via
 *  the Settings page (GET/PUT /system/live-metric-window) — applies to new
 *  tests only, not tests already running when the setting changes. */
export type LiveMetricWindowSec = 10 | 30 | 60;
export const DEFAULT_LIVE_METRIC_WINDOW_SEC: LiveMetricWindowSec = 30;

export interface HttpOptions {
  keepAlive?: boolean | undefined;             // default true in k6
  timeout?: string | undefined;                // per-request timeout, e.g. "30s"
  discardResponseBodies?: boolean | undefined; // skip body parsing — saves memory on large responses
}

export interface BackendTestOptions {
  vus: number;
  duration: string;
  rampUp?: string | undefined;
  profile?: LoadProfile | undefined;
  peakVus?: number | undefined;
  httpOptions?: HttpOptions | undefined;
  headers?: Record<string, string> | undefined; // custom request headers sent with every HTTP request
}

export interface ClientTestOptions {
  sessions: number;
  duration: string;
  collectWebVitals: boolean;
  headers?: Record<string, string> | undefined; // custom headers set via page.setExtraHTTPHeaders
  device?: string | undefined;                  // Puppeteer KnownDevices key (e.g. 'iPhone 13'); unset = no emulation (desktop viewport)
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
  thresholds?: SLOThresholds | undefined;
  scriptId?: string | undefined;       // set by workers; consumer saves it to test_results.script_id
  reusedScript?: boolean | undefined;  // set by workers; consumer saves it to test_results.reused_script
  projectId?: string | undefined;      // set by workers from test.projectId; consumer saves it to test_results.project_id
  startedAt: string;
  completedAt?: string | undefined;
  perfStatus?: 'passed' | 'degraded' | 'failed' | undefined;
  analysis?: AnalysisResult | undefined;
  executionLog?: string | undefined;   // ANSI-stripped, severity-prefixed lines joined by \n; capped at 5000 lines / 100 KB
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
  statusCodes?: Record<string, number> | undefined;
  errorBreakdown?: ErrorBreakdown | undefined;
  stepMetrics?: StepMetrics[] | undefined;
  // Count of k6 check() assertion invocations — separate from requestsFailed
  // (HTTP-status-based). A test can have requestsFailed: 0 yet still have
  // failing checks if the AI-written body/content assertions don't match.
  // Optional: absent for results recorded before this metric was tracked.
  checksTotal?: number | undefined;
  checksFailed?: number | undefined;
  // Set when a capacity/stress-profile test's abortOnFail threshold fired,
  // stopping k6 before it reached the configured duration/VUs — without this
  // the result page shows a run that's mysteriously shorter than requested
  // with no explanation. vusReached/vusTarget omitted if k6's summary output
  // didn't include a parseable vus/vus_max line (e.g. a very early abort).
  stoppedEarly?: {
    thresholds: string[]; // metric names that breached, e.g. ['http_req_duration', 'http_req_failed']
    vusReached?: number | undefined;
    vusTarget?: number | undefined;
  } | undefined;
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
  lcp?: number | undefined;   // undefined when PerformanceObserver never fired (e.g. non-paintable response)
  fid: number;
  cls?: number | undefined;   // undefined when PerformanceObserver never fired; note: genuine CLS=0 also maps to undefined
  ttfb?: number | undefined;  // undefined when navigation timing entry is absent (e.g. redirect / data: URL)
  fcp?: number | undefined;   // undefined when PerformanceObserver never fired
  inp?: number | undefined;              // Interaction to Next Paint (ms) — CWV since March 2024
  tbt?: number | undefined;              // Total Blocking Time (ms) — from Lighthouse
  tti?: number | undefined;              // Time to Interactive (ms) — from Lighthouse
  jsErrors?: number | undefined;         // JS errors thrown during page load
  longTaskCount?: number | undefined;    // Tasks >50ms blocking main thread
  domNodeCount?: number | undefined;     // DOM node count at load — from Lighthouse
  pageLoadCount?: number | undefined;    // Number of times the page was navigated/opened (sessions + Lighthouse audit)
  resourceBreakdown?: ResourceBreakdown | undefined;
  lighthouseScore?: LighthouseScore | undefined;
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
  generatedScript?: string | undefined;
  scriptId?: string | undefined;
  reusedScript?: boolean | undefined;
  scriptCacheKey?: string | undefined; // for flow tests: hash key used in test_scripts table
  cachedScript?: string | undefined;             // carried to ai-service when description comparison is needed
  cachedScriptDescription?: string | null | undefined; // stored description of the cached script
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
  /** % of requests in this window that returned an HTTP 4xx status */
  clientErrorRate: number;
  /** % of requests in this window that returned an HTTP 5xx status */
  serverErrorRate: number;
  stepMetrics?: LiveStepMetric[] | undefined;
}

// ── Flow Recording ────────────────────────────────────────────────────────────

/** A single captured HTTP exchange during a recording session */
export interface RecordedRequest {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | undefined;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody?: string | undefined; // only for JSON responses; used by AI correlation
  timestamp?: number | undefined;    // epoch ms when the request was initiated; used for think-time computation
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

// ── k6 script-generation thresholds ──────────────────────────────────────────
// Shared between ai-service (generateScript's prompt-embedded literal values)
// and api-service (buildK6Options's cache-hit re-injection) so the two
// independent k6 options.thresholds generation paths don't drift apart.

/**
 * Derives p90/p99 response-time budgets from a single p95 budget, so
 * generated scripts get k6 thresholds on all 3 percentiles instead of a
 * single p(95) cliff-edge — mirroring the p50/p90/p95/p99 already computed
 * and displayed in the platform's own results UI (`parser.ts`). p90 is
 * tighter (0.8x) since it's a less extreme percentile than p95; p99 is
 * looser (2x) to allow for tail latency without making every test fail on
 * a handful of slow outliers.
 */
export const deriveMultiPercentileThresholds = (p95: number): { p90: number; p99: number } => ({
  p90: Math.round(p95 * 0.8),
  p99: Math.round(p95 * 2),
});

// ── Deterministic performance analyser ───────────────────────────────────────
// Shared between results-service (fallback) and analyser-service (primary).

export type PerfStatus = 'passed' | 'degraded' | 'failed';

const BACKEND_THRESHOLDS = {
  p95ResponseTime: 1000,
  avgResponseTime: 500,
  errorRate: 1,
  checksFailRate: 10, // % — i.e. ≥90% of check() assertions must pass
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
    checksFailRate:  thresholds?.checksFailRate ?? BACKEND_THRESHOLDS.checksFailRate,
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

  // checksTotal is only present when the executed script actually reported k6
  // check() results (parser only sets it when > 0) — absent for historical
  // results predating this metric, which must not be flagged as a violation.
  if (current.checksTotal) {
    const checksFailRate = ((current.checksFailed ?? 0) / current.checksTotal) * 100;
    if (checksFailRate > t.checksFailRate)
      thresholdViolations.push(`${checksFailRate.toFixed(2)}% of checks failed, exceeding threshold ${t.checksFailRate}% — response status looked fine but content/body assertions did not match`);
  }

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

  if (current.lcp  != null && current.lcp  > t.lcp)  thresholdViolations.push(`LCP ${Math.round(current.lcp)}ms exceeds threshold ${t.lcp}ms`);
  if (current.fcp  != null && current.fcp  > t.fcp)  thresholdViolations.push(`FCP ${Math.round(current.fcp)}ms exceeds threshold ${t.fcp}ms`);
  if (current.ttfb != null && current.ttfb > t.ttfb) thresholdViolations.push(`TTFB ${Math.round(current.ttfb)}ms exceeds threshold ${t.ttfb}ms`);
  if (current.cls  != null && current.cls  > t.cls)  thresholdViolations.push(`CLS ${current.cls.toFixed(3)} exceeds threshold ${t.cls}`);
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
      const curr = current[key];
      const prev = previous[key];
      if (curr == null || !prev) continue;
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
    ? analyzeBackend(currentMetrics, previousMetrics as BackendMetrics | null, thresholds)
    : analyzeClient(currentMetrics,  previousMetrics as ClientMetrics  | null, thresholds);

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

/**
 * Buffers items pushed via the returned `push()` and flushes them through
 * `send()` either once `maxBatchSize` is reached or after `flushIntervalMs`
 * of inactivity since the first buffered item — whichever comes first. Used
 * by worker-backend/worker-client to batch per-line execution-log POSTs
 * instead of firing one HTTP request per stdout/stderr line.
 */
export function createBatcher<T>(
  send: (batch: T[]) => void,
  options: { maxBatchSize?: number; flushIntervalMs?: number } = {},
): { push: (item: T) => void; flush: () => void } {
  const maxBatchSize = options.maxBatchSize ?? 50;
  const flushIntervalMs = options.flushIntervalMs ?? 300;
  let pending: T[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    send(batch);
  };

  const push = (item: T): void => {
    pending.push(item);
    if (pending.length >= maxBatchSize) {
      flush();
    } else if (!timer) {
      timer = setTimeout(flush, flushIntervalMs);
    }
  };

  return { push, flush };
}

/**
 * Polls `getCount()` until it reaches 0 or `timeoutMs` elapses. Used by
 * worker-backend/worker-client's SIGTERM handlers to let in-flight test
 * executions finish before the process exits, instead of a scale-down
 * killing them mid-run and having RabbitMQ redeliver (and duplicate) the work.
 */
export async function drainInFlight(getCount: () => number, timeoutMs: number, pollMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (getCount() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
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

// ── Session cookie ──────────────────────────────────────────────────────────
// results-service (issuer) and api-service (reader) must agree on the cookie
// name without importing from each other, so it's computed here from the same
// env vars both already read independently.

/**
 * The `__Host-` prefix (RFC 6265bis) locks a cookie to Secure + Path=/ + no
 * Domain attribute, blocking a compromised sibling subdomain from forging a
 * session cookie for the whole parent domain. It's only usable when DOMAIN is
 * unset (single-origin deployment) — the documented production topology
 * shares one cookie across UI/api/data subdomains via a Domain attribute,
 * which `__Host-` explicitly forbids, so prod keeps the plain name.
 */
export const getSessionCookieName = (): string =>
  process.env.NODE_ENV === 'production' && !process.env.DOMAIN ? '__Host-alt_session' : 'alt_session';

/**
 * A session with no activity for this long is treated as expired, independent
 * of its 30-day absolute TTL — shared by results-service and api-service, both
 * of which independently read/touch the same `sessions.last_seen_at` column,
 * so both must agree on the threshold.
 */
export const SESSION_IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** Throttles last_seen_at writes so every authenticated request isn't a DB write. */
export const SESSION_LAST_SEEN_TOUCH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ── SSRF guard ──────────────────────────────────────────────────────────────
// RFC-1918 + link-local + loopback + Docker-internal SSRF blocklist.
// Shared by recorder-service (recording target URLs) and results-service
// (webhook URLs) — anywhere a server-side fetch/navigation is driven by a
// user-supplied URL.
const SSRF_BLOCKED_HOSTNAME_RE = /^(localhost|.*\.local|host\.docker\.internal|.*\.internal|metadata\.google\.internal)$/i;
const SSRF_PRIVATE_IPV4_RE = /^(0\.0\.0\.0|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|127\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+)$/;

/** True for a bracketed IPv6 literal hostname as produced by the WHATWG URL parser, e.g. "[::1]". */
const isIpv6Literal = (host: string): boolean => host.startsWith('[') && host.endsWith(']');

/** Parses the first (leftmost) hextet of a bracket-stripped IPv6 address as a 0-65535 integer. "" (from a leading "::") is 0. */
const firstHextet = (addr: string): number => {
  const first = addr.split(':')[0]!; // .split() always returns at least one element
  return first === '' ? 0 : parseInt(first, 16);
};

/** Checks a bracket-stripped IPv6 literal (e.g. "::1", "fc00::1", "::ffff:a9fe:a9fe") against blocked ranges. */
const isPrivateIpv6 = (rawAddr: string): boolean => {
  const addr = rawAddr.toLowerCase();
  if (addr === '::1' || addr === '::') return true; // loopback / unspecified
  const hex = firstHextet(addr);
  if (hex >= 0xfe80 && hex <= 0xfebf) return true; // link-local fe80::/10
  if (hex >= 0xfc00 && hex <= 0xfdff) return true; // unique-local fc00::/7
  // IPv4-mapped: "::ffff:a.b.c.d" (dotted) or "::ffff:xxxx:yyyy" (hex, post-URL-normalization)
  const dotted = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return SSRF_PRIVATE_IPV4_RE.test(dotted[1]!); // capture group 1 is required by the pattern
  const hexPair = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexPair) {
    const hi = parseInt(hexPair[1]!, 16); // capture groups 1 and 2 are required by the pattern
    const lo = parseInt(hexPair[2]!, 16);
    return SSRF_PRIVATE_IPV4_RE.test([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.'));
  }
  return false;
};

/** Returns an error message if `raw` is unsafe to fetch/navigate to server-side (private/internal/link-local target), or null if it's safe. */
export const validateSsrfSafeUrl = (raw: string): string | null => {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return 'Invalid URL'; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'URL must use http or https';
  // Strip a trailing dot (FQDN notation) before matching — DNS/the OS resolver
  // treats "localhost." identically to "localhost", but the anchored blocklist
  // regexes below would not match it without this normalization.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (isIpv6Literal(host)) {
    return isPrivateIpv6(host.slice(1, -1)) ? 'URL targets a private/internal IP range' : null;
  }
  if (SSRF_BLOCKED_HOSTNAME_RE.test(host)) return 'URL targets a blocked internal hostname';
  if (SSRF_PRIVATE_IPV4_RE.test(host)) return 'URL targets a private/internal IP range';
  return null;
};

/**
 * Fetches `url` with SSRF protection that goes beyond a one-time
 * `validateSsrfSafeUrl` check at creation time:
 *  - Re-validates the hostname/IP on every call, not just once when a
 *    webhook/log-source was created — closes the DNS-rebinding gap where a
 *    hostname resolves to a public IP at creation time and is repointed at
 *    an internal/metadata IP before it's actually fetched.
 *  - Resolves the hostname via DNS and validates the resolved address too
 *    (not just the literal string), so a hostname that only *becomes*
 *    private after a DNS change is still caught.
 *  - Follows redirects manually, re-running both checks on every hop —
 *    `fetch()`'s default `redirect: 'follow'` would otherwise reach an
 *    internal target via a 302 without ever revalidating the final URL.
 * Dynamically imports `dns/promises` (matching aiProvider.ts's pattern for
 * other Node-only dependencies in this package) so this file stays safe to
 * bundle for the browser (UI) — the import is never reached unless this
 * function is actually called, which only happens server-side.
 */
export const fetchSsrfSafe = async (url: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> => {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validationError = validateSsrfSafeUrl(current);
    if (validationError) throw new Error(`SSRF check failed: ${validationError}`);

    const parsed = new URL(current);
    if (!isIpv6Literal(parsed.hostname)) {
      const { lookup } = await import('dns/promises');
      try {
        const addresses = await lookup(parsed.hostname, { all: true });
        const blocked = addresses.some((a) => (a.family === 6 ? isPrivateIpv6(a.address) : SSRF_PRIVATE_IPV4_RE.test(a.address)));
        if (blocked) throw new Error('SSRF check failed: hostname resolves to a private/internal IP');
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('SSRF check failed')) throw err;
        throw new Error(`SSRF check failed: could not resolve hostname (${(err as Error).message})`);
      }
    }

    const res = await fetch(current, { ...init, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new Error('SSRF check failed: too many redirects');
};