/**
 * Shared helpers used across multiple route modules.
 * All exports are consumed by route plugins — nothing here registers routes.
 */
import { Pool } from 'pg';
import { FastifyRequest, FastifyReply } from 'fastify';
import type {
  SessionUser,
  TeamMembership,
  TeamRole,
  OrgMembership,
  OrgRole,
  ChatMessage,
  ChatAttachment,
  ChatMode,
  FlowStep,
} from '@alt/shared';
import {
  isProviderConfigured,
  generateAIText,
  coerceNumericValue,
  fenceUserContent,
  USER_DATA_INSTRUCTION,
  validateSsrfSafeUrl,
  fetchSsrfSafe,
} from '@alt/shared';
import { getAiProviderSetting } from '../settings';

// ── AI helpers ────────────────────────────────────────────────────────────────

/**
 * Fetches the globally-configured AI provider setting once and returns both
 * whether it's configured and a bound text-generator using that same
 * setting — every /ai/* route needs both, and calling isAiConfigured() then
 * aiGenerateText() separately meant two identical DB reads per request.
 */
export const getAiCapability = async (pool: Pool): Promise<{
  configured: boolean;
  generateText: (prompt: string) => Promise<string>;
}> => {
  const setting = await getAiProviderSetting(pool);
  const configured = [setting.provider, ...setting.fallbacks].some(isProviderConfigured);
  return { configured, generateText: (prompt: string) => generateAIText(prompt, setting) };
};

// ── Generic error helper ──────────────────────────────────────────────────────

/**
 * Logs the real error server-side and returns a generic message to the client —
 * an unhandled exception inside an AI/DB call must never leak raw internal error
 * text/stack traces to the caller.
 */
export const sendInternalError = (
  request: FastifyRequest,
  reply: FastifyReply,
  err: unknown,
  context: string,
): FastifyReply => {
  request.log.error({ err }, `${context} failed`);
  return reply.code(500).send({ error: 'Internal error — please try again' });
};

// ── Chat attachment processing ────────────────────────────────────────────────

const STATIC_ASSET_RE = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|mp4|mp3|pdf|map|xml|avif)(\?.*)?$/i;
const STATIC_MIME_RE = /^(image|font|video|audio)\//;
const HAR_ENTRY_CAP = 50;
const CONTEXT_CHAR_CAP = 4000;

/** Summarise a parsed OpenAPI/Swagger spec object into a compact endpoint list. */
const summarizeOpenApiSpec = (spec: Record<string, unknown>, sourceUrl?: string): string => {
  const paths = spec.paths as Record<string, unknown> | undefined;
  if (!paths || typeof paths !== 'object') return '[No paths found in spec]';

  const title = (spec.info as Record<string, unknown> | undefined)?.title ?? 'API';

  // Resolve the base URL so the AI can construct absolute step URLs
  let baseUrl = '';
  const servers = spec.servers as Array<{ url: string }> | undefined;
  if (servers?.[0]?.url) {
    baseUrl = servers[0].url.replace(/\/$/, '');
  } else {
    const host = spec.host as string | undefined;
    const basePath = ((spec.basePath as string | undefined) ?? '').replace(/\/$/, '');
    const schemes = spec.schemes as string[] | undefined;
    if (host) baseUrl = `${schemes?.[0] ?? 'http'}://${host}${basePath}`;
    else if (sourceUrl) { try { baseUrl = new URL(sourceUrl).origin; } catch { /* ignore */ } }
  }

  const lines: string[] = [`API: ${title}`, `Base URL: ${baseUrl}`];

  for (const [path, methods] of Object.entries(paths)) {
    if (!methods || typeof methods !== 'object') continue;
    for (const [method, op] of Object.entries(methods as Record<string, unknown>)) {
      if (method === 'parameters' || method === 'summary' || method === 'description') continue;
      const operation = op as Record<string, unknown>;
      const summary = (operation.summary ?? operation.description ?? '') as string;
      const reqBody = operation.requestBody as Record<string, unknown> | undefined;
      const bodyNote = reqBody ? ' (has request body)' : '';
      lines.push(`${method.toUpperCase()} ${baseUrl}${path}${summary ? ` — ${summary}` : ''}${bodyNote}`);
      if (lines.length >= 80) { lines.push('... (truncated)'); break; }
    }
    if (lines.length >= 80) break;
  }

  return lines.join('\n').slice(0, CONTEXT_CHAR_CAP);
};

