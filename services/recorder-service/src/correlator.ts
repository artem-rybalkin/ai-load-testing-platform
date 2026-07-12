import {
  FlowStep, RecordedRequest, ExtractRule, ExtractSource, redactPII,
  AiProviderSetting, DEFAULT_AI_PROVIDER_SETTING, generateAIText, isProviderConfigured,
  fenceUserContent, USER_DATA_INSTRUCTION,
} from '@alt/shared';
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

// ─── AI-powered correlation detection ─────────────────────────────────────────
//
// Sends request/response pairs to Gemini and asks it to identify values
// from response N that appear in request N+1 or later.  The model returns
// a JSON object we use to populate FlowStep.extract fields.

interface CorrelationEntry {
  sourceStepIndex: number;       // which response (0-based) contains the value
  variableName: string;          // suggested variable name (snake_case)
  source: ExtractSource;         // 'jsonpath' | 'header' | 'cookie' | 'regex'
  expression: string;            // extraction expression
  usedInStepIndices: number[];   // steps that use this variable
}

interface CorrelationResult {
  correlations: CorrelationEntry[];
}

const CORRELATION_PROMPT = (requestSummary: string): string => `
You are an expert in HTTP traffic analysis and load testing. ${USER_DATA_INSTRUCTION}
Analyze the following HTTP request/response pairs from a recorded user session.
Identify "correlation points": places where a value from a response body or header
appears in a later request body or header.

KEY PATTERNS TO DETECT:
1. OAuth/JWT: response body contains "access_token" or "token" → later requests send it as "Authorization: Bearer <value>"
2. CSRF tokens: response header or body contains a CSRF value → later requests send it as a header or form field
3. Session IDs: Set-Cookie response header → later requests send it as Cookie
4. Entity IDs: response body contains an ID → later requests use it in the URL path or body
5. API keys: response body contains a key → later requests use it in a header

For each correlation found, return:
- sourceStepIndex: 0-based index of the response that produced the value
- variableName: snake_case name (e.g. "access_token", "csrf_token", "user_id")
- source: "jsonpath" (JSON body field), "header" (response header), "cookie" (Set-Cookie), "regex" (other)
- expression: extraction expression — for jsonpath use "$.fieldName" or "$.nested.field"; for header use the exact header name; for cookie use the cookie name
- usedInStepIndices: array of 0-based step indices that USE this value (in their requestHeaders or requestBody)

IMPORTANT: Check requestHeaders of each step for "Authorization", "X-Auth-Token", etc. to find where tokens are consumed.

Return ONLY valid JSON:
{"correlations":[...]}

If no correlations found: {"correlations":[]}

HTTP traffic:
${fenceUserContent('http_traffic', requestSummary)}
`.trim();

/** True if `contentType` indicates a textual body safe to send to Gemini (and to run redactPII over). */
function isTextContentType(contentType: string | undefined): boolean {
  if (!contentType) return true; // unknown — assume text (e.g. requests captured without a Content-Type header)
  return /json|text|xml|x-www-form-urlencoded|javascript/i.test(contentType);
}

// Maximum PII pattern length (longest match is an RFC-5321 email, 254 chars).
// Used as a safety margin so that PII straddling the body-truncation boundary
// is fully visible to redactPII() before the slice is applied — while avoiding
// O(n²) backtracking in EMAIL_RE on very large unbounded bodies.
const MAX_PII_LENGTH = 300;

