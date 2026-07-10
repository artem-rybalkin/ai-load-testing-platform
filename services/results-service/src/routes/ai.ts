/**
 * AI-assist route plugin: cron, trend-narrative, suggest-settings,
 * webhook-noise, preset-name, param-suggestions, translate,
 * suggest-thresholds, preview-thresholds, diagnose, chat/parse.
 */
import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import type { SLOThresholds, BackendMetrics, ClientMetrics, ChatMessage, ChatAttachment, ChatMode } from '@alt/shared';
import { isProviderConfigured, generateAIText, extractAndParseAIJson, fenceUserContent, USER_DATA_INSTRUCTION, redactPII } from '@alt/shared';
import { checkGeminiQuota, checkAndIncrementGeminiUsage } from '../quotas';
import { getEffectiveAiProviderSetting } from '../settings';
import { analyzeResult } from '../analyzer';
import { fetchExternalMetrics } from '../externalMetrics';
import {
  getAiCapability,
  sendInternalError,
  buildEnglishPrompt,
  buildSwaggerPrompt,
  buildContextPrompt,
  isValidChatParseResponse,
  processAttachments,
  CHAT_HISTORY_LIMIT,
  MULTI_STEP_INTENT_RE,
  isValidCronResponse,
  isValidTrendNarrativeResponse,
  isValidSuggestSettingsResponse,
  isValidWebhookNoiseResponse,
  isValidPresetNameResponse,
  isValidParamSuggestionsResponse,
  isValidSuggestThresholdsResponse,
  isValidDiagnoseResponse,
} from './helpers';