const SWAGGER_UI_PATH_RE = /\/swagger-ui(?:\/|\.html|\.htm|$)/i;
const SPEC_DISCOVERY_PATHS = ['/v3/api-docs', '/swagger.json', '/api-docs', '/openapi.json', '/swagger/v1/swagger.json'];

/** Fetch and summarise a Swagger/OpenAPI URL into an endpoint list for the prompt. */
export const fetchAndSummarizeSwagger = async (url: string): Promise<string> => {
  const ssrfError = validateSsrfSafeUrl(url);
  if (ssrfError) return `[Swagger fetch blocked: ${ssrfError}]`;

  // When the URL looks like a Swagger UI viewer page (not the raw spec), try known
  // spec discovery paths before falling back to fetching the HTML page itself.
  try {
    const parsed = new URL(url);
    if (SWAGGER_UI_PATH_RE.test(parsed.pathname)) {
      const base = `${parsed.protocol}//${parsed.host}`;
      for (const specPath of SPEC_DISCOVERY_PATHS) {
        const specUrl = base + specPath;
        const specSsrfError = validateSsrfSafeUrl(specUrl);
        if (specSsrfError) continue;
        try {
          const specRes = await fetchSsrfSafe(specUrl, { signal: AbortSignal.timeout(5_000) });
          if (!specRes.ok) continue;
          const specText = await specRes.text();
          try {
            const spec = JSON.parse(specText) as Record<string, unknown>;
            if (spec.paths) return summarizeOpenApiSpec(spec, specUrl);
          } catch { /* not JSON */ }
        } catch { /* network error — try next path */ }
      }
      // None of the spec discovery paths worked — fall through to fetch the original URL
    }
  } catch { /* URL parse failed — proceed normally */ }

  try {
    const res = await fetchSsrfSafe(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return `[Swagger fetch failed: HTTP ${res.status}]`;

    const text = await res.text();

    try {
      const spec = JSON.parse(text) as Record<string, unknown>;
      return summarizeOpenApiSpec(spec, url);
    } catch {
      // Not valid JSON — pass raw text (may be YAML or HTML error page), capped
      return text.slice(0, CONTEXT_CHAR_CAP);
    }
  } catch (err) {
    return `[Swagger fetch error: ${(err as Error).message ?? 'timeout'}]`;
  }
};

/** Summarise HAR entries into a compact request list, filtering static assets. */
const summarizeHar = (harJson: string): string => {
  try {
    const har = JSON.parse(harJson) as { log?: { entries?: unknown[] } };
    const entries = har.log?.entries ?? [];

    const relevant = entries.filter((e: unknown) => {
      const entry = e as { request?: { url?: string }; response?: { content?: { mimeType?: string } } };
      const url = entry.request?.url ?? '';
      const mime = entry.response?.content?.mimeType ?? '';
      return !STATIC_ASSET_RE.test(url) && !STATIC_MIME_RE.test(mime);
    }).slice(0, HAR_ENTRY_CAP);

    if (relevant.length === 0) return '[No relevant HTTP requests found in HAR]';

    return relevant.map((e: unknown) => {
      const entry = e as {
        request: { method: string; url: string; postData?: { text?: string } };
        response: { status: number };
      };
      const body = entry.request.postData?.text
        ? ` body=${JSON.stringify(entry.request.postData.text).slice(0, 120)}`
        : '';
      return `${entry.request.method} ${entry.request.url} → ${entry.response.status}${body}`;
    }).join('\n').slice(0, CONTEXT_CHAR_CAP);
  } catch {
    return '[Error parsing HAR file — invalid JSON]';
  }
};

/**
 * Process all chat attachments and return a combined context string for the prompt.
 * Swagger URLs are fetched server-side; other types are summarised/truncated.
 */
export const processAttachments = async (attachments: ChatAttachment[]): Promise<string> => {
  if (attachments.length === 0) return '';

  const parts: string[] = [];

  for (const att of attachments) {
    if (att.type === 'swagger_url') {
      const summary = await fetchAndSummarizeSwagger(att.content);
      parts.push(`<swagger_spec${att.filename ? ` file="${att.filename}"` : ''}>\n${summary}\n</swagger_spec>`);
    } else if (att.type === 'har') {
      const summary = summarizeHar(att.content);
      parts.push(`<har_recording${att.filename ? ` file="${att.filename}"` : ''}>\n${summary}\n</har_recording>`);
    } else if (att.type === 'documentation') {
      parts.push(`<documentation${att.filename ? ` file="${att.filename}"` : ''}>\n${att.content.slice(0, CONTEXT_CHAR_CAP)}\n</documentation>`);
    } else if (att.type === 'codebase') {
      parts.push(`<codebase${att.filename ? ` file="${att.filename}"` : ''}>\n${att.content.slice(0, CONTEXT_CHAR_CAP)}\n</codebase>`);
    }
  }

  return parts.join('\n\n');
};

// ── Chat-parse helpers ────────────────────────────────────────────────────────

/** Most recent N messages to include in the chat-parse prompt. */
export const CHAT_HISTORY_LIMIT = 20;

/**
 * Detects clear multi-step flow intent in conversation text.
 * Used as a deterministic guard in English mode — overrides an AI "ready"
 * response when the user is clearly describing a sequence of HTTP operations.
 */
export const MULTI_STEP_INTENT_RE = /(?:\s->\s|\bthen\s+(?:login|logout|register|sign\s*(?:up|in)|checkout|create\s+account|delete|add\s+to\s+cart)\b|(?:register|sign[\s-]?up|create\s+account).{0,60}(?:login|sign[\s-]?in)|(?:login|sign[\s-]?in).{0,60}logout|\bscenario\s+for\b|\bflow\s+for\b)/i;

const FLOW_READY_SHAPE = `{"status": "flowReady", "flow": {
  "steps": [
    {"name": "<step name>", "url": "<FULL absolute URL>", "method": "GET|POST|PUT|DELETE|PATCH", "body": "<optional JSON string>", "headers": {}, "extract": {}},
    ...
  ],
  "targetUrl": "<base URL — hostname only, e.g. https://api.example.com>",
  "description": "<what this flow tests, including any assertion/check requirements>",
  "options": {"vus": <number>, "duration": "<e.g. 2m>", "rampUp": "<optional>", "profile": "load"|"spike"|"capacity"|"soak"},
  "thresholds": {"p95": <number>, "errorRate": <number>}
}}`;

const FLOW_READY_RULES = `Rules for "flowReady":
- Every step MUST have name, url (full absolute URL), and method. Include body only when the spec/recording indicates a request body.
- "targetUrl" is the base URL (hostname only) of the first step.
- "options.vus" and "options.duration" MUST be explicitly stated by the user — if not, return "needsClarification" instead.
- "thresholds" is optional — only include when the user mentioned performance targets.
- Every threshold value MUST be a plain JSON number (no unit suffix).
- CORRELATION IS MANDATORY BY DEFAULT — before finalizing steps, check every step for values a later step depends on. Common patterns to detect:
  1. Auth/session tokens: a login/auth response returns a token → later steps send "Authorization: Bearer {{token}}"
  2. Session/cart IDs: a response or path returns a session/cart identifier → later steps reuse it as {{sessionId}} in the URL or body
  3. Entity IDs: a "list"/"create" response returns an id (e.g. productId, orderId, userId) → a later step operating on that entity uses {{entityId}} instead of a hardcoded literal
  4. CSRF tokens / cookies returned by an earlier response → sent as a header/cookie on later steps
  For every value you detect, add an "extract" rule on the step that PRODUCES it ({"varName": {"source": "jsonpath"|"header"|"cookie"|"regex", "expression": "..."}}) and reference it as "{{varName}}" in the url/body/headers of every step that CONSUMES it. Never hardcode a literal ID/token/session value that a prior step's response could plausibly have produced — correlate it instead. Leave "extract": {} on a step only when nothing in its response is reused later.`;

const makeTranscript = (messages: ChatMessage[]): string =>
  messages
    .slice(-CHAT_HISTORY_LIMIT)
    .map(m => `${m.role.toUpperCase()}: ${fenceUserContent('user_message', m.content)}`)
    .join('\n');

/**
 * Mode: 'english' — pure conversational, single-URL backend/client-side test.
 * Produces: ready | needsClarification | redirectToFlowBuilder.
 * No attachment context; multi-step intent → redirect.
 */
export const buildEnglishPrompt = (messages: ChatMessage[]): string => {
  const transcript = makeTranscript(messages);
  return `You are an assistant that turns natural-language descriptions into load/performance test configurations. ${USER_DATA_INSTRUCTION}

Conversation so far:
${transcript}

Decide which ONE of the following outcomes applies and return ONLY valid JSON:

1. Return "ready" ONLY if ALL FOUR were explicitly stated somewhere in the conversation — never invent or silently default any of them:
   (a) a single target URL  (b) test type — backend or client-side  (c) a concrete number of users/VUs/sessions to simulate  (d) how long the test should run
   CRITICAL: NEVER return "ready" if the user's intent (in ANY turn of the conversation) involves multiple sequential HTTP operations — e.g. "register then login then logout", "login flow", "add to cart then checkout". Such requests are multi-step flows. Use outcome 3 instead, even if VUs/duration/type were provided later.
{"status": "ready", "config": {"type": "backend" | "client-side", "targetUrl": "<url>", "description": "<full description — see rules below>", "options": { ... }, "thresholds": { ... } }}
- backend options: {"vus": <n>, "duration": "<e.g. 1m>", "rampUp": "<optional>", "profile": "load"|"spike"|"capacity"|"soak"}
- client-side options: {"sessions": <n>, "duration": "<e.g. 1m>", "collectWebVitals": true}
- Signal words — backend: "API", "backend", "load test", "http test", "k6", "performance test", "endpoint". Client-side: "browser", "real browser", "page", "web vitals", "Lighthouse", "Puppeteer", "client-side".
- Threshold values MUST be plain JSON numbers ({"p95": 1000}, NOT {"p95": "1000ms"}).
- CRITICAL — "description" is passed verbatim to the k6 script generator. It MUST include the load shape AND ALL assertion/check requirements the user mentioned. Do NOT summarise or drop assertion details.

2. If any required information is missing or ambiguous, return:
{"status": "needsClarification", "question": "<one short follow-up question>"}
- Always ask if there is no target URL.
- Always ask if the test type is not explicitly signaled. Words like "user(s)", "session(s)", or "for N minutes" do NOT by themselves indicate which type — the test type is ambiguous without explicit signals.
- Always ask if the user has not stated a concrete number of users/VUs/sessions to simulate anywhere in the conversation — words like "spike test" or "soak test" name a load shape, not an amount. Always ask if the user has not stated how long the test should run anywhere in the conversation. Never invent or silently default these values.
- Never bundle multiple questions in one turn.

3. If multi-step intent is detected (named user journeys, explicit step sequences, "flow", "multi-step", "end-to-end", "e2e"):
{"status": "redirectToFlowBuilder", "reason": "<one sentence>"}
Multi-step intent detected in ANY turn (including earlier turns) still triggers this — it is NOT overridden by the user later providing VUs, duration, or test type.

Example (most common mistake):
USER: Spike test homepage
ASSISTANT: {"status": "needsClarification", "question": "What is the target URL?"}
USER: example.com backend
ASSISTANT: {"status": "needsClarification", "question": "How many virtual users would you like to simulate, and for how long?"}
Returning "ready" with invented numbers at this point is WRONG — VUs and duration were never stated.

Return ONLY the JSON object, nothing else.`;
};

/**
 * Mode: 'swagger' — extract a FlowStep[] from a Swagger/OpenAPI spec.
 * Produces: flowReady | needsClarification.
 * attachmentContext is the summarized spec (base URL + endpoint list).
 */
export const buildSwaggerPrompt = (messages: ChatMessage[], attachmentContext: string): string => {
  const transcript = makeTranscript(messages);
  return `You are an assistant that converts OpenAPI/Swagger specs into multi-step load test flows. ${USER_DATA_INSTRUCTION}

API spec provided by the user:
${attachmentContext}

Conversation so far:
${transcript}

Your goal is to extract a realistic multi-step flow from the spec above based on what the user described.

Return ONE of these two outcomes as valid JSON:

1. When you have the flow steps AND the user has stated VUs and duration:
${FLOW_READY_SHAPE}
${FLOW_READY_RULES}
- Construct FULL absolute URLs using the Base URL from the spec + the path (e.g. Base URL "https://api.example.com" + path "/auth/login" → "https://api.example.com/auth/login").
- For HAR recordings: include only non-static requests (skip images, JS, CSS). Preserve recorded order.
- For Swagger specs: pick the endpoints that match the flow the user described. If unclear which endpoints to include, ask.

2. When information is missing (which flow/endpoints to test, VUs, or duration):
{"status": "needsClarification", "question": "<one focused question>"}
- Ask which flow to test if the user has not described one.
- Ask for VUs if not stated. Ask for duration if not stated. One question per turn.

Return ONLY the JSON object, nothing else.`;
};

/**
 * Mode: 'context' — extract steps from a HAR recording, documentation, or codebase snippet.
 * Produces: flowReady | ready | needsClarification.
 * attachmentContext is the processed attachment text.
 */
export const buildContextPrompt = (messages: ChatMessage[], attachmentContext: string): string => {
  const transcript = makeTranscript(messages);
  return `You are an assistant that converts recorded HTTP traffic, documentation, or code into load test configurations. ${USER_DATA_INSTRUCTION}

Context provided by the user (HAR recording, documentation, or codebase):
${attachmentContext}

Conversation so far:
${transcript}

Analyse the context above and the conversation to determine what to test.

Return ONE of these outcomes as valid JSON:

1. If the context contains multiple sequential HTTP calls or describes a multi-step flow:
${FLOW_READY_SHAPE}
${FLOW_READY_RULES}
- For HAR recordings: use only non-static-asset requests (skip images, JS, CSS, fonts). Preserve the recorded sequence.
- For documentation/code: extract the API calls described in the order they would be performed.

2. If the context describes a single-URL test (one endpoint, no meaningful sequence):
{"status": "ready", "config": {"type": "backend" | "client-side", "targetUrl": "<url>", "description": "<full description including any assertion requirements>", "options": { ... }, "thresholds": { ... } }}

3. When required information is missing (VUs, duration, or which scenario to test):
{"status": "needsClarification", "question": "<one focused question>"}

Rules that apply to all outcomes:
- "options.vus" and "options.duration" MUST be stated by the user. If not, ask for them.
- Threshold values MUST be plain JSON numbers.
- Prefer "flowReady" over "ready" when the context contains a sequence of more than one distinct API call.

Return ONLY the JSON object, nothing else.`;
};

/**
 * Legacy single-entry-point wrapper — routes to the appropriate focused prompt.
 * Kept for backwards compatibility with existing unit tests.
 */
export const buildChatParsePrompt = (messages: ChatMessage[], attachmentContext?: string): string => {
  if (attachmentContext) {
    // Determine the likely attachment type from the context content
    if (attachmentContext.includes('<swagger_spec') || attachmentContext.includes('Base URL:')) {
      return buildSwaggerPrompt(messages, attachmentContext);
    }
    return buildContextPrompt(messages, attachmentContext);
  }
  return buildEnglishPrompt(messages);
};

// ── Output validators ─────────────────────────────────────────────────────────

/**
 * Normalizes config.thresholds in place (coerces string values to numbers).
 * Returns false if thresholds is present but malformed/uncoercible.
 */
const normalizeThresholdsInPlace = (config: Record<string, unknown>): boolean => {
  if (config.thresholds === undefined) return true;
  if (!config.thresholds || typeof config.thresholds !== 'object') return false;
  const thresholds = config.thresholds as Record<string, unknown>;
  for (const key of Object.keys(thresholds)) {
    const coerced = coerceNumericValue(thresholds[key]);
    if (coerced === null) return false;
    thresholds[key] = coerced;
  }
  return true;
};

/**
 * Normalizes config.targetUrl in place — defaults a bare domain to https://.
 * Returns false only if the URL is unusable even after that fix.
 */
const normalizeTargetUrlInPlace = (config: Record<string, unknown>): boolean => {
  const raw = (config.targetUrl as string).trim();
  try {
    const parsed = new URL(raw);
    config.targetUrl = raw;
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    try {
      config.targetUrl = new URL(`https://${raw}`).toString();
      return true;
    } catch {
      return false;
    }
  }
};

const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

const isValidFlowStep = (step: unknown): step is FlowStep => {
  if (!step || typeof step !== 'object') return false;
  const s = step as Record<string, unknown>;
  return (
    typeof s.name === 'string' && s.name.length > 0 &&
    typeof s.url === 'string' && s.url.length > 0 &&
    VALID_METHODS.has(s.method as string)
  );
};

/** Validates a parsed Gemini response matches ChatParseResponse. */
export const isValidChatParseResponse = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.status === 'needsClarification') return typeof v.question === 'string' && v.question.length > 0;
  if (v.status === 'redirectToFlowBuilder') return typeof v.reason === 'string' && v.reason.length > 0;
  if (v.status === 'ready') {
    const config = v.config as Record<string, unknown> | undefined;
    if (!config || typeof config !== 'object') return false;
    if (config.type !== 'backend' && config.type !== 'client-side') return false;
    if (typeof config.targetUrl !== 'string' || config.targetUrl.length === 0) return false;
    if (typeof config.description !== 'string') return false;
    if (!config.options || typeof config.options !== 'object') return false;
    if (!normalizeTargetUrlInPlace(config)) return false;
    if (!normalizeThresholdsInPlace(config)) return false;
    return true;
  }
  if (v.status === 'flowReady') {
    const flow = v.flow as Record<string, unknown> | undefined;
    if (!flow || typeof flow !== 'object') return false;
    if (!Array.isArray(flow.steps) || flow.steps.length === 0) return false;
    if (!flow.steps.every(isValidFlowStep)) return false;
    if (typeof flow.targetUrl !== 'string' || flow.targetUrl.length === 0) return false;
    if (typeof flow.description !== 'string') return false;
    if (!flow.options || typeof flow.options !== 'object') return false;
    if (flow.thresholds !== undefined && !normalizeThresholdsInPlace(flow)) return false;
    return true;
  }
  return false;
};