/** Build a compact summary of request/response pairs to send to Gemini */
function buildSummary(requests: RecordedRequest[]): string {
  const slice = requests.slice(0, 20);

  // Finding #1: Collect all auth-related request header values so they can be
  // redacted everywhere in the summary, preventing bearer tokens / API keys from
  // reaching Gemini even if the same value also appears in a response body
  // (e.g. the login response body echoes back an access_token that a later
  // request re-sends as an Authorization header).
  const authTokens = new Set<string>();
  for (const r of slice) {
    for (const [k, v] of Object.entries(r.headers)) {
      if (/^authorization$|x-auth|x-csrf|x-token|x-api-key/i.test(k) && v) {
        authTokens.add(v);
        // Also add the credential-only part (e.g. "TOKEN" from "Bearer TOKEN")
        const firstSpace = v.indexOf(' ');
        if (firstSpace !== -1) authTokens.add(v.slice(firstSpace + 1));
      }
    }
  }

  /** Replace any collected auth-token values in `text` with [REDACTED]. */
  const redactAuthTokens = (text: string): string => {
    let result = text;
    for (const token of authTokens) {
      if (token.length >= 4) {
        result = result.split(token).join('[REDACTED]');
      }
    }
    return result;
  };

  const pairs = slice.map((r, i) => {
    const requestContentType = Object.entries(r.headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
    const responseContentType = Object.entries(r.responseHeaders).find(([k]) => k.toLowerCase() === 'content-type')?.[1];

    return {
      index: i,
      method: r.method,
      url: r.url,
      // Include auth-related request headers so Gemini can see tokens being USED,
      // but redact their literal values so credentials do not leave the perimeter.
      // Finding #1: map values to '[REDACTED]' instead of forwarding them verbatim.
      requestHeaders: Object.fromEntries(
        Object.entries(r.headers)
          .filter(([k]) => /^authorization$|x-auth|x-csrf|x-token|x-api-key/i.test(k))
          .map(([k]) => [k, '[REDACTED]'])
      ),
      // Finding #2: redact first on a windowed slice (limit + MAX_PII_LENGTH), then
      // truncate to the actual limit. The extra margin ensures a PII value that
      // straddles the boundary is fully matched by the regex — without running
      // redactPII on the entire unbounded body (EMAIL_RE is O(n²) on long inputs).
      // Finding #1: also scrub any auth-token values that appear in the body.
      requestBody: r.body
        ? (isTextContentType(requestContentType) ? redactAuthTokens(redactPII(r.body.slice(0, 500 + MAX_PII_LENGTH))).slice(0, 500) : '[BINARY_BODY_OMITTED]')
        : undefined,
      responseStatus: r.responseStatus,
      // Include response headers that commonly carry tokens
      responseHeaders: Object.fromEntries(
        Object.entries(r.responseHeaders).filter(([k]) =>
          /set-cookie|x-auth|authorization|token|location/i.test(k)
        )
      ),
      // 2000 chars — JWT access_token values are typically 800-1500 chars.
      responseBody: r.responseBody
        ? (isTextContentType(responseContentType) ? redactAuthTokens(redactPII(r.responseBody.slice(0, 2000 + MAX_PII_LENGTH))).slice(0, 2000) : '[BINARY_BODY_OMITTED]')
        : undefined,
    };
  });
  return JSON.stringify(pairs, null, 2);
}

/** Resolve a path like "$.data.user.id" or "data.items[0].id" against a parsed JSON value. */
function getByPath(data: unknown, path: string): string | undefined {
  const cleaned = path.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1');
  let cur: unknown = data;
  if (cleaned) {
    for (const token of cleaned.split('.').filter(Boolean)) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[token];
    }
  }
  if (cur == null) return undefined;
  return typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean' ? String(cur) : undefined;
}

/** Extract the literal value an ExtractRule points to from the recorded request/response. */
function extractValue(request: RecordedRequest, rule: ExtractRule): string | undefined {
  switch (rule.source) {
    case 'header': {
      const entry = Object.entries(request.responseHeaders)
        .find(([k]) => k.toLowerCase() === rule.expression.toLowerCase());
      return entry?.[1];
    }
    case 'cookie': {
      const setCookie = Object.entries(request.responseHeaders)
        .find(([k]) => k.toLowerCase() === 'set-cookie')?.[1];
      if (!setCookie) return undefined;
      for (const part of setCookie.split('\n')) {
        const pair = part.split(';')[0]!; // .split() always returns at least one element
        const eq = pair.indexOf('=');
        if (eq === -1) continue;
        if (pair.slice(0, eq).trim() === rule.expression) return pair.slice(eq + 1).trim();
      }
      return undefined;
    }
    case 'regex': {
      if (!request.responseBody) return undefined;
      try {
        const m = request.responseBody.match(new RegExp(rule.expression));
        return m ? (m[1] ?? m[0]) : undefined;
      } catch { return undefined; }
    }
    default: {
      if (!request.responseBody) return undefined;
      try { return getByPath(JSON.parse(request.responseBody), rule.expression); } catch { return undefined; }
    }
  }
}

/** Replace literal occurrences of `value` in a step's body/headers with `{{varName}}`.
 *  `originalHeaders` are the raw headers captured during recording — these still include
 *  Authorization/Cookie/etc. that `toFlowSteps` strips from `step.headers`. If the value
 *  was sent via one of those stripped headers, re-add it to `step.headers` with the
 *  placeholder so the correlation is actually wired up. */
