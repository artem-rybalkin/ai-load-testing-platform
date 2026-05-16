import { GoogleGenerativeAI } from '@google/generative-ai';

import { TestRequest } from '@alt/shared';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const profileInstructions = (opts: { vus: number; duration: string; profile?: string; peakVus?: number }): string => {
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

    default: // 'load'
      return `Load profile: LOAD TEST (constant)
Virtual Users: ${vus}
Duration: ${duration}
Ramp up from 0 to ${vus} VUs over 30s, hold for the duration, then ramp down.`;
  }
};

const BACKEND_PROMPT = (test: TestRequest): string => {
  const opts = test.options as { vus: number; duration: string; profile?: string; peakVus?: number };
  const fallback = profileInstructions(opts);
  return `
You are a performance testing expert. Generate a k6 load test script.

URL: ${test.targetUrl}
User request: "${test.description}"

IMPORTANT: If the user request above describes a specific test type, load shape, or parameters
(e.g. "spike test", "ramp to 200 VUs", "soak for 10 minutes", "capacity test until failure"),
use EXACTLY what the user described — ignore the fallback parameters below.

Fallback parameters (use only when the user request gives no load shape info):
${fallback}

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

const CLIENT_PROMPT = (test: TestRequest): string => `
You are a performance testing expert. Generate a Puppeteer script for browser performance testing:

URL: ${test.targetUrl}
Description: ${test.description}
Sessions: ${(test.options as { sessions: number }).sessions}

Requirements:
- Use Puppeteer with async/await
- Collect Web Vitals: LCP, FCP, TTFB, CLS
- Simulate realistic user interactions
- Return ONLY the JavaScript code, no markdown, no explanation
`;

const FLOW_PROMPT = (test: TestRequest): string => {
  const steps = test.steps!;
  const opts = test.options as { vus: number; duration: string; profile?: string; peakVus?: number };
  const fallback = profileInstructions(opts);

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
      lines.push(`    Extract into variables: ${JSON.stringify(s.extract)}`);
    }
    return lines.join('\n');
  }).join('\n\n');

  return `
You are a performance testing expert. Generate a k6 multi-step flow test script.

User request: "${test.description}"

${fallback}

Flow steps to test (IN ORDER):
${stepDefs}

Requirements:
- Use k6 JavaScript API with group() for EACH step
- Each step MUST be wrapped in: group('Step N: name', function() { ... })
- Chain variables between steps: extract values from responses and use them in subsequent requests
- Use __ENV.VAR_NAME for credentials (never hardcode passwords/tokens)
- Add check() assertions for response status (2xx) in each group
- After all groups, add sleep(1)
- Return ONLY the JavaScript code, no markdown fences, no explanation

Structure:
import http from 'k6/http';
import { check, sleep, group } from 'k6';

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
  storedDescription: string
): Promise<'REUSE' | 'REGENERATE'> => {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
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

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const verdict = result.response.text().trim().toUpperCase();
      if (verdict === 'REUSE' || verdict === 'REGENERATE') return verdict;
      console.warn(`Unexpected comparison verdict "${verdict}", defaulting to REGENERATE`);
      return 'REGENERATE';
    } catch (err: unknown) {
      const error = err as { status?: number };
      if (error.status === 429 && attempt < maxRetries) {
        const waitTime = 60000 * attempt;
        console.log(`Rate limited on comparison, waiting ${waitTime / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        console.error('compareDescriptions failed, defaulting to REGENERATE:', err);
        return 'REGENERATE';
      }
    }
  }
  return 'REGENERATE';
};

export const generateScript = async (test: TestRequest): Promise<string> => {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const prompt = test.type === 'flow'
    ? FLOW_PROMPT(test)
    : test.type === 'backend'
      ? BACKEND_PROMPT(test)
      : CLIENT_PROMPT(test);

  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Generating ${test.type} script (attempt ${attempt})...`);
      const result = await model.generateContent(prompt);
      const script = result.response.text();
      console.log('Script generated successfully');
      return script;
    } catch (err: unknown) {
      const error = err as { status?: number };
      if (error.status === 429 && attempt < maxRetries) {
        const waitTime = 60000 * attempt;
        console.log(`Rate limited, waiting ${waitTime / 1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        throw err;
      }
    }
  }

  throw new Error('Failed to generate script after retries');
};