/** Validates the AI's /ai/cron response: {"cron": "...", "preview": "..."}. */
export const isValidCronResponse = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.cron === 'string' && v.cron.length > 0 && typeof v.preview === 'string' && v.preview.length > 0;
};

/** Validates the AI's /ai/trend-narrative response: {"narrative": "..."}. */
export const isValidTrendNarrativeResponse = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.narrative === 'string' && v.narrative.length > 0;
};

/**
 * Validates (and coerces) the AI's /results/suggest-settings response.
 * Mutates `value.vus` in place when it arrives as a coercible numeric string.
 */
export const isValidSuggestSettingsResponse = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const vus = coerceNumericValue(v.vus);
  if (vus === null) return false;
  v.vus = vus;
  if (typeof v.duration !== 'string' || v.duration.length === 0) return false;
  if (v.profile !== 'load' && v.profile !== 'spike' && v.profile !== 'soak' && v.profile !== 'capacity') return false;
  if (typeof v.reasoning !== 'string') return false;
  return true;
};

/** Validates the AI's /ai/webhook-noise response. */
export const isValidWebhookNoiseResponse = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.level !== 'noisy' && v.level !== 'ok' && v.level !== 'silent') return false;
  return typeof v.message === 'string';
};

/** Validates the AI's /ai/preset-name response. */
export const isValidPresetNameResponse = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== 'string' || v.name.length === 0) return false;
  return Array.isArray(v.tags) && v.tags.every((t: unknown) => typeof t === 'string');
};