function substituteValue(
  step: FlowStep,
  value: string,
  varName: string,
  originalHeaders?: Record<string, string>,
): FlowStep {
  const placeholder = `{{${varName}}}`;
  let changed = false;

  let body = step.body;
  if (body && body.includes(value)) {
    body = body.split(value).join(placeholder);
    changed = true;
  }

  let headers = step.headers;
  if (headers) {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (v.includes(value)) { next[k] = v.split(value).join(placeholder); changed = true; }
      else next[k] = v;
    }
    headers = next;
  }

  if (originalHeaders) {
    const present = new Set(Object.keys(headers ?? {}).map(k => k.toLowerCase()));
    for (const [k, v] of Object.entries(originalHeaders)) {
      if (!present.has(k.toLowerCase()) && v.includes(value)) {
        headers = { ...(headers ?? {}), [k]: v.split(value).join(placeholder) };
        changed = true;
      }
    }
  }

  return changed ? { ...step, body, headers } : step;
}

/**
 * Build a map from unfiltered-request-index → filtered-step-index.
 *
 * `toFlowSteps` drops 5xx responses before building the step array, creating a
 * gap between the AI's indices (which reference the full `requests` array sent to
 * the model via `buildSummary`) and the `steps` array indices that
 * `applyCorrelations` writes into.  This function reconstructs the mapping by
 * applying the same filter predicate (`responseStatus < 500`), capped at
 * `steps.length` to account for FLOW_STEPS_CAP.
 *
 * Returns `undefined` when both arrays have the same length (no filtering
 * occurred), so the caller can skip the mapping step entirely.
 */
function buildIndexMap(
  requests: RecordedRequest[],
  steps: FlowStep[],
): Map<number, number> | undefined {
  if (requests.length === steps.length) return undefined;
  const map = new Map<number, number>();
  let filteredIdx = 0;
  for (let reqIdx = 0; reqIdx < requests.length && filteredIdx < steps.length; reqIdx++) {
    if (requests[reqIdx]!.responseStatus < 500) { // guarded by the loop's reqIdx < requests.length condition
      map.set(reqIdx, filteredIdx++);
    }
  }
  return map;
}

/** Apply correlation entries back onto FlowStep[].extract, and rewrite consuming steps to reference {{varName}}. */
function applyCorrelations(
  requests: RecordedRequest[],
  steps: FlowStep[],
  correlations: CorrelationEntry[],
  indexMap?: Map<number, number>,
): FlowStep[] {
  let result: FlowStep[] = steps.map(s => ({ ...s, extract: { ...(s.extract ?? {}) } }));

  // Translate an unfiltered-request index returned by the AI to the corresponding
  // filtered-step index.  When no map is provided (arrays are already 1:1 aligned),
  // the index passes through unchanged.
  const toFilteredIdx = (unfilteredIdx: number): number =>
    indexMap ? (indexMap.get(unfilteredIdx) ?? -1) : unfilteredIdx;

  for (const corr of correlations) {
    // corr.sourceStepIndex is AI-supplied and not otherwise validated — an out-of-range
    // index (e.g. a hallucinated value) must skip this entry, not crash the whole pass.
    if (corr.sourceStepIndex < 0 || corr.sourceStepIndex >= requests.length) continue;

    const filteredSourceIdx = toFilteredIdx(corr.sourceStepIndex);
    if (filteredSourceIdx < 0 || filteredSourceIdx >= result.length) continue;

    const varName = corr.variableName.replace(/[^a-z0-9_]/gi, '_') || `var_${corr.sourceStepIndex}`;
    const rule: ExtractRule = { source: corr.source, expression: corr.expression };

    // Add extract rule to the source step
    result[filteredSourceIdx]!.extract = {
      ...result[filteredSourceIdx]!.extract,
      [varName]: rule,
    };

    // Replace the literal value with {{varName}} in the steps that consume it.
    // extractValue uses the UNFILTERED request index (corr.sourceStepIndex) — correct:
    // we need the original captured response body/headers, not the filtered step.
    const value = extractValue(requests[corr.sourceStepIndex]!, rule);
    let substitutedIn: number[] = [];
    if (value && value.length >= 3) {
      for (const unfilteredUsedIdx of corr.usedInStepIndices) {
        const filteredUsedIdx = toFilteredIdx(unfilteredUsedIdx);
        if (filteredUsedIdx < 0 || filteredUsedIdx >= result.length || filteredUsedIdx === filteredSourceIdx) continue;
        // Use the UNFILTERED request index to retrieve the original captured headers
        // (toFlowSteps strips auth/cookie headers from step.headers; substituteValue
        // needs the raw capture to detect when the value was sent via a stripped header).
        result[filteredUsedIdx] = substituteValue(result[filteredUsedIdx]!, value, varName, requests[unfilteredUsedIdx]?.headers); // guarded by the bounds check above
        substitutedIn.push(filteredUsedIdx);
      }
    }

    log.debug(
      { varName, source: corr.source, expression: corr.expression, usedIn: corr.usedInStepIndices, valueFound: !!value, substitutedIn },
      'Correlation applied'
    );
  }

  return result;
}

