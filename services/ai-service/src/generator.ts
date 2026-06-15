import { TestRequest, ExtractRule, AiProviderSetting, DEFAULT_AI_PROVIDER_SETTING, generateAIText } from '@alt/shared';
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
  const opts = test.options as { vus: number; duration: string; profile?: string; peakVus?: number; httpOptions?: { keepAlive?: boolean; timeout?: string; http2?: boolean; discardResponseBodies?: boolean }; headers?: Record<string, string> };
  const fallback = profileInstructions(opts);
  const http = opts.httpOptions;
  const httpSection = http ? `
HTTP options to apply:
${http.http2 ? '- Set options.http2 = true (force HTTP/2)' : ''}
${http.discardResponseBodies ? '- Set options.discardResponseBodies = true (skip response body parsing)' : ''}
${http.timeout ? `- Use const params = { timeout: '${http.timeout}' }; pass params to every http.request() call` : ''}
${http.keepAlive === false ? '- Add header Connection: close to params.headers to disable keep-alive' : ''}
`.trim() : '';

  const headers = opts.headers;
  const headersSection = headers && Object.keys(headers).length > 0
    ? `Custom headers to apply:\n- Define const customHeaders = ${JSON.stringify(headers)}; merge it into params.headers and pass params to every http.request()/http.get()/http.post() call`
    : '';

  return `
You are a performance testing expert. Generate a k6 load test script.

URL: ${test.targetUrl}
User request: "${test.description}"

IMPORTANT: If the user request above describes a specific test type, load shape, or parameters
(e.g. "spike test", "ramp to 200 VUs", "soak for 10 minutes", "capacity test until failure"),
use EXACTLY what the user described — ignore the fallback parameters below.

Fallback parameters (use only when the user request gives no load shape info):
${fallback}
${httpSection ? `\n${httpSection}` : ''}
${headersSection ? `\n${headersSection}\n` : ''}
Requirements:
- Use k6 JavaScript API
- Include realistic think time between requests (sleep 1-3s)
- Add checks for response status and response time
- Return ONLY the JavaScript code, no markdown, no explanation

Structure:
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = { stages: [...], thresholds: {...} };
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
You are a performance testing expert. Generate a Puppeteer script for browser performance testing:

URL: ${test.targetUrl}
Description: ${test.description}
Sessions: ${opts.sessions}
${headersSection}
Requirements:
- Use Puppeteer with async/await
- Collect Web Vitals: LCP, FCP, TTFB, CLS
- Simulate realistic user interactions
- Return ONLY the JavaScript code, no markdown, no explanation
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

  const hasExtractions = steps.some(s => s.extract && Object.keys(s.extract).length > 0);

  const stepDefs = steps.map((s, i) => {
    const lines: string[] = [
      `  Step ${i + 1}: ${s.name}`,
      `    URL: ${s.url}`,
      `    Method: ${s.method}`,
    ];
    if (s.body) lines.push(`    Body: ${s.body}`);
    if (s.headers && Object.keys(s.headers).length > 0) {
      lines.push(`    Headers: ${JSON.stringify(s.headers)}`);
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
    ? (() => {
        try {
          const firstLine = Buffer.from(test.csvData, 'base64').toString('utf-8').split('\n')[0];
          return firstLine.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
        } catch { return null; }
      })()
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
- After every extraction: if (!value) { exec.vu.abort('<varName> not found in step N response'); }
- This stops only the failing VU, not the entire test — other VUs continue running for the full duration
- Import: import exec from 'k6/execution';
` : '';

  const placeholderInstructions = hasPlaceholders ? `
Variable placeholders:
- A step's Body or Headers may contain a literal "{{varName}}" placeholder (e.g. "Bearer {{access_token}}", "{\\"sessionId\\":\\"{{session_id}}\\"}").
- This means: substitute the value extracted into vars.varName by an earlier step's "Extract variables" rule at that exact position (e.g. \`Authorization: \`Bearer \${vars.access_token}\`\`).
- The earlier step that defines vars.varName always appears before the step using "{{varName}}" — locate it via its "Extract variables" entry for varName.
- Never leave the literal "{{varName}}" text in the generated script — always replace it with the corresponding \${vars.varName} reference.
` : '';

  return `
You are a performance testing expert. Generate a k6 multi-step flow test script.

User request: "${test.description}"

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
- Add check() assertions for response status (2xx) in each group
- After all groups, add sleep(1)
- Return ONLY the JavaScript code, no markdown fences, no explanation

Structure:
import http from 'k6/http';
import { check, sleep, group } from 'k6';
${hasExtractions ? "import exec from 'k6/execution';" : ''}

export const options = { stages: [...], thresholds: {...} };

export default function() {
  const vars = {};

  group('Step 1: ...', function() { /* request + check + extract */ });
  group('Step 2: ...', function() { /* use vars.token etc */ });

  sleep(1);
}
`;
};

export const compareDescriptions = async (
  newDescription: string,
  storedDescription: string,
  projectId?: string | null
): Promise<'REUSE' | 'REGENERATE'> => {
  const prompt = `You are a load test script classifier.

Stored description (used to generate the existing k6 script):
"""
${storedDescription}
"""

New description (what the user now wants to test):
"""
${newDescription}
"""

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
      const error = err as { status?: number };
      if (error.status === 429 && attempt < maxRetries) {
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
      const error = err as { status?: number };
      if (error.status === 429 && attempt < maxRetries) {
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