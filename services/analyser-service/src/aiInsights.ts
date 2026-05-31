import { GoogleGenerativeAI } from '@google/generative-ai';
import { BackendMetrics, ClientMetrics, AiInsights, MetricDiff } from '@alt/shared';
import { PerfStatus } from './analyzer';
import { log } from './logger';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

interface InsightsContext {
  targetUrl: string;
  type: string;
  metrics: BackendMetrics | ClientMetrics;
  previousMetrics: BackendMetrics | ClientMetrics | null;
  perfStatus: PerfStatus;
  summary: string;
  thresholdViolations: string[];
  diffs: MetricDiff[];
}

const formatBackendMetrics = (m: BackendMetrics): string => {
  const errorRate = m.requestsTotal > 0
    ? ((m.requestsFailed / m.requestsTotal) * 100).toFixed(2)
    : '0.00';
  const lines = [
    `Total requests: ${m.requestsTotal}`,
    `Failed requests: ${m.requestsFailed} (${errorRate}%)`,
    `Throughput: ${m.rps.toFixed(2)} req/s`,
    `Avg response time: ${Math.round(m.avgResponseTime)}ms`,
    `p50: ${Math.round(m.p50ResponseTime)}ms`,
    `p95: ${Math.round(m.p95ResponseTime)}ms`,
    `p99: ${Math.round(m.p99ResponseTime)}ms`,
  ];
  if (m.errorBreakdown) {
    const eb = m.errorBreakdown;
    const total = m.requestsTotal || 1;
    lines.push(`Error breakdown: ${eb.serverError} server errors (5xx), ${eb.clientError} client errors (4xx), ${eb.timeout} timeouts, ${eb.networkError} network errors`);
  }
  if (m.stepMetrics?.length) {
    lines.push(`Flow steps: ${m.stepMetrics.map(s => `${s.name} avg=${Math.round(s.avgResponseTime)}ms p95=${Math.round(s.p95ResponseTime)}ms`).join(', ')}`);
  }
  return lines.join('\n');
};

const formatClientMetrics = (m: ClientMetrics): string => {
  const lines = [
    `LCP: ${Math.round(m.lcp)}ms`,
    `FCP: ${Math.round(m.fcp)}ms`,
    `TTFB: ${Math.round(m.ttfb)}ms`,
    `FID: ${Math.round(m.fid)}ms`,
    `CLS: ${m.cls.toFixed(3)}`,
  ];
  if (m.lighthouseScore) {
    const lh = m.lighthouseScore;
    lines.push(`Lighthouse: performance=${lh.performance}/100, accessibility=${lh.accessibility}/100, best-practices=${lh.bestPractices}/100, seo=${lh.seo}/100`);
  }
  return lines.join('\n');
};

const buildPrompt = (ctx: InsightsContext): string => {
  const isBackend = ctx.metrics.type === 'backend';
  const metricsText = isBackend
    ? formatBackendMetrics(ctx.metrics as BackendMetrics)
    : formatClientMetrics(ctx.metrics as ClientMetrics);

  const violationsText = ctx.thresholdViolations.length > 0
    ? ctx.thresholdViolations.map(v => `  - ${v}`).join('\n')
    : '  None';

  const diffsText = ctx.diffs.length > 0
    ? ctx.diffs.map(d => {
        const sign = d.diffPercent > 0 ? '+' : '';
        return `  - ${d.metric}: ${d.previous} → ${d.current} (${sign}${d.diffPercent}%) [${d.status}]`;
      }).join('\n')
    : '  No previous run available';

  return `You are a senior performance engineer analyzing load test results. Provide expert insights based on the data below.

Test Context:
- URL: ${ctx.targetUrl}
- Test type: ${ctx.type} (${isBackend ? 'k6 HTTP load test' : 'Puppeteer browser test'})

Current Metrics:
${metricsText}

Threshold Violations:
${violationsText}

Regression vs Previous Run:
${diffsText}

Overall Status: ${ctx.perfStatus} — ${ctx.summary}

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

export const generateAiInsights = async (ctx: InsightsContext): Promise<AiInsights | null> => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    log.warn('GEMINI_API_KEY not set — skipping AI insights');
    return null;
  }

  const prompt = buildPrompt(ctx);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

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
        return parsed;
      }

      log.warn({ attempt, parsed }, 'AI insights response had unexpected shape');
      return null;
    } catch (err: unknown) {
      const msg = (err as Error).message ?? '';
      const status = (err as { status?: number }).status;

      if (status === 429 || msg.includes('429') || msg.includes('quota')) {
        log.warn({ attempt }, 'Gemini rate limited — skipping AI insights');
        return null;
      }

      if (err instanceof SyntaxError) {
        log.warn({ attempt }, 'AI insights JSON parse error — skipping');
        return null;
      }

      if (attempt < 2) {
        log.warn({ attempt, err: msg }, 'AI insights attempt failed, retrying');
        await new Promise(r => setTimeout(r, 3000));
      } else {
        log.error({ err: msg }, 'AI insights generation failed');
      }
    }
  }

  return null;
};
