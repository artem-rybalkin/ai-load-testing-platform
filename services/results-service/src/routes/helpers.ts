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
} from '@alt/shared';
import {
  isProviderConfigured,
  generateAIText,
  coerceNumericValue,
  fenceUserContent,
  USER_DATA_INSTRUCTION,
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

// ── Chat-parse helpers ────────────────────────────────────────────────────────

/** Most recent N messages to include in the chat-parse prompt. */
export const CHAT_HISTORY_LIMIT = 20;

/**
 * Builds the Gemini prompt for POST /chat/parse. Exported standalone for unit
 * testability. Truncates to the last CHAT_HISTORY_LIMIT messages.
 */
export const buildChatParsePrompt = (messages: ChatMessage[]): string => {
  const recent = messages.slice(-CHAT_HISTORY_LIMIT);
  const transcript = recent
    .map(m => `${m.role.toUpperCase()}: ${fenceUserContent('user_message', m.content)}`)
    .join('\n');

  return `You are an assistant that turns a free-text conversation about a desired load/performance test into a structured test configuration. ${USER_DATA_INSTRUCTION}

Conversation so far:
${transcript}

Decide which ONE of the following three outcomes applies, and return ONLY valid JSON matching exactly one of these shapes:

1. Return "ready" ONLY if ALL FOUR of these were explicitly stated by the user somewhere in the conversation — never invent or silently default any of them:
   (a) a single target URL
   (b) which test type — backend or client-side (see the signal-word rule under outcome 2)
   (c) a concrete number of users/VUs/sessions to simulate
   (d) how long the test should run
   If even one of (a)-(d) is missing, you MUST use outcome 2 instead — do not guess a number or duration just because the rest of the request is clear.
{"status": "ready", "config": {"type": "backend" | "client-side", "targetUrl": "<url>", "description": "<human-readable one-sentence summary>", "options": { ... }, "thresholds": { ... } }}
- For "backend": options must look like {"vus": <number>, "duration": "<e.g. 1m>", "rampUp": "<optional>", "profile": "load"|"spike"|"capacity"|"soak"}.
- For "client-side": options must look like {"sessions": <number>, "duration": "<e.g. 1m>", "collectWebVitals": true}.
- "thresholds" is optional; include only fields the user actually mentioned (p95, avg, errorRate, lcp, fcp, ttfb, cls, inp, tbt). Every threshold value MUST be a plain JSON number with NO unit suffix — write {"p95": 1000}, NEVER {"p95": "1000ms"} or {"p95": "1000"}.

2. If any of (a)-(d) above is missing or ambiguous, return:
{"status": "needsClarification", "question": "<one short follow-up question to ask the user>"}
- Always ask if there is no target URL.
- Always ask if the test type is not explicitly signaled. Words like "user(s)", "session(s)", a number, or "for N minutes" do NOT by themselves indicate which type — a backend test counts "users" as virtual users (VUs) and a browser test counts "users" as browser sessions, so these words alone are ambiguous. Only infer "backend" from explicit signals like "API", "backend", "load test", "http test", "k6", "performance test", "endpoint". Only infer "client-side" from explicit signals like "browser", "real browser", "page", "web vitals", "Lighthouse", "Puppeteer", "client-side". If neither signal is present, ask which type the user wants rather than guessing.
- Always ask if the user has not stated a concrete number of users/VUs/sessions to simulate anywhere in the conversation — words like "spike test" or "soak test" name a load *shape*, not a load *amount*, and never imply a number on their own. Always ask if the user has not stated how long the test should run anywhere in the conversation. These are load-test parameters that materially change the test — never invent or silently default them. If both are missing, ask one combined question covering both; if only one is missing, ask for that one specifically.

3. If the user's intent clearly spans multiple sequential steps or endpoints (e.g. "log in, then add an item to cart, then checkout"), DO NOT attempt to infer the steps. Instead return:
{"status": "redirectToFlowBuilder", "reason": "<one short sentence explaining why this needs the Flow Builder>"}

Example (this exact pattern is the most common mistake — study it closely):
USER: Spike test homepage
ASSISTANT: Could you provide the target URL and whether this should be a backend or client-side test?
USER: example.com backend
Even though URL and type are now both known, the user STILL never gave a number of VUs or a duration — "spike test" alone does not imply 50 VUs / 5m / any number. The correct response here is:
{"status": "needsClarification", "question": "How many virtual users would you like to simulate, and for how long should the spike test run?"}
Returning "ready" with invented numbers at this point is WRONG, even though it feels like the conversation has enough information to "complete" the request.

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
