import {
  BackendMetrics, ClientMetrics, AiInsights, MetricDiff, StepMetrics,
  AiProviderSetting, DEFAULT_AI_PROVIDER_SETTING, generateAIText, isProviderConfigured,
} from '@alt/shared';
import { PerfStatus } from './analyzer';
import { log } from './logger';

const RESULTS_URL = process.env.RESULTS_URL || 'http://results-service:3004';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';
const PROVIDER_CACHE_MS = 30000;

const providerCache = new Map<string, { setting: AiProviderSetting; cachedAt: number }>();

/** Fetches the configured AI provider + fallback chain (team override or global default) from results-service, cached for 30s per team. */
const getProviderSetting = async (teamId?: string | null): Promise<AiProviderSetting> => {
  const cacheKey = teamId ?? '__global__';
  const cached = providerCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < PROVIDER_CACHE_MS) return cached.setting;
  try {
    const url = teamId
      ? `${RESULTS_URL}/system/ai-provider?teamId=${encodeURIComponent(teamId)}`
      : `${RESULTS_URL}/system/ai-provider`;
    const res = await fetch(url, {
      headers: INTERNAL_API_KEY ? { 'X-Internal-Key': INTERNAL_API_KEY } : {},
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json() as AiProviderSetting;
      const setting = { provider: data.provider, fallbacks: data.fallbacks };
      providerCache.set(cacheKey, { setting, cachedAt: Date.now() });
      return setting;
    }
  } catch {
    // results-service unreachable — keep using cached/default setting
  }
  return cached?.setting ?? DEFAULT_AI_PROVIDER_SETTING;
};

/** True if any provider in the primary+fallback chain has an API key configured. */
const isAnyProviderConfigured = (setting: AiProviderSetting): boolean =>
  [setting.provider, ...setting.fallbacks].some(isProviderConfigured);

interface ExternalMetricSource {
  sourceName: string;
  platform: string | null;
  data: string;
}

interface InsightsContext {
  targetUrl: string;
  type: string;
  metrics: BackendMetrics | ClientMetrics;
  previousMetrics: BackendMetrics | ClientMetrics | null;
  perfStatus: PerfStatus;
  summary: string;
  thresholdViolations: string[];
  diffs: MetricDiff[];
  externalMetrics?: ExternalMetricSource[];
  teamId?: string | null;
}

/** Normalised, size-capped payload used to build the Gemini prompt.
 *  Only fields the prompt actually uses are included; stepMetrics capped at
 *  top-5 by p95 to keep token count bounded; all times in ms, rates as %. */
interface BackendPromptMetrics {
  type: 'backend';
  requestsTotal: number;
  requestsFailed: number;
  errorRatePct: number;           // normalised: requestsFailed/requestsTotal × 100
  rps: number;
  avgResponseTimeMs: number;
  p50ResponseTimeMs: number;
  p95ResponseTimeMs: number;
  p99ResponseTimeMs: number;
  serverErrors?: number;
  clientErrors?: number;
  timeouts?: number;
  networkErrors?: number;
  topStepsByP95?: Pick<StepMetrics, 'name' | 'avgResponseTime' | 'p95ResponseTime'>[];
}

interface ClientPromptMetrics {
  type: 'client';
  lcpMs: number;
  fcpMs: number;
  ttfbMs: number;
  fidMs: number;
  inpMs?: number;
  tbtMs?: number;
  clsScore: number;
  lighthousePerformance?: number;
  lighthouseAccessibility?: number;
}

interface AnalysisPromptPayload {
  targetUrl: string;
  testType: string;
  perfStatus: PerfStatus;
  summary: string;
  thresholdViolations: string[];
  diffs: Array<Pick<MetricDiff, 'metric' | 'current' | 'previous' | 'diffPercent' | 'status'>>;
  metrics: BackendPromptMetrics | ClientPromptMetrics;
}