/** Validates the AI's /ai/param-suggestions response. */
export const isValidParamSuggestionsResponse = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.columns) || v.columns.length === 0 || !v.columns.every((c: unknown) => typeof c === 'string')) return false;
  return typeof v.reasoning === 'string';
};

/**
 * Validates (and coerces) the AI's /results/suggest-thresholds response.
 * Mutates p95/avg/errorRate in place when they arrive as coercible numeric strings.
 */
export const isValidSuggestThresholdsResponse = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  for (const key of ['p95', 'avg', 'errorRate'] as const) {
    const coerced = coerceNumericValue(v[key]);
    if (coerced === null) return false;
    v[key] = coerced;
  }
  return typeof v.reasoning === 'string';
};

/**
 * Validates the AI's /results/:testId/diagnose response: a JSON array of
 * {"category": "serverError|clientError|timeout|networkError", "count": ..., ...}.
 */
export const isValidDiagnoseResponse = (value: unknown): boolean => {
  if (!Array.isArray(value)) return false;
  return value.every(item => {
    if (!item || typeof item !== 'object') return false;
    const v = item as Record<string, unknown>;
    if (v.category !== 'serverError' && v.category !== 'clientError' && v.category !== 'timeout' && v.category !== 'networkError') return false;
    if (typeof v.count !== 'number') return false;
    if (typeof v.likelyCause !== 'string') return false;
    return typeof v.nextStep === 'string';
  });
};