/** True if any session hit a Gemini rate limit recently. A concurrent session's
 *  success must not clobber this back to false (the original racy-singleton bug —
 *  session A finishing successfully while session B is still rate-limited used to
 *  silently hide B's failure). Instead of resetting on every success, the flag
 *  self-clears after RATE_LIMIT_STICKY_MS so /health doesn't stay "rate_limited"
 *  forever once the underlying issue clears. */
export let correlatorRateLimited = false;
const RATE_LIMIT_STICKY_MS = 60_000;
let rateLimitExpiry: ReturnType<typeof setTimeout> | null = null;

const markRateLimited = (): void => {
  correlatorRateLimited = true;
  if (rateLimitExpiry) clearTimeout(rateLimitExpiry);
  rateLimitExpiry = setTimeout(() => { correlatorRateLimited = false; }, RATE_LIMIT_STICKY_MS);
  rateLimitExpiry.unref?.();
};

/** Reset the rate-limited flag immediately — used by tests so one test's rate-limit
 *  doesn't bleed into the next. */
export function resetCorrelatorRateLimited(): void {
  correlatorRateLimited = false;
  if (rateLimitExpiry) { clearTimeout(rateLimitExpiry); rateLimitExpiry = null; }
}

/** Analyse all captured domains and suggest ignore patterns for next recording. */
export async function suggestIgnorePatterns(requests: RecordedRequest[], teamId?: string | null): Promise<string[]> {
  const setting = await getProviderSetting(teamId);
  if (!isAnyProviderConfigured(setting) || requests.length === 0) return [];

  // Count requests per domain
  const domainCounts: Record<string, number> = {};
  for (const r of requests) {
    try {
      const host = new URL(r.url).hostname;
      domainCounts[host] = (domainCounts[host] ?? 0) + 1;
    } catch { /* skip invalid URLs */ }
  }
  const domains = Object.entries(domainCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([host, count]) => ({ host, count }));

  const prompt = `You are an expert in HTTP traffic analysis. ${USER_DATA_INSTRUCTION}
These domains were captured during a browser recording session. Identify which ones are analytics, tracking, CDN, or background noise that should be ignored in a load test (not the application being tested).

Domains:
${fenceUserContent('captured_domains', JSON.stringify(domains, null, 2))}

Return ONLY valid JSON array of domain strings to ignore. Use exact hostnames only, no wildcards, no regexes:
["domain1.com", "domain2.com", ...]

If all domains are relevant, return: []`;

  try {
    const text = (await generateAIText(prompt, setting)).trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      log.debug({ domains, text }, 'Ignore-pattern suggestion: no JSON array in response');
      return [];
    }
    const patterns = JSON.parse(match[0]) as unknown[];
    const filtered = patterns.filter((p): p is string => typeof p === 'string' && p.length > 0);
    log.debug({ domains, suggested: filtered }, 'Ignore-pattern suggestion complete');
    return filtered;
  } catch (err) {
    log.warn({ err, domains }, 'Ignore-pattern suggestion failed');
    return [];
  }
}

export interface DeduplicationSuggestion {
  indices: number[];          // step indices that are near-duplicates
  commonPath: string;         // shared endpoint path
  suggestion: string;         // human-readable merge suggestion
  paramKey?: string | undefined; // suggested query-param key to parameterise, when one varies
}

