import { TestRequest, ExtractRule, AiProviderSetting, DEFAULT_AI_PROVIDER_SETTING, generateAIText, fenceUserContent, USER_DATA_INSTRUCTION, SLOThresholds, deriveMultiPercentileThresholds } from '@alt/shared';
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

/**
 * Atomically checks the team's daily Gemini quota AND records usage via
 * results-service, so the queue-driven script-generation/comparison path
 * (this file) is no longer invisible to the same per-team counter the
 * /ai/* HTTP endpoints already enforce. Called once per real Gemini call
 * this file is about to make — never for the free exact-description-match
 * REUSE shortcut in processor.ts, which makes no LLM call at all.
 * teamId undefined/null (dev mode, no auth) always resolves to allowed,
 * matching checkAndIncrementGeminiUsage's own convention on the other side.
 * Fails open (allowed) if results-service is unreachable — a transient
 * quota-tracking hiccup should not block test creation outright, same
 * non-fatal-fallback philosophy as every other AI feature in this codebase.
 */
export const checkAndIncrementGeminiUsage = async (teamId?: string | null): Promise<string | null> => {
  if (!teamId) return null;
  try {
    const res = await fetch(`${RESULTS_URL}/internal/gemini-usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INTERNAL_API_KEY ? { 'X-Internal-Key': INTERNAL_API_KEY } : {}),
      },
      body: JSON.stringify({ teamId }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json() as { allowed: boolean; error: string | null };
      return data.allowed ? null : data.error;
    }
  } catch {
    // results-service unreachable — fail open rather than blocking test creation
  }
  return null;
};

export interface CapacityAbortConfig {
  p95Ms: number;
  errorRatePct: number;
  delaySec: number;
}

// Matches api-service's DEFAULT_CAPACITY_ABORT_CONFIG (options.ts) — the two
// independent script-generation paths (this file's prompt-embedded literal
// values, and api-service's cache-hit re-injection) can't drift apart as
// long as both fall back to the same numbers when results-service is
// unreachable or the setting has never been configured.
const DEFAULT_CAPACITY_ABORT_CONFIG: CapacityAbortConfig = { p95Ms: 2000, errorRatePct: 5, delaySec: 10 };
const CAPACITY_ABORT_CACHE_MS = 30000;
let capacityAbortCache: { config: CapacityAbortConfig; cachedAt: number } | null = null;

/** Fetches the capacity/stress profile's abortOnFail thresholds from results-service, cached for 30s. */
const getCapacityAbortConfig = async (): Promise<CapacityAbortConfig> => {
  if (capacityAbortCache && Date.now() - capacityAbortCache.cachedAt < CAPACITY_ABORT_CACHE_MS) return capacityAbortCache.config;
  try {
    const res = await fetch(`${RESULTS_URL}/system/capacity-abort`, {
      headers: INTERNAL_API_KEY ? { 'X-Internal-Key': INTERNAL_API_KEY } : {},
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const config = await res.json() as CapacityAbortConfig;
      capacityAbortCache = { config, cachedAt: Date.now() };
      return config;
    }
  } catch {
    // results-service unreachable — keep using cached/default config
  }
  return capacityAbortCache?.config ?? DEFAULT_CAPACITY_ABORT_CONFIG;
};

// k6's own options.thresholds is a separate mechanism from the app's post-test
// SLO analysis (analyzeResult() in @alt/shared, which already honors test.thresholds).
// Without this, the generated script always hardcoded p(95)<1000 / rate<0.01
// regardless of what SLO the user actually configured (chat, home page, presets).
// p90/p99 are derived from p95 (not separately user-configurable) so the
// generated script gets multi-percentile thresholds instead of a single
// p(95) cliff-edge, mirroring the p50/p90/p95/p99 the results UI already shows.
const k6Thresholds = (thresholds?: SLOThresholds): { p95: number; p90: number; p99: number; errorRateFrac: string } => {
  const p95 = thresholds?.p95 ?? 1000;
  const { p90, p99 } = deriveMultiPercentileThresholds(p95);
  return { p95, p90, p99, errorRateFrac: ((thresholds?.errorRate ?? 1) / 100).toString() };
};

const profileInstructions = (
  opts: { vus: number; duration: string; profile?: string; peakVus?: number; rampUp?: string },
  abortConfig: CapacityAbortConfig = DEFAULT_CAPACITY_ABORT_CONFIG,
): string => {
  const { vus, duration, profile = 'load', peakVus } = opts;
  const peak = peakVus ?? vus * 10;

  switch (profile) {
    case 'spike':
      return `Load profile: SPIKE TEST
Generate k6 stages that simulate a sudden traffic spike:
- Warm-up: ramp from 0 to ${vus} VUs over 30s
- Pre-spike: hold at ${vus} VUs for 1m
- Spike UP: ramp to ${peak} VUs over 10s
- Spike hold: hold at ${peak} VUs for 1m
- Spike DOWN: ramp back to ${vus} VUs over 10s
- Cool-down: ramp to 0 over 30s
Set a threshold that allows higher error rate during the spike (up to 10%).`;

    case 'capacity': {
      const { p95Ms, errorRatePct, delaySec } = abortConfig;
      const { p90, p99 } = deriveMultiPercentileThresholds(p95Ms);
      const delayAbortEval = `${delaySec}s`;
      const errorRateFrac = errorRatePct / 100;
      return `Load profile: CAPACITY / STRESS TEST
Generate k6 stages that gradually increase load to find the breaking point:
- Ramp up from 0 to ${peak} VUs over ${duration}
- Do NOT hold — just keep ramping linearly
- The goal is to find where the system breaks, not to run the full ramp regardless — once p(95)/error-rate thresholds are breached there's nothing more to learn, so use k6's abortOnFail to stop the test early instead of the plain string threshold form used elsewhere. p90/p99 stay plain (observational) — only p95 aborts, so a single tail outlier can't trigger a premature abort on its own. Set options.thresholds to exactly:
  thresholds: {
    http_req_duration: ['p(90)<${p90}', { threshold: 'p(95)<${p95Ms}', abortOnFail: true, delayAbortEval: '${delayAbortEval}' }, 'p(99)<${p99}'],
    http_req_failed: [{ threshold: 'rate<${errorRateFrac}', abortOnFail: true, delayAbortEval: '${delayAbortEval}' }],
    checks: ['rate>0.9'],
  }
  (delayAbortEval: '${delayAbortEval}' gives each new ramp level a moment to produce enough samples before a breach can trigger an abort, so one slow request right after a ramp-up doesn't abort prematurely.)`;
    }

    case 'soak':
      return `Load profile: SOAK TEST
Generate k6 stages for a prolonged steady-state test:
- Ramp from 0 to ${vus} VUs over 1m
- Hold at ${vus} VUs for ${duration}
- Ramp down to 0 over 30s
Focus on memory leaks and degradation over time. Set a strict p(95) < 500ms threshold.`;

    case 'realistic': {
      // vus is reinterpreted as a target arrival RATE (requests/sec), not a
      // concurrent-user count — see the executor explanation below.
      const rate = vus;
      const preAllocatedVUs = Math.max(rate, 10);
      const maxVUs = preAllocatedVUs * 10;
      return `Load profile: REALISTIC (open-model / arrival-rate) TEST
Every other profile uses k6's VU-based stages executor, which is closed-model: a VU waits for its response before sending the next request, which under-represents real load once the system starts degrading. This profile instead uses k6's ramping-arrival-rate executor, which keeps sending requests at a fixed rate regardless of response time — closer to real inbound traffic. Set options.scenarios to exactly:
  scenarios: {
    realistic: {
      executor: 'ramping-arrival-rate',
      timeUnit: '1s',
      startRate: ${rate},
      preAllocatedVUs: ${preAllocatedVUs},
      maxVUs: ${maxVUs},
      stages: [
        { target: ${rate}, duration: '30s' },
        { target: ${rate}, duration: '${duration}' },
        { target: 0, duration: '15s' },
      ],
    },
  }
Do NOT include a top-level options.stages or options.vus — scenarios replaces both. ${rate} here is requests PER SECOND at the target rate, not a concurrent-VU count.`;
    }

    default: { // 'load'
      const rampLine = opts.rampUp
        ? `Ramp up from 0 to ${vus} VUs over ${opts.rampUp}, hold for ${duration}, then ramp down over 10s.`
        : `Start immediately at ${vus} VUs for ${duration}. No ramp-up. Use options = { vus: ${vus}, duration: '${duration}' } (flat, no stages).`;
      return `Load profile: LOAD TEST\nVirtual Users: ${vus}\nDuration: ${duration}\n${rampLine}`;
    }
  }
};

const BACKEND_PROMPT = (test: TestRequest, abortConfig: CapacityAbortConfig): string => {
  const opts = test.options as { vus: number; duration: string; profile?: string; peakVus?: number; httpOptions?: { keepAlive?: boolean; timeout?: string; discardResponseBodies?: boolean }; headers?: Record<string, string> };
  const fallback = profileInstructions(opts, abortConfig);
  const isCapacity = opts.profile === 'capacity';
  const { p95, p90, p99, errorRateFrac } = k6Thresholds(test.thresholds);
  const http = opts.httpOptions;
  const httpSection = http ? `
HTTP options to apply:
${http.discardResponseBodies ? '- Set options.discardResponseBodies = true (skip response body parsing)' : ''}
${http.timeout ? `- Use const params = { timeout: '${http.timeout}' }; pass params to every http.request() call` : ''}
${http.keepAlive === false ? '- Add header Connection: close to params.headers to disable keep-alive' : ''}
`.trim() : '';

  const headers = opts.headers;
  const headersSection = headers && Object.keys(headers).length > 0
    ? `Custom headers to apply:\n- Define const customHeaders = ${JSON.stringify(headers)}; merge it into params.headers and pass params to every http.request()/http.get()/http.post() call`
    : '';

  return `
You are a performance testing expert. Generate a k6 load test script. ${USER_DATA_INSTRUCTION}

URL: ${fenceUserContent('target_url', test.targetUrl)}
User request: "${fenceUserContent('description', test.description)}"

IMPORTANT: If the user request above describes a specific test type, load shape, or parameters
(e.g. "spike test", "ramp to 200 VUs", "soak for 10 minutes", "capacity test until failure"),
use EXACTLY what the user described — ignore the fallback parameters below.

Fallback parameters (use only when the user request gives no load shape info):
${fallback}
${httpSection ? `\n${httpSection}` : ''}
${headersSection ? `\n${headersSection}\n` : ''}
Requirements:
- Use k6 JavaScript API (import from 'k6/http' and 'k6')
- Include realistic think time between requests (sleep 1-3s)
- Add checks for HTTP status AND at least one body/header assertion per request
${isCapacity
  ? '- This is a capacity/stress profile — use EXACTLY the options.thresholds object given in the capacity load-profile instructions above (with abortOnFail), not the plain-string form'
  : `- Always include multi-percentile thresholds — not just p(95) — plus error rate and checks: http_req_duration: ['p(90)<${p90}', 'p(95)<${p95}', 'p(99)<${p99}'] (adjust if description implies stricter SLO), http_req_failed rate < ${errorRateFrac}, and checks rate > 0.9 (at least 90% of check() assertions must pass — this is what catches a request that returns 200 but with the wrong body)`}
- Log failures WITH response content: capture check()'s boolean return value in a variable, and when it's false, console.error a line with the status, URL, and a truncated response body (e.g. \`const ok = check(res, {...}); if (!ok) console.error(\`FAILED \${res.status} \${res.request.url} body=\${(res.body || '').slice(0, 500)}\`);\`) right after the check — using check()'s own return value (not a separate status-only condition) means this also fires for a 2xx response that fails a body-correctness assertion, not just a non-2xx status. This is the only way a failure's actual response content shows up in the execution log, since k6 prints nothing for a failing check on its own
- For JSON APIs: set Content-Type: application/json header, use JSON.stringify for request body, call res.json() to parse
- For authenticated endpoints: read credentials from __ENV.USERNAME / __ENV.PASSWORD / __ENV.API_TOKEN — never hardcode secrets
- Return ONLY the JavaScript code, no markdown, no explanation

Common patterns to follow:
// JSON POST with auth
const payload = JSON.stringify({ username: __ENV.USERNAME, password: __ENV.PASSWORD });
const params = { headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${__ENV.API_TOKEN}\` } };
const res = http.post('${test.targetUrl}', payload, params);
const ok = check(res, { 'status 200': (r) => r.status === 200, 'has id': (r) => r.json('id') !== undefined });
if (!ok) console.error(\`FAILED \${res.status} \${res.request.url} body=\${(res.body || '').slice(0, 500)}\`);

// GET with query params
const res2 = http.get(\`\${__ENV.BASE_URL}/items?page=1&limit=20\`, params);
const ok2 = check(res2, { 'status 200': (r) => r.status === 200, 'non-empty list': (r) => r.json('items').length > 0 });
if (!ok2) console.error(\`FAILED \${res2.status} \${res2.request.url} body=\${(res2.body || '').slice(0, 500)}\`);

Structure:
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = { stages: [...], thresholds: { http_req_duration: ['p(90)<${p90}', 'p(95)<${p95}', 'p(99)<${p99}'], http_req_failed: ['rate<${errorRateFrac}'], checks: ['rate>0.9'] } };
export default function() { ... }
`;
};

const CLIENT_PROMPT = (test: TestRequest): string => {
  const opts = test.options as { sessions: number; headers?: Record<string, string> };
  const headers = opts.headers;
  const headersSection = headers && Object.keys(headers).length > 0
    ? `\nCustom headers: call await page.setExtraHTTPHeaders(${JSON.stringify(headers)}) on each page before navigation\n`
    : '';

  return `
You are a performance testing expert. Generate a Puppeteer script for browser performance testing: ${USER_DATA_INSTRUCTION}

URL: ${fenceUserContent('target_url', test.targetUrl)}
Description: ${fenceUserContent('description', test.description)}
Sessions: ${opts.sessions}
${headersSection}
Requirements:
- Use Puppeteer with async/await (CommonJS require, not ESM import)
- Collect Web Vitals: LCP, FCP, TTFB, CLS — inject PerformanceObserver before page.goto()
- Collect INP (Interaction to Next Paint) via PerformanceObserver with type 'event'
- Simulate realistic user interactions: waitForSelector, scroll, click, waitForNetworkIdle
- Track JS errors via page.on('pageerror', ...) and console errors via page.on('console', msg => msg.type() === 'error')
- Run ${opts.sessions} sessions sequentially in a single browser instance (share browser, new page per session)
- Return performance metrics at the end: { lcp, fcp, ttfb, cls, inp, jsErrors }
- Return ONLY the JavaScript code, no markdown, no explanation

Web Vitals injection pattern (call before every page.goto()):
await page.evaluateOnNewDocument(() => {
  window.__wv = { lcp: 0, cls: 0, inp: 0 };
  new PerformanceObserver(l => l.getEntries().forEach(e => { window.__wv.lcp = e.startTime; }))
    .observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver(l => l.getEntries().forEach(e => {
    if (!e.hadRecentInput) window.__wv.cls += e.value;
  })).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver(l => l.getEntries().forEach(e => {
    if (e.duration > (window.__wv.inp || 0)) window.__wv.inp = e.duration;
  })).observe({ type: 'event', buffered: true, durationThreshold: 16 });
});

TTFB from NavigationTiming:
const ttfb = await page.evaluate(() => {
  const t = performance.getEntriesByType('navigation')[0];
  return t ? t.responseStart - t.requestStart : 0;
});

FCP from paint timing:
const fcp = await page.evaluate(() => {
  const e = performance.getEntriesByName('first-contentful-paint')[0];
  return e ? e.startTime : 0;
});

Interaction pattern (after page loads):
await page.waitForSelector('main, article, [data-testid], h1', { timeout: 10000 }).catch(() => {});
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 3));

Structure:
const puppeteer = require('puppeteer');
module.exports = async function run() {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const results = [];
  for (let i = 0; i < ${opts.sessions}; i++) {
    const page = await browser.newPage();
    // inject vitals, navigate, interact, collect metrics, page.close()
    results.push({ lcp, fcp, ttfb, cls, inp });
  }
  await browser.close();
  return results;
};
`;
};

const renderExtractLine = (varName: string, rule: ExtractRule): string => {
  switch (rule.source) {
    case 'header':   return `  - ${varName} ← header["${rule.expression}"]`;
    case 'cookie':   return `  - ${varName} ← cookie["${rule.expression}"]`;
    case 'regex':    return `  - ${varName} ← regex: ${rule.expression}`;
    default:         return `  - ${varName} ← jsonpath: ${rule.expression}`;
  }
};

const FLOW_PROMPT = (test: TestRequest, abortConfig: CapacityAbortConfig): string => {
  const steps = test.steps!;
  const opts = test.options as { vus: number; duration: string; profile?: string; peakVus?: number };
  const fallback = profileInstructions(opts, abortConfig);
  const isCapacity = opts.profile === 'capacity';
  const { p95, p90, p99, errorRateFrac } = k6Thresholds(test.thresholds);

  const hasExtractions = steps.some(s => s.extract && Object.keys(s.extract).length > 0);

  const stepDefs = steps.map((s, i) => {
    const lines: string[] = [
      `  Step ${i + 1}: ${s.name}`,
      `    URL: ${fenceUserContent('url', s.url)}`,
      `    Method: ${s.method}`,
    ];
    if (s.body) lines.push(`    Body: ${fenceUserContent('body', s.body)}`);
    if (s.headers && Object.keys(s.headers).length > 0) {
      lines.push(`    Headers: ${fenceUserContent('headers', JSON.stringify(s.headers))}`);
    }
    if (s.extract && Object.keys(s.extract).length > 0) {
      lines.push('    Extract variables:');
      for (const [varName, rule] of Object.entries(s.extract)) {
        lines.push(renderExtractLine(varName, rule));
      }
    }
    return lines.join('\n');
  }).join('\n\n');

  // Parameterization instructions
  const testDataColumns = test.testData && test.testData.length > 0
    ? Object.keys(test.testData[0])
    : null;
  const csvColumns = test.csvData
    ? (((): string[] | null => {
        try {
          const firstLine = Buffer.from(test.csvData, 'base64').toString('utf-8').split('\n')[0];
          return firstLine.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
        } catch { return null; }
      })())
    : null;

  const paramSection = testDataColumns
    ? `
Parameterization — inline data table (columns: ${testDataColumns.join(', ')}):
- REQUIRED: import { SharedArray } from 'k6/data';
- At top level (outside export default): const data = new SharedArray('testData', function() { return JSON.parse(open('./data.json')); });
- Inside export default: const row = data[(__VU - 1) % data.length];
- Use row.${testDataColumns[0]}, row.${testDataColumns[1] ?? testDataColumns[0]}, etc. in requests
`
    : csvColumns
    ? `
Parameterization — CSV file (columns: ${csvColumns.join(', ')}):
- REQUIRED: import { SharedArray } from 'k6/data';
- At top level: const data = new SharedArray('csvData', function() {
    const lines = open('./data.csv').split('\\n').filter(l => l.trim());
    return lines.slice(1).map(line => {
      const cols = line.split(',');
      return { ${csvColumns.map((c, i) => `${c}: cols[${i}]`).join(', ')} };
    });
  });
- Inside export default: const row = data[(__VU - 1) % data.length];
- Use row.${csvColumns[0]}, row.${csvColumns[1] ?? csvColumns[0]}, etc. in requests
`
    : '';

  const hasPlaceholders = steps.some(s =>
    (s.body && /\{\{\w+\}\}/.test(s.body)) ||
    (s.headers && Object.values(s.headers).some(v => /\{\{\w+\}\}/.test(v)))
  );

  const extractionInstructions = hasExtractions ? `
Extraction rules (for steps with "Extract variables"):
- jsonpath: access response.json() fields directly (e.g. response.json().data.id). No library needed.
- header: response.headers['Header-Name'] — use exact header name as specified
- cookie: response.cookies['name'][0].value
- regex: const m = response.body.match(/pattern/); use m[1] as the captured value

Error handling — MANDATORY for ALL extractions:
- Use a defensive fallback so the VU NEVER aborts mid-flow: const value = (res.status === 200 && res.json().field) || '';
- Assign the (possibly empty) value to vars and continue — ALL remaining group()s MUST still execute and record metrics even when an earlier extraction returned empty.
- DO NOT use exec.vu.abort() — aborting the VU hides steps 2..N from the metrics report entirely.

Dynamic URL paths — MANDATORY whenever a request URL interpolates an extracted variable (e.g. \`/products/\${vars.productId}\`):
- Set { tags: { name: '<templated path>' } } in that request's params object, using a fixed placeholder for the dynamic segment (e.g. { tags: { name: '/products/:id' } }) — never the interpolated value itself.
- Without this, k6 fragments metrics into a near-duplicate series per unique ID instead of aggregating them under one logical endpoint.
` : '';

  const placeholderInstructions = hasPlaceholders ? `
Variable placeholders:
- A step's Body or Headers may contain a literal "{{varName}}" placeholder (e.g. "Bearer {{access_token}}", "{\\"sessionId\\":\\"{{session_id}}\\"}").
- This means: substitute the value extracted into vars.varName by an earlier step's "Extract variables" rule at that exact position (e.g. \`Authorization: \`Bearer \${vars.access_token}\`\`).
- The earlier step that defines vars.varName always appears before the step using "{{varName}}" — locate it via its "Extract variables" entry for varName.
- Never leave the literal "{{varName}}" text in the generated script — always replace it with the corresponding \${vars.varName} reference.
` : '';

  const useSetup = test.setupFirstStep === true;
  const setupInstructions = useSetup ? `
Step 1 as a one-time precondition — MANDATORY structure change:
- Step 1 ("${steps[0].name}") is a one-time precondition (e.g. login), NOT the thing being load-tested. Move it OUT of the per-VU default function and INTO a k6 setup() function, so it runs exactly ONCE for the whole test run instead of once per VU per iteration.
- Structure: export function setup() { const vars = {}; group('Step 1: ...', function() { /* Step 1's request + checks + extraction, unchanged */ }); return vars; } — then export default function(data) { const vars = { ...data }; /* Steps 2..N as normal */ }
- Any values Step 1 extracts MUST be assigned onto the local \`vars\` object inside setup() and returned — that is the ONLY way steps 2..N (which receive it via the \`data\` parameter) can read them.
- Step 1's group() call goes ONLY inside setup() — do NOT also run it inside the default function.
- setup() runs once for the whole test, not once per VU — but treat a check()/extraction failure there the same defensively as any other step: never throw, fall back to a default value so steps 2..N can still run.
` : '';

  return `
You are a performance testing expert. Generate a k6 multi-step flow test script. ${USER_DATA_INSTRUCTION}

User request: "${fenceUserContent('description', test.description)}"

${fallback}
${paramSection}
Flow steps to test (IN ORDER):
${stepDefs}
${extractionInstructions}${placeholderInstructions}${setupInstructions}
Requirements:
- Use k6 JavaScript API with group() for EACH step
- Each step MUST be wrapped in: group('Step N: name', function() { ... })${useSetup ? ' — EXCEPT Step 1, which goes inside setup() per the instructions above, not inside the default function' : ''}
- Chain variables between steps: extract values from responses and use them in subsequent requests
- Chained extraction MUST be defensive: never call res.json() or access response fields unconditionally — guard with a status check or try/catch and fall back to a default value (e.g. const origin = (res.status === 200 && res.json().origin) || 'default'; or wrap in try { ... } catch { vars.x = 'default'; }). A parse failure on one step must NEVER throw and abort the rest of the iteration — every later group() must still run and be measured even if an earlier extraction failed
- Use __ENV.VAR_NAME for credentials (never hardcode passwords/tokens)
- Add check() assertions for BOTH response status (2xx) AND response body correctness in each group:
  * List/collection responses: assert the array is non-empty (e.g. 'has results': (r) => r.json().length > 0)
  * Single-item fetch-by-id: assert the returned id matches the requested id (e.g. 'correct id': (r) => r.json('id') === vars.productId)
  * Search/filter responses: assert at least one result matches the search term (e.g. 'result matches name': (r) => { try { const d = r.json(); return Array.isArray(d) && d.some(x => x.name === vars.productName); } catch { return false; } })
  * Create/POST: assert the returned object has the expected field(s) from the request body
  * Wrap body assertions in try/catch inside the check callback so a parse failure is a check failure (false), not an exception
- Log failures WITH response content: capture check()'s boolean return value in a variable, and when it's false, console.error a line with the step name, status, URL, and a truncated response body (e.g. \`const ok = check(res, {...}); if (!ok) console.error(\`FAILED [Step N] \${res.status} \${res.request.url} body=\${(res.body || '').slice(0, 500)}\`);\`) right after every check() call in every group — using check()'s own return value (not a separate status-only condition) means this also fires for a 2xx response that fails a body-correctness assertion, not just a non-2xx status. This is the only way a failure's actual response content shows up in the execution log, since k6 prints nothing for a failing check on its own
- After all groups, add sleep(1)
${isCapacity
  ? '- This is a capacity/stress profile — use EXACTLY the options.thresholds object given in the capacity load-profile instructions above (with abortOnFail), not the plain-string form'
  : `- Always include multi-percentile thresholds — not just p(95) — plus error rate and checks: http_req_duration: ['p(90)<${p90}', 'p(95)<${p95}', 'p(99)<${p99}'] (adjust if description implies stricter SLO), http_req_failed rate < ${errorRateFrac}, and checks rate > 0.9 (at least 90% of check() assertions must pass — this is what catches a step that returns 2xx but with the wrong body)`}
- Return ONLY the JavaScript code, no markdown fences, no explanation

Structure:
import http from 'k6/http';
import { check, sleep, group } from 'k6';

export const options = { stages: [...], thresholds: { http_req_duration: ['p(90)<${p90}', 'p(95)<${p95}', 'p(99)<${p99}'], http_req_failed: ['rate<${errorRateFrac}'], checks: ['rate>0.9'] } };

${useSetup ? `export function setup() {
  const vars = {};

  // Step 1 runs ONCE here, not per-VU — same defensive extraction rules as any other step.
  group('Step 1: Login', function() {
    const res = http.post('https://example.com/auth', JSON.stringify({ u: 'user' }), { headers: { 'Content-Type': 'application/json' } });
    const ok = check(res, {
      'login 200': (r) => r.status === 200,
      'has token': (r) => { try { return !!r.json('access_token'); } catch { return false; } },
    });
    if (!ok) console.error(\`FAILED [Step 1: Login] \${res.status} \${res.request.url} body=\${(res.body || '').slice(0, 500)}\`);
    vars.token = (res.status === 200 && res.json('access_token')) || '';   // defensive — falls back to '' so steps 2..N still run
    vars.userId = (res.status === 200 && res.json('user_id')) || '';      // defensive
  });

  return vars;
}

export default function(data) {
  const vars = { ...data };

  group('Step 2: Fetch data', function() {
    // Dynamic path segment (vars.userId) — tag with a fixed name so k6 aggregates
    // metrics per logical endpoint instead of fragmenting into one series per ID.
    const res = http.get(\`https://example.com/users/\${vars.userId}/data\`, { tags: { name: '/users/:id/data' }, headers: { 'Authorization': \`Bearer \${vars.token}\` } });
    const ok = check(res, {
      'data 200': (r) => r.status === 200,
      'non-empty list': (r) => { try { return r.json().length > 0; } catch { return false; } },
    });
    if (!ok) console.error(\`FAILED [Step 2: Fetch data] \${res.status} \${res.request.url} body=\${(res.body || '').slice(0, 500)}\`);
  });

  sleep(1);
}
` : `export default function() {
  const vars = {};

  // Example: step that extracts a token and passes it to the next step.
  // CRITICAL: never use exec.vu.abort() — all groups must always run so every step appears in metrics.
  group('Step 1: Login', function() {
    const res = http.post('https://example.com/auth', JSON.stringify({ u: 'user' }), { headers: { 'Content-Type': 'application/json' } });
    const ok = check(res, {
      'login 200': (r) => r.status === 200,
      'has token': (r) => { try { return !!r.json('access_token'); } catch { return false; } },
    });
    if (!ok) console.error(\`FAILED [Step 1: Login] \${res.status} \${res.request.url} body=\${(res.body || '').slice(0, 500)}\`);
    vars.token = (res.status === 200 && res.json('access_token')) || '';   // defensive — falls back to '' so step 2 still runs
    vars.userId = (res.status === 200 && res.json('user_id')) || '';      // defensive
  });

  group('Step 2: Fetch data', function() {
    // Dynamic path segment (vars.userId) — tag with a fixed name so k6 aggregates
    // metrics per logical endpoint instead of fragmenting into one series per ID.
    const res = http.get(\`https://example.com/users/\${vars.userId}/data\`, { tags: { name: '/users/:id/data' }, headers: { 'Authorization': \`Bearer \${vars.token}\` } });
    const ok = check(res, {
      'data 200': (r) => r.status === 200,
      'non-empty list': (r) => { try { return r.json().length > 0; } catch { return false; } },
    });
    if (!ok) console.error(\`FAILED [Step 2: Fetch data] \${res.status} \${res.request.url} body=\${(res.body || '').slice(0, 500)}\`);
  });

  sleep(1);
}
`}`;
};

/**
 * Returns true when an error represents an AI-provider rate-limit.
 * Checks both the structured `.status === 429` (standard HTTP error objects) and
 * message text — using a word-boundary-anchored pattern so "3429ms" or "failed after 3429"
 * do NOT false-positive, unlike the bare `.includes('429')` used in sibling services.
 */
const isRateLimitError = (err: unknown): boolean => {
  const e = err as { status?: number; message?: string };
  if (e.status === 429) return true;
  const msg = typeof e.message === 'string' ? e.message : '';
  // \b429\b: matches "429" as a standalone number; rejects "3429ms", "14299", etc.
  // "quota": targets quota-exhaustion messages emitted by AI providers.
  return /\b429\b/.test(msg) || msg.includes('quota');
};

export const compareDescriptions = async (
  newDescription: string,
  storedDescription: string,
  projectId?: string | null
): Promise<'REUSE' | 'REGENERATE'> => {
  const prompt = `You are a load test script classifier. ${USER_DATA_INSTRUCTION}

Stored description (used to generate the existing k6 script):
${fenceUserContent('stored_description', storedDescription)}

New description (what the user now wants to test):
${fenceUserContent('new_description', newDescription)}

Decide whether the existing script still satisfies the new description.
- REUSE: the test scenario, load shape, and key requirements are equivalent or compatible. Minor wording differences are fine.
- REGENERATE: the new description requires different behavior (different ramp shape, new ramp-down, different endpoints, different VU strategy, new steps, etc.).

Reply with exactly one word: REUSE or REGENERATE`;

  const setting = await getProviderSetting(projectId);
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const text = await generateAIText(prompt, setting);
      const verdict = text.trim().toUpperCase();
      if (verdict === 'REUSE' || verdict === 'REGENERATE') return verdict;
      log.warn({ verdict }, 'Unexpected comparison verdict, defaulting to REGENERATE');
      return 'REGENERATE';
    } catch (err: unknown) {
      if (isRateLimitError(err) && attempt < maxRetries) {
        const waitTime = 60000 * attempt;
        log.info({ waitSeconds: waitTime / 1000 }, 'Rate limited on comparison, waiting before retry');
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        log.error({ err }, 'compareDescriptions failed, defaulting to REGENERATE');
        return 'REGENERATE';
      }
    }
  }
  return 'REGENERATE';
};

export const generateScript = async (test: TestRequest): Promise<string> => {
  const setting = await getProviderSetting(test.projectId);
  // Only fetch the abort-threshold config for the one profile that uses it —
  // skips an extra results-service round-trip on every other generation.
  const isCapacityProfile = (test.type === 'backend' || test.type === 'flow')
    && (test.options as { profile?: string } | undefined)?.profile === 'capacity';
  const abortConfig = isCapacityProfile ? await getCapacityAbortConfig() : DEFAULT_CAPACITY_ABORT_CONFIG;
  const prompt = test.type === 'flow'
    ? FLOW_PROMPT(test, abortConfig)
    : test.type === 'backend'
      ? BACKEND_PROMPT(test, abortConfig)
      : CLIENT_PROMPT(test);

  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log.info({ testType: test.type, attempt }, 'Generating script');
      const script = await generateAIText(prompt, setting);
      log.info({ testType: test.type }, 'Script generated successfully');
      return script;
    } catch (err: unknown) {
      if (isRateLimitError(err) && attempt < maxRetries) {
        const waitTime = 60000 * attempt;
        log.info({ waitSeconds: waitTime / 1000 }, 'Rate limited, waiting before retry');
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        throw err;
      }
    }
  }

  throw new Error('Failed to generate script after retries');
};