export function aiRoutes(app: FastifyInstance, { pool, rPool }: { pool: Pool; rPool: Pool }): void {
  const AI_RATE_LIMIT_MAX = Number(process.env.AI_RATE_LIMIT_MAX) || 20;

  // ── POST /ai/cron ─────────────────────────────────────────────────────────
  app.post<{ Body: { phrase: string } }>(
    '/ai/cron',
    { config: { rateLimit: { max: AI_RATE_LIMIT_MAX, timeWindow: 60_000 } } },
    async (request, reply) => {
      const { phrase } = request.body;
      if (!phrase) return reply.code(400).send({ error: 'phrase is required' });
      const ai = await getAiCapability(pool);
      if (!ai.configured) return reply.code(503).send({ error: 'No AI provider configured' });
      const quotaError = await checkAndIncrementGeminiUsage(pool, request.projectId);
      if (quotaError) return reply.code(429).send({ error: quotaError });
      try {
        const text = (await ai.generateText(
          `Convert this plain-English schedule description to a standard cron expression (5 fields: minute hour day month weekday).
Also provide a short human-readable preview confirming when it runs. ${USER_DATA_INSTRUCTION}

Description: "${fenceUserContent('schedule_description', phrase)}"

Return ONLY valid JSON: {"cron": "* * * * *", "preview": "Every minute"}`,
        )).trim();
        const parsed = extractAndParseAIJson(text);
        if (!parsed || !isValidCronResponse(parsed)) return reply.code(500).send({ error: 'AI returned unexpected response' });
        return parsed;
      } catch (err) {
        return sendInternalError(request, reply, err, 'POST /ai/cron');
      }
    },
  );

  // ── POST /ai/trend-narrative ──────────────────────────────────────────────
  app.post<{ Body: { trend: Array<{ created_at: string; metrics: Record<string, number>; perf_status?: string }> } }>(
    '/ai/trend-narrative',
    { config: { rateLimit: { max: AI_RATE_LIMIT_MAX, timeWindow: 60_000 } } },
    async (request, reply) => {
      const { trend } = request.body;
      if (!trend || trend.length < 3) return reply.code(422).send({ error: 'Need at least 3 trend points' });
      const ai = await getAiCapability(pool);
      if (!ai.configured) return reply.code(503).send({ error: 'No AI provider configured' });
      const quotaError = await checkGeminiQuota(pool, request.projectId);
      if (quotaError) return reply.code(429).send({ error: quotaError });
      try {
        const summary = trend.map(t => ({
          date: t.created_at,
          p95: t.metrics.p95ResponseTime ?? t.metrics.p95_response_time,
          rps: t.metrics.rps,
          perfStatus: t.perf_status,
        }));
        const text = (await ai.generateText(
          `You are a performance engineer. Write a 2-sentence plain-English summary of this load test trend. Focus on what changed and what it means for the system.

Trend data (chronological):
${JSON.stringify(summary, null, 2)}

Return ONLY valid JSON: {"narrative": "<2 sentences>"}`,
        )).trim();
        const parsed = extractAndParseAIJson(text);
        if (!parsed || !isValidTrendNarrativeResponse(parsed)) return reply.code(500).send({ error: 'AI returned unexpected response' });
        return parsed;
      } catch (err) {
        return sendInternalError(request, reply, err, 'POST /ai/trend-narrative');
      }
    },
  );

  // ── GET /results/suggest-settings ────────────────────────────────────────
  app.get<{ Querystring: { url: string; type?: string } }>(
    '/results/suggest-settings',
    { config: { rateLimit: { max: AI_RATE_LIMIT_MAX, timeWindow: 60_000 } } },
    async (request, reply) => {
      const { url, type = 'backend' } = request.query;
      if (!url) return reply.code(400).send({ error: 'url is required' });
      const ai = await getAiCapability(pool);
      if (!ai.configured) return reply.code(503).send({ error: 'No AI provider configured' });
      const quotaError = await checkAndIncrementGeminiUsage(pool, request.projectId);
      if (quotaError) return reply.code(429).send({ error: quotaError });
      try {
        const projectId = request.projectId ?? null;
        const { rows } = await pool.query(
          `SELECT metrics, perf_status FROM test_results
           WHERE target_url = $1 AND type = $2 AND status = 'completed'
             AND ($3::uuid IS NULL OR project_id = $3::uuid)
           ORDER BY created_at DESC LIMIT 5`,
          [url, type, projectId],
        );
        const history = rows.map((r: { metrics: Record<string, number>; perf_status: string }) => ({
          vus: r.metrics.vus, p95: r.metrics.p95ResponseTime, rps: r.metrics.rps, perfStatus: r.perf_status,
        }));
        const text = (await ai.generateText(
          `Suggest sensible load test settings for this URL: ${url}
Type: ${type}
${history.length > 0 ? `Recent run history:\n${JSON.stringify(history, null, 2)}` : 'No previous runs — suggest conservative defaults.'}

Return ONLY valid JSON:
{"vus": <number>, "duration": "<e.g. 1m>", "profile": "load|spike|soak|capacity", "reasoning": "<one sentence>"}`,
        )).trim();
        const parsed = extractAndParseAIJson(text);
        if (!parsed || !isValidSuggestSettingsResponse(parsed)) return reply.code(500).send({ error: 'AI returned unexpected response' });
        return parsed;
      } catch (err) {
        return sendInternalError(request, reply, err, 'GET /results/suggest-settings');
      }
    },
  );

  // ── POST /ai/webhook-noise ────────────────────────────────────────────────
  app.post<{ Body: { events: string[] } }>(
    '/ai/webhook-noise',
    { config: { rateLimit: { max: AI_RATE_LIMIT_MAX, timeWindow: 60_000 } } },
    async (request, reply) => {
      const { events } = request.body;
      if (!events?.length) return reply.code(400).send({ error: 'events is required' });
      const ai = await getAiCapability(pool);
      if (!ai.configured) return reply.code(503).send({ error: 'No AI provider configured' });
      const quotaError = await checkAndIncrementGeminiUsage(pool, request.projectId);
      if (quotaError) return reply.code(429).send({ error: quotaError });
      try {
        const projectId = request.projectId ?? null;
        const { rows } = await pool.query(
          `SELECT perf_status, COUNT(*) as count
           FROM test_results WHERE status = 'completed' AND perf_status IS NOT NULL
             AND ($1::uuid IS NULL OR project_id = $1::uuid)
           GROUP BY perf_status`,
          [projectId],
        );
        if (rows.length === 0) return { warning: null, message: 'Not enough run history to predict noise' };
        const dist = Object.fromEntries(rows.map((r: { perf_status: string; count: string }) => [r.perf_status, parseInt(r.count)]));
        const total = Object.values(dist).reduce((a: number, b: number) => a + b, 0);

        const text = (await ai.generateText(
          `Analyse this load test result distribution and predict whether a webhook firing on [${events.join(', ')}] would be too noisy or never fire.

Historical result distribution (${total} total runs):
${JSON.stringify(dist)}

Return ONLY valid JSON:
{"level": "noisy|ok|silent", "message": "<one sentence warning or confirmation>"}`,
        )).trim();
        const parsed = extractAndParseAIJson(text);
        if (!parsed || !isValidWebhookNoiseResponse(parsed)) return { warning: null };
        const { level, message } = parsed as { level: string; message: string };
        return { level, warning: level !== 'ok' ? message : null, message };
      } catch (err) {
        return sendInternalError(request, reply, err, 'POST /ai/webhook-noise');
      }
    },
  );

  // ── POST /ai/preset-name ──────────────────────────────────────────────────
  app.post<{ Body: { url: string; type: string; vus?: number; duration?: string; profile?: string; stepCount?: number } }>(
    '/ai/preset-name',
    { config: { rateLimit: { max: AI_RATE_LIMIT_MAX, timeWindow: 60_000 } } },
    async (request, reply) => {
      const { url, type, vus, duration, profile, stepCount } = request.body;
      const ai = await getAiCapability(pool);
      if (!ai.configured) return reply.code(503).send({ error: 'No AI provider configured' });
      const quotaError = await checkAndIncrementGeminiUsage(pool, request.projectId);
      if (quotaError) return reply.code(429).send({ error: quotaError });
      try {
        const text = (await ai.generateText(
          `Suggest a short, descriptive name and 2-3 tags for a load test preset with these settings. ${USER_DATA_INSTRUCTION}
URL: ${fenceUserContent('url', url || 'n/a')}, Type: ${type}, VUs: ${vus ?? 'n/a'}, Duration: ${duration ?? 'n/a'}, Profile: ${profile ?? 'load'}${stepCount ? `, Steps: ${stepCount}` : ''}

Name should be concise (max 50 chars), human-readable, and describe what is being tested.
Tags should be lowercase, single words or hyphenated (e.g. "e2e", "smoke", "auth-flow").

Return ONLY valid JSON: {"name": "<name>", "tags": ["tag1", "tag2"]}`,
        )).trim();
        const parsed = extractAndParseAIJson(text);
        if (!parsed || !isValidPresetNameResponse(parsed)) return reply.code(500).send({ error: 'AI returned unexpected response' });
        return parsed;
      } catch (err) {
        return sendInternalError(request, reply, err, 'POST /ai/preset-name');
      }
    },
  );

  // ── POST /ai/param-suggestions ────────────────────────────────────────────
  app.post<{ Body: { steps: Array<{ url: string; method: string; body?: string }> } }>(
    '/ai/param-suggestions',
    { config: { rateLimit: { max: AI_RATE_LIMIT_MAX, timeWindow: 60_000 } } },
    async (request, reply) => {
      const { steps } = request.body;
      if (!steps || steps.length === 0) return reply.code(400).send({ error: 'steps is required' });
      const ai = await getAiCapability(pool);
      if (!ai.configured) return reply.code(503).send({ error: 'No AI provider configured' });
      const quotaError = await checkAndIncrementGeminiUsage(pool, request.projectId);
      if (quotaError) return reply.code(429).send({ error: quotaError });
      try {
        const text = (await ai.generateText(
          `You are an expert in load testing. ${USER_DATA_INSTRUCTION} Analyse these HTTP steps and identify any hardcoded values in URLs or request bodies that should be parameterised (user IDs, emails, product IDs, search terms, session tokens, etc.).
Suggest test-data column names for a CSV/JSON data file.

Steps:
${fenceUserContent('flow_steps', redactPII(JSON.stringify(steps.slice(0, 20), null, 2)))}

Return ONLY valid JSON:
{"columns": ["column_name_1", "column_name_2"], "reasoning": "<one sentence>"}`,
        )).trim();
        const parsed = extractAndParseAIJson(text);
        if (!parsed || !isValidParamSuggestionsResponse(parsed)) return reply.code(500).send({ error: 'AI returned unexpected response' });
        return parsed;
      } catch (err) {
        return sendInternalError(request, reply, err, 'POST /ai/param-suggestions');
      }
    },
  );

  // ── POST /ai/translate ────────────────────────────────────────────────────
  app.post<{ Body: { script: string; targetUrl?: string } }>(
    '/ai/translate',
    { config: { rateLimit: { max: AI_RATE_LIMIT_MAX, timeWindow: 60_000 } } },
    async (request, reply) => {
      const { script, targetUrl } = request.body ?? {};
      if (!script || script.length > 256 * 1024) {
        return reply.code(400).send({ error: 'script is required and must be under 256 KB' });
      }
      const ai = await getAiCapability(pool);
      if (!ai.configured) return reply.code(503).send({ error: 'No AI provider configured' });
      const quotaError = await checkAndIncrementGeminiUsage(pool, request.projectId);
      if (quotaError) return reply.code(429).send({ error: quotaError });
      try {
        const text = (await ai.generateText(
          `You are an expert in both Playwright and k6. Translate the following Playwright test script into a k6 load test script. ${USER_DATA_INSTRUCTION}

Rules:
- Replace Playwright page.goto/click/fill with k6 http.get/post requests
- Use k6 check() for assertions on response status
- Keep the URL structure and request bodies intact
- Add realistic export const options = { vus: 5, duration: '1m' }
- Use http.batch() for concurrent requests if the test has parallel operations
- Replace page.waitFor with sleep() using realistic values
- Return ONLY the k6 JavaScript code, no markdown fences
${targetUrl ? `- Primary target URL: ${targetUrl}` : ''}

Playwright script to translate:
${fenceUserContent('playwright_script', script.slice(0, 8000))}`,
        )).trim();
        const k6Script = text.replace(/^```(?:javascript|js)?\s*/i, '').replace(/\s*```$/i, '').trim();
        if (!k6Script) return reply.code(500).send({ error: 'AI returned unexpected response' });
        return { k6Script };
      } catch (err) {
        return sendInternalError(request, reply, err, 'POST /ai/translate');
      }
    },
  );

  // ── GET /results/suggest-thresholds ──────────────────────────────────────
  app.get<{ Querystring: { url: string; type?: string } }>(
    '/results/suggest-thresholds',
    { config: { rateLimit: { max: AI_RATE_LIMIT_MAX, timeWindow: 60_000 } } },
    async (request, reply) => {
      const { url, type = 'backend' } = request.query;
      if (!url) return reply.code(400).send({ error: 'url is required' });
      const ai = await getAiCapability(pool);
      if (!ai.configured) return reply.code(503).send({ error: 'No AI provider configured' });
      const quotaError = await checkAndIncrementGeminiUsage(pool, request.projectId);
      if (quotaError) return reply.code(429).send({ error: quotaError });
      try {
        const projectId = request.projectId ?? null;
        const { rows } = await pool.query(
          `SELECT metrics, perf_status, created_at
           FROM test_results
           WHERE target_url = $1 AND type = $2 AND status = 'completed' AND metrics IS NOT NULL
             AND ($3::uuid IS NULL OR project_id = $3::uuid)
           ORDER BY created_at DESC LIMIT 10`,
          [url, type, projectId],
        );
        if (rows.length < 2) {
          return reply.code(422).send({ error: 'Not enough completed runs to suggest thresholds (need at least 2)' });
        }

        const history = rows.map((r: { metrics: Record<string, number>; perf_status: string; created_at: string }) => ({
          p95: r.metrics.p95ResponseTime ?? r.metrics.p95_response_time,
          avg: r.metrics.avgResponseTime ?? r.metrics.avg_response_time,
          errorRate: r.metrics.requestsTotal > 0
            ? ((r.metrics.requestsFailed / r.metrics.requestsTotal) * 100).toFixed(2)
            : '0',
          rps: r.metrics.rps,
          perfStatus: r.perf_status,
          date: r.created_at,
        }));

        const prompt = `You are a performance engineering expert. Based on the following load test history for ${url}, suggest SLO threshold values that are realistic but meaningful (not so loose they never fire, not so tight they always fire).

Test history (last ${rows.length} runs):
${JSON.stringify(history, null, 2)}

Return ONLY valid JSON with this shape (all times in ms, rates as %):
{
  "p95": <number>,
  "avg": <number>,
  "errorRate": <number>,
  "reasoning": "<one sentence explaining the choices>"
}`;

        const text = (await ai.generateText(prompt)).trim();
        const parsed = extractAndParseAIJson(text);
        if (!parsed || !isValidSuggestThresholdsResponse(parsed)) return reply.code(500).send({ error: 'AI returned unexpected response' });

        return { suggestions: parsed, runsAnalysed: rows.length };
      } catch (err) {
        return sendInternalError(request, reply, err, 'GET /results/suggest-thresholds');
      }
    },
  );

  // ── GET /results/preview-thresholds ──────────────────────────────────────
  app.get<{ Querystring: { url: string; type?: string; thresholds: string } }>(
    '/results/preview-thresholds',
    async (request, reply) => {
      const { url, type = 'backend', thresholds: thresholdsRaw } = request.query;
      if (!url) return reply.code(400).send({ error: 'url is required' });
      if (!thresholdsRaw) return reply.code(400).send({ error: 'thresholds is required' });

      let thresholds: SLOThresholds;
      try {
        thresholds = JSON.parse(thresholdsRaw);
      } catch {
        return reply.code(400).send({ error: 'thresholds must be valid JSON' });
      }

      const projectId = request.projectId ?? null;
      const { rows } = await pool.query(
        `SELECT test_id, metrics, completed_at
         FROM test_results
         WHERE target_url = $1 AND type = $2 AND status = 'completed' AND metrics IS NOT NULL
           AND ($3::uuid IS NULL OR project_id = $3::uuid)
         ORDER BY created_at DESC LIMIT 1`,
        [url, type, projectId],
      );

      if (rows.length === 0) {
        return { available: false };
      }

      const row = rows[0] as { test_id: string; metrics: BackendMetrics | ClientMetrics; completed_at: string };
      const { perfStatus, thresholdViolations } = analyzeResult(row.metrics, null, thresholds);

      return {
        available: true,
        perfStatus,
        thresholdViolations,
        basedOn: { testId: row.test_id, completedAt: row.completed_at },
      };
    },
  );

  // ── GET /results/:testId/diagnose ─────────────────────────────────────────
  app.get<{ Params: { testId: string } }>(
    '/results/:testId/diagnose',
    { config: { rateLimit: { max: AI_RATE_LIMIT_MAX, timeWindow: 60_000 } } },
    async (request, reply) => {
      const { testId } = request.params;
      const ai = await getAiCapability(pool);
      if (!ai.configured) return reply.code(503).send({ error: 'No AI provider configured' });

      const quotaError = await checkAndIncrementGeminiUsage(pool, request.projectId);
      if (quotaError) return reply.code(429).send({ error: quotaError });

      const projectId = request.projectId ?? null;
      const { rows } = await pool.query(
        `SELECT target_url, type, metrics, started_at, completed_at FROM test_results WHERE test_id = $1 AND ($2::uuid IS NULL OR project_id = $2::uuid)`,
        [testId, projectId],
      );
      if (rows.length === 0) return reply.code(404).send({ error: 'Result not found' });

      const { target_url, type, metrics, started_at, completed_at } = rows[0] as { target_url: string; type: string; metrics: Record<string, unknown>; started_at: string | null; completed_at: string | null };
      const externalMetrics = await fetchExternalMetrics(pool, target_url, started_at, completed_at, projectId);
      const eb = metrics.errorBreakdown as Record<string, number> | undefined;
      const total = (metrics.requestsTotal as number) || 1;

      const errorCount = !eb ? 0 : (eb.clientError ?? 0) + (eb.serverError ?? 0) + (eb.timeout ?? 0) + (eb.networkError ?? 0);
      if (!eb || errorCount === 0) {
        return { diagnoses: [], message: 'No errors to diagnose' };
      }

      const errorSummary = {
        targetUrl: target_url,
        testType: type,
        totalRequests: metrics.requestsTotal,
        errorBreakdown: eb,
        errorRates: {
          clientError:  `${((eb.clientError / total) * 100).toFixed(1)}%`,
          serverError:  `${((eb.serverError / total) * 100).toFixed(1)}%`,
          timeout:      `${((eb.timeout / total) * 100).toFixed(1)}%`,
          networkError: `${((eb.networkError / total) * 100).toFixed(1)}%`,
        },
        p95ResponseTime: metrics.p95ResponseTime,
        avgResponseTime: metrics.avgResponseTime,
      };

      try {
        const externalSection = externalMetrics.length > 0
          ? `\n\nExternal observability data (from configured integrations):\n${externalMetrics.map(e => `--- ${e.sourceName}${e.platform ? ` (${e.platform})` : ''} ---\n${fenceUserContent('external_metrics', e.data)}`).join('\n\n')}`
          : '';

        const prompt = `You are a performance engineering expert. A k6 load test produced the following error breakdown. Diagnose each non-zero error category with a likely root cause and one concrete next step.${externalSection ? ' Use the external observability data to enrich your diagnosis where relevant.' : ''}

Test data:
${JSON.stringify(errorSummary, null, 2)}${externalSection}

Return ONLY valid JSON array. Include only categories with count > 0:
[
  {
    "category": "serverError|clientError|timeout|networkError",
    "count": <number>,
    "likelyCause": "<one sentence>",
    "nextStep": "<one concrete action>"
  }
]`;

        const text = (await ai.generateText(prompt)).trim();
        const parsed = extractAndParseAIJson(text, 'array');
        if (!parsed || !isValidDiagnoseResponse(parsed)) return { diagnoses: [], message: 'AI returned unexpected response' };
        return { diagnoses: parsed };
      } catch (err) {
        return sendInternalError(request, reply, err, 'GET /results/:testId/diagnose');
      }
    },
  );

  // ── POST /chat/parse ──────────────────────────────────────────────────────
  // Uses getEffectiveAiProviderSetting (per-team aware), unlike the other AI
  // endpoints which use the global-only aiGenerateText() helper.
  app.post<{ Body: { messages: ChatMessage[]; attachments?: ChatAttachment[]; mode?: ChatMode } }>(
    '/chat/parse',
    { config: { rateLimit: { max: AI_RATE_LIMIT_MAX, timeWindow: 60_000 } } },
    async (request, reply) => {
      const { messages, attachments, mode = 'english' } = request.body ?? {};
      if (!Array.isArray(messages) || messages.length === 0) {
        return reply.code(400).send({ error: 'messages is required' });
      }

      const setting = await getEffectiveAiProviderSetting(pool, request.projectId);
      const configured = [setting.provider, ...setting.fallbacks].some(isProviderConfigured);
      if (!configured) return reply.code(503).send({ error: 'No AI provider configured' });

      const quotaError = await checkAndIncrementGeminiUsage(pool, request.projectId);
      if (quotaError) return reply.code(429).send({ error: quotaError });

      try {
        const attachmentContext = Array.isArray(attachments) && attachments.length > 0
          ? await processAttachments(attachments)
          : undefined;

        // Route to the focused prompt for the chosen mode
        let prompt: string;
        if (mode === 'swagger') {
          prompt = buildSwaggerPrompt(messages, attachmentContext ?? '[No spec provided — ask the user to paste or upload a Swagger/OpenAPI spec]');
        } else if (mode === 'context') {
          prompt = buildContextPrompt(messages, attachmentContext ?? '[No context provided — ask the user to upload a HAR file, documentation, or codebase snippet]');
        } else {
          // english mode (default) — also used as fallback for unknown mode values
          prompt = buildEnglishPrompt(messages);
        }

        const text = (await generateAIText(prompt, setting)).trim();
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return reply.code(500).send({ error: 'AI returned unexpected response' });
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(match[0]); } catch {
          return reply.code(500).send({ error: 'AI returned unexpected response' });
        }

        if (!isValidChatParseResponse(parsed)) {
          // Graceful fallback: if the AI attempted flowReady/redirect but with malformed output
          if (parsed.status === 'flowReady' || parsed.status === 'redirectToFlowBuilder') {
            if (mode === 'swagger' || mode === 'context') {
              return { status: 'needsClarification', question: 'I could not extract a complete flow from the provided context. Could you describe which endpoints or scenario you want to test?' };
            }
            return {
              status: 'redirectToFlowBuilder',
              reason: 'I identified a multi-step flow scenario. Please use the Flow Builder to define each step, or switch to Swagger or HAR mode so I can extract the endpoints automatically.',
            };
          }
          return reply.code(500).send({ error: 'AI returned unexpected response' });
        }

        // English mode only: deterministic guard against the AI collapsing a multi-step
        // flow into a single-URL "ready" response.
        if (mode === 'english' && parsed.status === 'ready') {
          const allText = messages.slice(-CHAT_HISTORY_LIMIT).map((m: { content: string }) => m.content).join('\n');
          if (MULTI_STEP_INTENT_RE.test(allText)) {
            return {
              status: 'redirectToFlowBuilder',
              reason: 'I detected a multi-step flow scenario. Please use the Flow Builder to define each step, or switch to Swagger or HAR · Docs mode to extract steps from a spec or recording.',
            };
          }
        }

        return parsed;
      } catch (err) {
        return sendInternalError(request, reply, err, 'POST /chat/parse');
      }
    },
  );

  // keep rPool in scope (used by suggest-settings / suggest-thresholds)
  void rPool;
}
