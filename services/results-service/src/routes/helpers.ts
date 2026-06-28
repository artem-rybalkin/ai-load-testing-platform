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
  FlowStep,
} from '@alt/shared';
import {
  isProviderConfigured,
  generateAIText,
  coerceNumericValue,
  fenceUserContent,
  USER_DATA_INSTRUCTION,
  validateSsrfSafeUrl,
} from '@alt/shared';
import { getAiProviderSetting } from '../settings';

// ── AI helpers ────────────────────────────────────────────────────────────────

/** Generates text using the globally-configured AI provider (with fallback chain). */
export const aiGenerateText = async (pool: Pool, prompt: string): Promise<string> => {
  const setting = await getAiProviderSetting(pool);
  return generateAIText(prompt, setting);
};

/** Whether any provider in the globally-configured chain has an API key set. */
export const isAiConfigured = async (pool: Pool): Promise<boolean> => {
  const setting = await getAiProviderSetting(pool);
  return [setting.provider, ...setting.fallbacks].some(isProviderConfigured);
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
const summarizeOpenApiSpec = (spec: Record<string, unknown>): string => {
  const paths = spec.paths as Record<string, unknown> | undefined;
  if (!paths || typeof paths !== 'object') return '[No paths found in spec]';

  const title = (spec.info as Record<string, unknown> | undefined)?.title ?? 'API';
  const lines: string[] = [`API: ${title}`];

  for (const [path, methods] of Object.entries(paths)) {
    if (!methods || typeof methods !== 'object') continue;
    for (const [method, op] of Object.entries(methods as Record<string, unknown>)) {
      if (method === 'parameters' || method === 'summary' || method === 'description') continue;
      const operation = op as Record<string, unknown>;
      const summary = (operation.summary ?? operation.description ?? '') as string;
      const reqBody = operation.requestBody as Record<string, unknown> | undefined;
      const bodyNote = reqBody ? ' (has request body)' : '';
      lines.push(`${method.toUpperCase()} ${path}${summary ? ` — ${summary}` : ''}${bodyNote}`);
      if (lines.length >= 80) { lines.push('... (truncated)'); break; }
    }
    if (lines.length >= 80) break;
  }

  return lines.join('\n').slice(0, CONTEXT_CHAR_CAP);
};

/** Fetch and summarise a Swagger/OpenAPI URL into an endpoint list for the prompt. */
export const fetchAndSummarizeSwagger = async (url: string): Promise<string> => {
  const ssrfError = validateSsrfSafeUrl(url);
  if (ssrfError) return `[Swagger fetch blocked: ${ssrfError}]`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return `[Swagger fetch failed: HTTP ${res.status}]`;

    const text = await res.text();

    try {
      const spec = JSON.parse(text) as Record<string, unknown>;
      return summarizeOpenApiSpec(spec);
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
 * Builds the Gemini prompt for POST /chat/parse. Exported standalone for unit
 * testability. Truncates to the last CHAT_HISTORY_LIMIT messages.
 *
 * When `attachmentContext` is provided (processed from user-uploaded files/URLs),
 * the prompt gains a 4th outcome — "flowReady" — that returns a full FlowStep[].
 */
export const buildChatParsePrompt = (messages: ChatMessage[], attachmentContext?: string): string => {
  const recent = messages.slice(-CHAT_HISTORY_LIMIT);
  const transcript = recent
    .map(m => `${m.role.toUpperCase()}: ${fenceUserContent('user_message', m.content)}`)
    .join('\n');

  const contextSection = attachmentContext
    ? `\nContext provided by the user (API spec, documentation, recorded traffic, or codebase):\n${attachmentContext}\n`
    : '';

  const flowOutcome = attachmentContext ? `
1. If the user's intent involves multiple sequential steps OR if context is provided above, try to build a complete flow. Return "flowReady" when you have enough information (steps, load settings):
{"status": "flowReady", "flow": {
  "steps": [
    {"name": "<step name>", "url": "<full URL>", "method": "GET|POST|PUT|DELETE|PATCH", "body": "<optional JSON string>", "headers": {}, "extract": {}},
    ...
  ],
  "targetUrl": "<base URL of the first step>",
  "description": "<one-sentence human-readable summary of the flow>",
  "options": {"vus": <number>, "duration": "<e.g. 2m>", "rampUp": "<optional>", "profile": "load"|"spike"|"capacity"|"soak"},
  "thresholds": {"p95": <number>, "errorRate": <number>}
}}
Rules for "flowReady":
- Extract steps from the provided context (HAR recording, Swagger spec, or described sequence). Each step MUST have a name, url, and method. Include body only when the user/spec indicates a request body.
- "targetUrl" is the base URL (hostname only, e.g. "https://api.example.com") taken from the first step's URL.
- "options.vus" and "options.duration" MUST be stated by the user. If they have not stated them yet, use "needsClarification" instead.
- "thresholds" is optional — include only when the user mentioned performance targets.
- Every threshold value MUST be a plain JSON number with no unit suffix.
- For HAR recordings: include only the non-static-asset requests (skip images, JS, CSS files). Preserve the recorded order.
- For Swagger specs: pick the endpoints that form the flow described by the user. If the user has not said which flow to test, ask.
- "extract" should be populated if one step's response feeds a variable into a later step (e.g. auth token extraction). Leave as empty {} if no extraction is needed.
` : '';

  const readyOutcomeNumber = attachmentContext ? '2' : '1';
  const clarificationOutcomeNumber = attachmentContext ? '3' : '2';
  const redirectOutcomeNumber = attachmentContext ? '4' : '3';

  return `You are an assistant that turns conversations and API documentation into load/performance test configurations. ${USER_DATA_INSTRUCTION}
${contextSection}
Conversation so far:
${transcript}

Decide which ONE of the following outcomes applies, and return ONLY valid JSON matching exactly one of these shapes:
${flowOutcome}
${readyOutcomeNumber}. Return "ready" ONLY if ALL FOUR of these were explicitly stated by the user somewhere in the conversation — never invent or silently default any of them:
   (a) a single target URL
   (b) which test type — backend or client-side (see the signal-word rule below)
   (c) a concrete number of users/VUs/sessions to simulate
   (d) how long the test should run
   If even one of (a)-(d) is missing, you MUST use the "needsClarification" outcome instead.
{"status": "ready", "config": {"type": "backend" | "client-side", "targetUrl": "<url>", "description": "<one-sentence summary>", "options": { ... }, "thresholds": { ... } }}
- For "backend": options = {"vus": <number>, "duration": "<e.g. 1m>", "rampUp": "<optional>", "profile": "load"|"spike"|"capacity"|"soak"}.
- For "client-side": options = {"sessions": <number>, "duration": "<e.g. 1m>", "collectWebVitals": true}.
- Threshold values MUST be plain JSON numbers ({"p95": 1000}, never {"p95": "1000ms"}).

${clarificationOutcomeNumber}. If any required information is missing or ambiguous, return:
{"status": "needsClarification", "question": "<one short follow-up question>"}
- Always ask if there is no target URL.
- Always ask if the test type is not explicitly signaled. Words like "user(s)", "session(s)", a number, or "for N minutes" do NOT by themselves indicate which type — the test type is ambiguous without explicit signals. Only infer "backend" from: "API", "backend", "load test", "http test", "k6", "performance test", "endpoint". Only infer "client-side" from: "browser", "real browser", "page", "web vitals", "Lighthouse", "Puppeteer", "client-side". If neither signal is present, ask which type.
- Always ask if the user has not stated a concrete number of users/VUs/sessions to simulate anywhere in the conversation — words like "spike test" or "soak test" name a load shape, not an amount. Always ask if the user has not stated how long the test should run anywhere in the conversation. Never invent or silently default these values.
- For flows: ask if the user has not said which specific flow/endpoints to test, or if VUs/duration are missing.

${redirectOutcomeNumber}. Only if multi-step intent is detected AND no context was provided AND you cannot determine steps from the conversation:
{"status": "redirectToFlowBuilder", "reason": "<one sentence>"}
${attachmentContext ? 'IMPORTANT: When context is provided above, prefer "flowReady" or "needsClarification" over "redirectToFlowBuilder".' : 'Trigger this for: named user journeys ("login flow", "checkout flow", "registration flow"), explicit step sequences ("log in then add to cart then checkout"), "flow", "multi-step", "end-to-end", "e2e".'}

Example (most common mistake):
USER: Spike test homepage
ASSISTANT: Could you provide the target URL and whether this should be a backend or client-side test?
USER: example.com backend
→ {"status": "needsClarification", "question": "How many virtual users would you like to simulate, and for how long should the spike test run?"}
Returning "ready" with invented numbers at this point is WRONG — VUs and duration were never stated.

Return ONLY the JSON object, nothing else.`;
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