const buildPayload = (ctx: InsightsContext): AnalysisPromptPayload => {
  let metrics: BackendPromptMetrics | ClientPromptMetrics;
  if (ctx.metrics.type === 'backend') {
    const m = ctx.metrics as BackendMetrics;
    const total = m.requestsTotal || 1;
    metrics = {
      type: 'backend',
      requestsTotal: m.requestsTotal,
      requestsFailed: m.requestsFailed,
      errorRatePct: Math.round((m.requestsFailed / total) * 1000) / 10,
      rps: Math.round(m.rps * 100) / 100,
      avgResponseTimeMs: Math.round(m.avgResponseTime),
      p50ResponseTimeMs: Math.round(m.p50ResponseTime),
      p95ResponseTimeMs: Math.round(m.p95ResponseTime),
      p99ResponseTimeMs: Math.round(m.p99ResponseTime),
      ...(m.errorBreakdown ? {
        serverErrors:  m.errorBreakdown.serverError,
        clientErrors:  m.errorBreakdown.clientError,
        timeouts:      m.errorBreakdown.timeout,
        networkErrors: m.errorBreakdown.networkError,
      } : {}),
      ...(m.stepMetrics?.length ? {
        topStepsByP95: [...m.stepMetrics]
          .sort((a, b) => b.p95ResponseTime - a.p95ResponseTime)
          .slice(0, 5)
          .map(s => ({ name: s.name, avgResponseTime: Math.round(s.avgResponseTime), p95ResponseTime: Math.round(s.p95ResponseTime) })),
      } : {}),
    };
  } else {
    const m = ctx.metrics as ClientMetrics;
    metrics = {
      type: 'client',
      lcpMs:  Math.round(m.lcp),
      fcpMs:  Math.round(m.fcp),
      ttfbMs: Math.round(m.ttfb),
      fidMs:  Math.round(m.fid),
      clsScore: Math.round(m.cls * 1000) / 1000,
      ...(m.inp !== undefined ? { inpMs: Math.round(m.inp) } : {}),
      ...(m.tbt !== undefined ? { tbtMs: Math.round(m.tbt) } : {}),
      ...(m.lighthouseScore ? {
        lighthousePerformance:   m.lighthouseScore.performance,
        lighthouseAccessibility: m.lighthouseScore.accessibility,
      } : {}),
    };
  }

  return {
    targetUrl: ctx.targetUrl,
    testType:  ctx.type,
    perfStatus: ctx.perfStatus,
    summary: ctx.summary,
    thresholdViolations: ctx.thresholdViolations,
    diffs: ctx.diffs.map(d => ({ metric: d.metric, current: d.current, previous: d.previous, diffPercent: d.diffPercent, status: d.status })),
    metrics,
  };
};

const formatMetrics = (p: AnalysisPromptPayload): string => {
  if (p.metrics.type === 'backend') {
    const m = p.metrics;
    const lines = [
      `Total requests: ${m.requestsTotal}`,
      `Failed requests: ${m.requestsFailed} (${m.errorRatePct}%)`,
      `Throughput: ${m.rps} req/s`,
      `Avg response time: ${m.avgResponseTimeMs}ms`,
      `p50: ${m.p50ResponseTimeMs}ms`,
      `p95: ${m.p95ResponseTimeMs}ms`,
      `p99: ${m.p99ResponseTimeMs}ms`,
    ];
    if (m.serverErrors !== undefined)
      lines.push(`Error breakdown: ${m.serverErrors} server (5xx), ${m.clientErrors} client (4xx), ${m.timeouts} timeouts, ${m.networkErrors} network`);
    if (m.topStepsByP95?.length)
      lines.push(`Top steps by p95: ${m.topStepsByP95.map(s => `${s.name} avg=${s.avgResponseTime}ms p95=${s.p95ResponseTime}ms`).join(', ')}`);
    return lines.join('\n');
  } else {
    const m = p.metrics;
    const lines = [
      `LCP: ${m.lcpMs}ms (good <2500, needs-improvement <4000, poor ≥4000)`,
      `FCP: ${m.fcpMs}ms (good <1800, needs-improvement <3000, poor ≥3000)`,
      `TTFB: ${m.ttfbMs}ms (good <800, needs-improvement <1800, poor ≥1800)`,
      `CLS: ${m.clsScore} (good <0.1, needs-improvement <0.25, poor ≥0.25)`,
    ];
    if (m.inpMs !== undefined)
      lines.push(`INP: ${m.inpMs}ms (good <200, needs-improvement <500, poor ≥500)`);
    if (m.tbtMs !== undefined)
      lines.push(`TBT: ${m.tbtMs}ms (good <200, needs-improvement <600, poor ≥600)`);
    if (m.lighthousePerformance !== undefined)
      lines.push(`Lighthouse performance: ${m.lighthousePerformance}/100 (good ≥90, needs-improvement ≥50, poor <50), accessibility: ${m.lighthouseAccessibility}/100`);
    return lines.join('\n');
  }
};

