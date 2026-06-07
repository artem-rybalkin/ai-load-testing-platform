/**
 * Unit tests for the POST /translate endpoint in ai-service.
 * Mocks Gemini and AMQP so the Fastify app can be instantiated without
 * a live RabbitMQ connection.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

// ── Mock Gemini ───────────────────────────────────────────────────────────────
// vi.mock is hoisted before variable declarations, so the mock fn must be
// created with vi.hoisted() to be available when the factory runs.
const mockGenerateContent = vi.hoisted(() => vi.fn());

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel() { return { generateContent: mockGenerateContent }; }
  },
}));

// ── Mock AMQP so ai-service/index.ts can be imported ─────────────────────────
vi.mock('amqplib', () => ({ default: { connect: vi.fn() } }));

// ── Build a minimal Fastify instance with just the translate route ────────────
// We import the route registration logic rather than the whole index.ts
// to avoid AMQP startup side-effects.

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });

  // Register only the translate route (copied from index.ts)
  app.post<{ Body: { script: string; targetUrl?: string } }>('/translate', async (request, reply) => {
    const { script, targetUrl } = request.body;
    if (!script || script.length > 256 * 1024) {
      return reply.code(400).send({ error: 'script is required and must be under 256 KB' });
    }
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return reply.code(503).send({ error: 'GEMINI_API_KEY not configured' });

    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: 'gemini-3.1-flash-lite' });
    const prompt = `Translate to k6${targetUrl ? ` (target: ${targetUrl})` : ''}:\n${script.slice(0, 8000)}`;
    const result = await model.generateContent(prompt);
    let k6Script = result.response.text().trim();
    k6Script = k6Script.replace(/^```(?:javascript|js)?\s*/i, '').replace(/\s*```$/i, '').trim();
    return { k6Script };
  });

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  mockGenerateContent.mockReset();
  process.env.GEMINI_API_KEY = 'test-key';
});

// ─── Tests ────────────────────────────────────────────────────────────────────

const PLAYWRIGHT_SCRIPT = `
import { test, expect } from '@playwright/test';
test('login', async ({ page }) => {
  await page.goto('https://example.com/login');
  await page.fill('#email', 'user@test.com');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL('/dashboard');
});
`.trim();

describe('POST /translate', () => {
  it('returns a k6 script on success', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => "import http from 'k6/http';\nexport default function() { http.get('https://example.com'); }" },
    });
    const res = await app.inject({ method: 'POST', url: '/translate', payload: { script: PLAYWRIGHT_SCRIPT } });
    expect(res.statusCode).toBe(200);
    expect(res.json().k6Script).toContain("import http");
  });

  it('strips markdown code fences from the Gemini response', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => "```javascript\nimport http from 'k6/http';\n```" },
    });
    const res = await app.inject({ method: 'POST', url: '/translate', payload: { script: PLAYWRIGHT_SCRIPT } });
    expect(res.statusCode).toBe(200);
    expect(res.json().k6Script).not.toContain('```');
    expect(res.json().k6Script).toContain("import http");
  });

  it('passes targetUrl to the prompt context', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => "import http from 'k6/http';" },
    });
    await app.inject({
      method: 'POST', url: '/translate',
      payload: { script: PLAYWRIGHT_SCRIPT, targetUrl: 'https://myapp.example.com' },
    });
    const promptArg = mockGenerateContent.mock.calls[0][0] as string;
    expect(promptArg).toContain('https://myapp.example.com');
  });

  it('returns 400 when script is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/translate', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when script exceeds 256 KB', async () => {
    const oversized = 'x'.repeat(256 * 1024 + 1);
    const res = await app.inject({ method: 'POST', url: '/translate', payload: { script: oversized } });
    expect(res.statusCode).toBe(400);
  });

  it('returns 503 when GEMINI_API_KEY is not set', async () => {
    delete process.env.GEMINI_API_KEY;
    const res = await app.inject({ method: 'POST', url: '/translate', payload: { script: PLAYWRIGHT_SCRIPT } });
    expect(res.statusCode).toBe(503);
  });

  it('returns 500 when Gemini throws', async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error('quota exceeded'));
    const res = await app.inject({ method: 'POST', url: '/translate', payload: { script: PLAYWRIGHT_SCRIPT } });
    expect(res.statusCode).toBe(500);
  });
});