// ── Auth helpers ──────────────────────────────────────────────────────────────

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Dummy session user returned by /auth/* when SESSION_SECRET is empty (auth disabled). */
export const DEV_USER: SessionUser = {
  id: 'dev',
  email: 'dev@local',
  name: 'dev',
  teams: [{ id: 'dev', name: 'dev', role: 'admin' }],
  currentTeamId: 'dev',
  role: 'admin',
  orgs: [],
};

/** All teams a user belongs to, with their role in each. */
export const loadUserTeams = async (p: Pool, userId: string): Promise<TeamMembership[]> => {
  const { rows } = await p.query<{ id: string; name: string; role: TeamRole }>(
    `SELECT pr.id, pr.name, tm.role
     FROM team_members tm
     JOIN projects pr ON pr.id = tm.team_id
     WHERE tm.user_id = $1
     ORDER BY tm.created_at ASC`,
    [userId],
  );
  return rows.map(r => ({ id: r.id, name: r.name, role: r.role }));
};

/** All organizations a user belongs to, with their role in each. */
export const loadUserOrgs = async (p: Pool, userId: string): Promise<OrgMembership[]> => {
  const { rows } = await p.query<{ id: string; name: string; role: OrgRole }>(
    `SELECT o.id, o.name, om.role
     FROM org_members om
     JOIN organizations o ON o.id = om.org_id
     WHERE om.user_id = $1
     ORDER BY om.created_at ASC`,
    [userId],
  );
  return rows.map(r => ({ id: r.id, name: r.name, role: r.role }));
};