const buildPrompt = (payload: AnalysisPromptPayload, externalMetrics?: ExternalMetricSource[]): string => {
  const isBackend = payload.metrics.type === 'backend';
  const isFlow = payload.testType === 'flow';

  const violationsText = payload.thresholdViolations.length > 0
    ? payload.thresholdViolations.map(v => `  - ${v}`).join('\n')
    : '  None';

  const diffsText = payload.diffs.length > 0
    ? payload.diffs.map(d => {
        const sign = d.diffPercent > 0 ? '+' : '';
        return `  - ${d.metric}: ${d.previous} → ${d.current} (${sign}${d.diffPercent}%) [${d.status}]`;
      }).join('\n')
    : '  No previous run available';

  const externalSection = externalMetrics && externalMetrics.length > 0
    ? `\n\nExternal Observability Data (from configured integrations — use this to enrich root cause analysis):\n${
        externalMetrics.map(e => `--- ${e.sourceName}${e.platform ? ` (${e.platform})` : ''} ---\n${e.data}`).join('\n\n')
      }`
    : '';

  const typeHint = isBackend
    ? isFlow
      ? `Root cause focus for multi-step flow tests: look at per-step p95 gaps (a single slow step drags the whole flow), connection reuse across steps, session token expiry causing auth failures in later steps, and downstream service fan-out effects.`
      : `Root cause focus for HTTP load tests: connection pool exhaustion (p99 >> p95 gap), slow DB queries under concurrency, GC pauses (periodic latency spikes), misconfigured keep-alive (high http_req_connecting), and thread/worker starvation at the target service.`
    : `Root cause focus for browser tests: render-blocking JS/CSS (high TBT/FCP), large unoptimised images (high LCP), layout thrash from dynamic content (high CLS), slow server response (high TTFB), and main-thread contention from third-party scripts (high INP/TBT).`;

  return `You are a senior performance engineer analyzing load test results. Provide expert insights based on the data below.${externalSection ? ' External observability data from your monitoring stack is included — correlate it with the load test metrics.' : ''}

Test Context:
- URL: ${payload.targetUrl}
- Test type: ${payload.testType} (${isBackend ? (isFlow ? 'k6 multi-step flow test' : 'k6 HTTP load test') : 'Puppeteer browser test'})

Current Metrics:
${formatMetrics(payload)}

Threshold Violations:
${violationsText}

Regression vs Previous Run:
${diffsText}

Overall Status: ${payload.perfStatus} — ${payload.summary}${externalSection}

${typeHint}

Respond ONLY with a valid JSON object (no markdown fences, no explanation outside the JSON):
{
  "narrative": "<2-3 sentences explaining what these results reveal about the system under test — not just repeating numbers>",
  "anomalies": ["<specific anomaly observed in the data>"],
  "rootCauses": ["<engineering root cause inferred from the data patterns>"],
  "recommendations": ["<concrete actionable engineering step>"],
  "severity": "<critical|warning|info>"
}

Rules:
- narrative: interpret what the numbers mean for real users or system stability; avoid phrases like "the test shows" — say what it implies
- anomalies: only list genuinely anomalous patterns (e.g. p99 > 3× p95 suggests GC pauses; error spike mid-test suggests connection pool exhaustion); empty array if all looks normal
- rootCauses: infer from data patterns only — do not invent causes without evidence in the metrics
- recommendations: specific engineering actions with measurable targets (e.g. "Enable HTTP connection keep-alive to reduce http_req_connecting from Xms", "Increase DB connection pool size above current concurrency of N VUs")
- severity: "critical" if failed status or >5% error rate, "warning" if degraded or threshold violated, "info" if all passed
- Keep each string under 120 characters

Example output (for reference — generate your own based on the actual data above):
{"narrative":"The API handled 500 req/s with p95 at 340ms, well within the 1000ms SLO. A p99 spike to 2800ms (+720%) suggests occasional GC pauses or connection pool contention at peak load.","anomalies":["p99 latency (2800ms) is 8× the p95 (340ms) — abnormal tail latency distribution"],"rootCauses":["GC pause or connection pool saturation causing occasional long waits at the 99th percentile"],"recommendations":["Profile GC activity during peak load; consider increasing JVM heap or connection pool size above 500"],"severity":"warning"}`;
};

export interface AiInsightsResult {
  insights: AiInsights | null;
  rateLimited: boolean;
}

export const generateAiInsights = async (ctx: InsightsContext): Promise<AiInsightsResult> => {
  const setting = await getProviderSetting(ctx.teamId);
  if (!isAnyProviderConfigured(setting)) {
    log.warn('No AI provider configured — skipping AI insights');
    return { insights: null, rateLimited: false };
  }

  const payload = buildPayload(ctx);
  const prompt = buildPrompt(payload, ctx.externalMetrics);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const text = (await generateAIText(prompt, setting)).trim();

      // Strip markdown fences if the model wraps the output
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      const parsed = JSON.parse(cleaned) as AiInsights;

      // Validate required fields
      if (
        typeof parsed.narrative === 'string' &&
        Array.isArray(parsed.anomalies) &&
        Array.isArray(parsed.rootCauses) &&
        Array.isArray(parsed.recommendations) &&
        ['critical', 'warning', 'info'].includes(parsed.severity)
      ) {
        log.info({ attempt }, 'AI insights generated');
        return { insights: parsed, rateLimited: false };
      }

      log.warn({ attempt, parsed }, 'AI insights response had unexpected shape');
      return { insights: null, rateLimited: false };
    } catch (err: unknown) {
      const msg = (err as Error).message ?? '';
      const status = (err as { status?: number }).status;

      if (status === 429 || msg.includes('429') || msg.includes('quota')) {
        log.warn({ attempt }, 'AI provider rate limited — skipping AI insights');
        return { insights: null, rateLimited: true };
      }

      if (err instanceof SyntaxError) {
        log.warn({ attempt }, 'AI insights JSON parse error — skipping');
        return { insights: null, rateLimited: false };
      }

      if (attempt < 2) {
        log.warn({ attempt, err: msg }, 'AI insights attempt failed, retrying');
        await new Promise(r => setTimeout(r, 3000));
      } else {
        log.error({ err: msg }, 'AI insights generation failed');
      }
    }
  }

  return { insights: null, rateLimited: false };
};