/** Identify near-duplicate steps (same endpoint, varying query params) and suggest consolidation. */
export function detectDuplicateSteps(steps: FlowStep[]): DeduplicationSuggestion[] {
  const pathGroups: Record<string, Array<{ index: number; url: string }>> = {};

  for (let i = 0; i < steps.length; i++) {
    try {
      const parsed = new URL(steps[i]!.url); // guarded by the loop's i < steps.length condition
      const pathKey = `${steps[i]!.method}\x00${parsed.origin}${parsed.pathname}`;
      if (!pathGroups[pathKey]) pathGroups[pathKey] = [];
      pathGroups[pathKey]!.push({ index: i, url: steps[i]!.url });
    } catch { /* ignore invalid URLs */ }
  }

  const suggestions: DeduplicationSuggestion[] = [];
  for (const [pathKey, group] of Object.entries(pathGroups)) {
    if (group.length < 2) continue;
    const path = pathKey.split('\x00')[1]!; // pathKey is always built with exactly one \x00 separator above
    // Find the query param that varies between calls
    const paramSets = group.map(g => {
      try { return Object.fromEntries(new URL(g.url).searchParams); } catch { return {}; }
    });
    const varyingKeys = Object.keys(paramSets[0] ?? {}).filter(k => // group.length >= 2 guaranteed by the check above
      new Set(paramSets.map(p => p[k])).size > 1
    );

    suggestions.push({
      indices: group.map(g => g.index),
      commonPath: path,
      suggestion: `Steps ${group.map(g => g.index + 1).join(', ')} all call the same endpoint${varyingKeys.length ? ` with different ${varyingKeys.join(', ')} values` : ''}. Consider keeping one step and parameterising it with test data.`,
      paramKey: varyingKeys[0],
    });
  }

  return suggestions;
}

/** Ask Gemini to replace mechanical step names with human-readable labels. */
export async function suggestStepNames(steps: FlowStep[], teamId?: string | null): Promise<FlowStep[]> {
  const setting = await getProviderSetting(teamId);
  if (!isAnyProviderConfigured(setting) || steps.length === 0) return steps;

  const input = steps.map((s, i) => ({ index: i, method: s.method, url: s.url }));
  const prompt = `You are an expert in web APIs and load testing. ${USER_DATA_INSTRUCTION}
Rename these HTTP steps with short, human-readable labels describing what each step does.
Examples: "Authenticate — get bearer token", "Load homepage", "Search for products", "Add item to cart", "Checkout".

Steps:
${fenceUserContent('recorded_steps', JSON.stringify(input, null, 2))}

Return ONLY valid JSON array with one name string per step (same order, same count):
["name for step 0", "name for step 1", ...]`;

  try {
    const text = (await generateAIText(prompt, setting)).trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return steps;
    const names = JSON.parse(match[0]) as string[];
    if (!Array.isArray(names) || names.length !== steps.length) return steps;
    return steps.map((s, i) => ({ ...s, name: names[i] || s.name }));
  } catch (err) {
    log.warn({ err }, 'Step naming failed — keeping original names');
    return steps;
  }
}

/** Run AI correlation detection; returns steps enriched with extract rules. */
export async function detectCorrelations(
  requests: RecordedRequest[],
  steps: FlowStep[],
  teamId?: string | null,
): Promise<FlowStep[]> {
  const setting = await getProviderSetting(teamId);
  if (!isAnyProviderConfigured(setting)) {
    log.warn('No AI provider configured — skipping correlation detection');
    return steps;
  }
  if (requests.length < 2) {
    return steps; // need at least two exchanges to find correlations
  }

  const summary = buildSummary(requests);

  try {
    const text = (await generateAIText(CORRELATION_PROMPT(summary), setting)).trim();

    // Extract JSON even if Gemini wraps it in markdown code fences
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn({ text }, 'Correlation response did not contain JSON');
      return steps;
    }

    const parsed = JSON.parse(jsonMatch[0]) as CorrelationResult;
    if (!Array.isArray(parsed.correlations)) {
      return steps;
    }

    // Build a mapping from unfiltered-request index to filtered-step index so that
    // AI-returned indices (which reference the full requests array passed to
    // buildSummary) are translated correctly before writing into the steps array
    // (which may be shorter when toFlowSteps dropped 5xx responses).
    const indexMap = buildIndexMap(requests, steps);
    const enriched = applyCorrelations(requests, steps, parsed.correlations, indexMap);
    // Finding #5: do NOT reset correlatorRateLimited here. A success in session A must
    // not clobber the rate-limited flag set by a concurrent session B that is still in
    // the catch block. Callers reset the flag explicitly via resetCorrelatorRateLimited().
    log.info({ correlationCount: parsed.correlations.length }, 'Correlation detection complete');
    return enriched;
  } catch (err) {
    const msg = (err as Error).message ?? '';
    const status = (err as { status?: number }).status;
    if (status === 429 || /\b429\b/.test(msg) || msg.includes('quota')) {
      markRateLimited();
      log.warn('AI provider rate limited during correlation detection');
    } else {
      log.warn({ err }, 'Correlation detection failed — returning steps without extraction rules');
    }
    return steps;
  }
}
