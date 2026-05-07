import { GoogleGenerativeAI } from '@google/generative-ai';

import { TestRequest } from '@alt/shared';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const BACKEND_PROMPT = (test: TestRequest): string => `
You are a performance testing expert. Generate a k6 load test script based on this request:

URL: ${test.targetUrl}
Description: ${test.description}
Virtual Users: ${(test.options as { vus: number }).vus}
Duration: ${(test.options as { duration: string }).duration}

Requirements:
- Use k6 JavaScript API
- Include realistic think time between requests
- Add checks for response status and response time
- Include thresholds for p95 response time
- Return ONLY the JavaScript code, no markdown, no explanation

Example structure:
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = { ... };
export default function() { ... }
`;

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

export const generateScript = async (test: TestRequest): Promise<string> => {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const prompt = test.type === 'backend'
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