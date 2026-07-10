import { TestRequest, ExtractRule, AiProviderSetting, DEFAULT_AI_PROVIDER_SETTING, generateAIText, fenceUserContent, USER_DATA_INSTRUCTION, SLOThresholds } from '@alt/shared';
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

// k6's own options.thresholds is a separate mechanism from the app's post-test
// SLO analysis (analyzeResult() in @alt/shared, which already honors test.thresholds).
// Without this, the generated script always hardcoded p(95)<1000 / rate<0.01
// regardless of what SLO the user actually configured (chat, home page, presets).
const k6Thresholds = (thresholds?: SLOThresholds): { p95: number; errorRateFrac: string } => ({
  p95: thresholds?.p95 ?? 1000,
  errorRateFrac: ((thresholds?.errorRate ?? 1) / 100).toString(),
});

const profileInstructions = (opts: { vus: number; duration: string; profile?: string; peakVus?: number; rampUp?: string }): string => {
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

    case 'capacity':
      return `Load profile: CAPACITY / STRESS TEST
Generate k6 stages that gradually increase load to find the breaking point:
- Ramp up from 0 to ${peak} VUs over ${duration}
- Do NOT hold — just keep ramping linearly
- Add a threshold: p(95) < 2000ms, error rate < 5%
The goal is to observe where response times degrade.`;

    case 'soak':
      return `Load profile: SOAK TEST
Generate k6 stages for a prolonged steady-state test:
- Ramp from 0 to ${vus} VUs over 1m
- Hold at ${vus} VUs for ${duration}
- Ramp down to 0 over 30s
Focus on memory leaks and degradation over time. Set a strict p(95) < 500ms threshold.`;

    default: { // 'load'
      const rampLine = opts.rampUp
        ? `Ramp up from 0 to ${vus} VUs over ${opts.rampUp}, hold for ${duration}, then ramp down over 10s.`
        : `Start immediately at ${vus} VUs for ${duration}. No ramp-up. Use options = { vus: ${vus}, duration: '${duration}' } (flat, no stages).`;
      return `Load profile: LOAD TEST\nVirtual Users: ${vus}\nDuration: ${duration}\n${rampLine}`;
    }
  }
};

