import { GoogleGenerativeAI } from '@google/generative-ai';
import { BackendMetrics, ClientMetrics, AiInsights, MetricDiff, StepMetrics } from '@alt/shared';
import { PerfStatus } from './analyzer';
import { log } from './logger';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

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
      `LCP: ${m.lcpMs}ms`, `FCP: ${m.fcpMs}ms`, `TTFB: ${m.ttfbMs}ms`,
      `FID: ${m.fidMs}ms`, `CLS: ${m.clsScore}`,
    ];
    if (m.lighthousePerformance !== undefined)
      lines.push(`Lighthouse performance: ${m.lighthousePerformance}/100, accessibility: ${m.lighthouseAccessibility}/100`);
    return lines.join('\n');
  }
};

const buildPrompt = (payload: AnalysisPromptPayload, externalMetrics?: ExternalMetricSource[]): string => {
  const isBackend = payload.metrics.type === 'backend';

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

  return `You are a senior performance engineer analyzing load test results. Provide expert insights based on the data below.${externalSection ? ' External observability data from your monitoring stack is included — correlate it with the load test metrics.' : ''}

Test Context:
- URL: ${payload.targetUrl}
- Test type: ${payload.testType} (${isBackend ? 'k6 HTTP load test' : 'Puppeteer browser test'})

Current Metrics:
${formatMetrics(payload)}

Threshold Violations:
${violationsText}

Regression vs Previous Run:
${diffsText}

Overall Status: ${payload.perfStatus} — ${payload.summary}${externalSection}

Respond ONLY with a valid JSON object (no markdown fences, no explanation outside the JSON):
{
  "narrative": "<2-3 sentences explaining what these results reveal about the system under test — not just repeating numbers>",
  "anomalies": ["<specific anomaly observed in the data>"],
  "rootCauses": ["<engineering root cause inferred from the data patterns>"],
  "recommendations": ["<concrete actionable engineering step>"],
  "severity": "<critical|warning|info>"
}

Rules:
- narrative: interpret the data, explain what it means for the system health and user experience
- anomalies: only list genuinely anomalous patterns (e.g. high tail latency gap, error spike, low throughput); empty array if all looks normal
- rootCauses: infer from data patterns only — do not invent causes without evidence
- recommendations: specific engineering actions (e.g. "Enable HTTP connection keep-alive", "Profile slow DB queries above 500ms")
- severity: "critical" if failed status or >5% error rate, "warning" if degraded or threshold violated, "info" if all passed
- Keep each string under 120 characters`;
};

export interface AiInsightsResult {
  insights: AiInsights | null;
  rateLimited: boolean;
}

export const generateAiInsights = async (ctx: InsightsContext): Promise<AiInsightsResult> => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    log.warn('GEMINI_API_KEY not set — skipping AI insights');
    return { insights: null, rateLimited: false };
  }

  const payload = buildPayload(ctx);
  const prompt = buildPrompt(payload, ctx.externalMetrics);
  const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite' });

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text().trim();

      // Strip markdown fences if Gemini wraps the output
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
        log.warn({ attempt }, 'Gemini rate limited — skipping AI insights');
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