const BACKEND_PROMPT = (test: TestRequest): string => {
  const opts = test.options as { vus: number; duration: string; profile?: string; peakVus?: number; httpOptions?: { keepAlive?: boolean; timeout?: string; discardResponseBodies?: boolean }; headers?: Record<string, string> };
  const fallback = profileInstructions(opts);
  const { p95, errorRateFrac } = k6Thresholds(test.thresholds);
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
- Always include thresholds: p(95) < ${p95} (adjust if description implies stricter SLO) and http_req_failed rate < ${errorRateFrac}
- Log failures: if res.status is 0 or >= 400, console.error a line with the status and URL (e.g. \`console.error(\`FAILED \${res.status} \${res.request.url}\`)\`) right after the check — this is the only way a failed request shows up in the execution log, since k6 does not print anything for a failing check or a non-2xx response on its own
- For JSON APIs: set Content-Type: application/json header, use JSON.stringify for request body, call res.json() to parse
- For authenticated endpoints: read credentials from __ENV.USERNAME / __ENV.PASSWORD / __ENV.API_TOKEN — never hardcode secrets
- Return ONLY the JavaScript code, no markdown, no explanation

Common patterns to follow:
// JSON POST with auth
const payload = JSON.stringify({ username: __ENV.USERNAME, password: __ENV.PASSWORD });
const params = { headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${__ENV.API_TOKEN}\` } };
const res = http.post('${test.targetUrl}', payload, params);
check(res, { 'status 200': (r) => r.status === 200, 'has id': (r) => r.json('id') !== undefined });
if (res.status === 0 || res.status >= 400) console.error(\`FAILED \${res.status} \${res.request.url}\`);

// GET with query params
const res = http.get(\`\${__ENV.BASE_URL}/items?page=1&limit=20\`, params);
check(res, { 'status 200': (r) => r.status === 200, 'non-empty list': (r) => r.json('items').length > 0 });
if (res.status === 0 || res.status >= 400) console.error(\`FAILED \${res.status} \${res.request.url}\`);

Structure:
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = { stages: [...], thresholds: { http_req_duration: ['p(95)<${p95}'], http_req_failed: ['rate<${errorRateFrac}'] } };
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

const FLOW_PROMPT = (test: TestRequest): string => {
  const steps = test.steps!;
  const opts = test.options as { vus: number; duration: string; profile?: string; peakVus?: number };
  const fallback = profileInstructions(opts);
  const { p95, errorRateFrac } = k6Thresholds(test.thresholds);

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
` : '';

  const placeholderInstructions = hasPlaceholders ? `
Variable placeholders:
- A step's Body or Headers may contain a literal "{{varName}}" placeholder (e.g. "Bearer {{access_token}}", "{\\"sessionId\\":\\"{{session_id}}\\"}").
- This means: substitute the value extracted into vars.varName by an earlier step's "Extract variables" rule at that exact position (e.g. \`Authorization: \`Bearer \${vars.access_token}\`\`).
- The earlier step that defines vars.varName always appears before the step using "{{varName}}" — locate it via its "Extract variables" entry for varName.
- Never leave the literal "{{varName}}" text in the generated script — always replace it with the corresponding \${vars.varName} reference.
` : '';

  return `
You are a performance testing expert. Generate a k6 multi-step flow test script. ${USER_DATA_INSTRUCTION}

User request: "${fenceUserContent('description', test.description)}"

${fallback}
${paramSection}
Flow steps to test (IN ORDER):
${stepDefs}
${extractionInstructions}${placeholderInstructions}
Requirements:
- Use k6 JavaScript API with group() for EACH step
- Each step MUST be wrapped in: group('Step N: name', function() { ... })
- Chain variables between steps: extract values from responses and use them in subsequent requests
- Chained extraction MUST be defensive: never call res.json() or access response fields unconditionally — guard with a status check or try/catch and fall back to a default value (e.g. const origin = (res.status === 200 && res.json().origin) || 'default'; or wrap in try { ... } catch { vars.x = 'default'; }). A parse failure on one step must NEVER throw and abort the rest of the iteration — every later group() must still run and be measured even if an earlier extraction failed
- Use __ENV.VAR_NAME for credentials (never hardcode passwords/tokens)
- Add check() assertions for BOTH response status (2xx) AND response body correctness in each group:
  * List/collection responses: assert the array is non-empty (e.g. 'has results': (r) => r.json().length > 0)
  * Single-item fetch-by-id: assert the returned id matches the requested id (e.g. 'correct id': (r) => r.json('id') === vars.productId)
  * Search/filter responses: assert at least one result matches the search term (e.g. 'result matches name': (r) => { try { const d = r.json(); return Array.isArray(d) && d.some(x => x.name === vars.productName); } catch { return false; } })
  * Create/POST: assert the returned object has the expected field(s) from the request body
  * Wrap body assertions in try/catch inside the check callback so a parse failure is a check failure (false), not an exception
- After all groups, add sleep(1)
- Always include thresholds: p(95) < ${p95} (adjust if description implies stricter SLO) and http_req_failed rate < ${errorRateFrac}
- Return ONLY the JavaScript code, no markdown fences, no explanation

Structure:
import http from 'k6/http';
import { check, sleep, group } from 'k6';

export const options = { stages: [...], thresholds: { http_req_duration: ['p(95)<${p95}'], http_req_failed: ['rate<${errorRateFrac}'] } };

export default function() {
  const vars = {};

  // Example: step that extracts a token and passes it to the next step.
  // CRITICAL: never use exec.vu.abort() — all groups must always run so every step appears in metrics.
  group('Step 1: Login', function() {
    const res = http.post('https://example.com/auth', JSON.stringify({ u: 'user' }), { headers: { 'Content-Type': 'application/json' } });
    check(res, {
      'login 200': (r) => r.status === 200,
      'has token': (r) => { try { return !!r.json('access_token'); } catch { return false; } },
    });
    vars.token = (res.status === 200 && res.json('access_token')) || '';   // defensive — falls back to '' so step 2 still runs
  });

  group('Step 2: Fetch data', function() {
    const res = http.get('https://example.com/data', { headers: { 'Authorization': \`Bearer \${vars.token}\` } });
    check(res, {
      'data 200': (r) => r.status === 200,
      'non-empty list': (r) => { try { return r.json().length > 0; } catch { return false; } },
    });
  });

  sleep(1);
}
`;
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
  const prompt = test.type === 'flow'
    ? FLOW_PROMPT(test)
    : test.type === 'backend'
      ? BACKEND_PROMPT(test)
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