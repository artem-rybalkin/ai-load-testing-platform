import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../index';
import { publishTest, publishCancel, isQueueConnected } from '../queue';
import { findExistingScript, checkDbHealth, incrementUsedCount } from '../scripts';

vi.mock('../queue', () => ({
  publishTest: vi.fn(),
  publishCancel: vi.fn(),
  isQueueConnected: vi.fn().mockReturnValue(true),
  connectQueue: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../scripts', () => ({
  findExistingScript: vi.fn().mockResolvedValue(null),
  checkDbHealth: vi.fn().mockResolvedValue(undefined),
  incrementUsedCount: vi.fn().mockResolvedValue(undefined),
  stepsToKey: vi.fn().mockReturnValue('flow:abc123'),
}));

const mockPublishTest        = vi.mocked(publishTest);
const mockPublishCancel      = vi.mocked(publishCancel);
const mockIsQueueConnected   = vi.mocked(isQueueConnected);
const mockFindExistingScript = vi.mocked(findExistingScript);
const mockCheckDbHealth      = vi.mocked(checkDbHealth);
const mockIncrementUsedCount = vi.mocked(incrementUsedCount);

let app: FastifyInstance;
let mockFetch: ReturnType<typeof vi.fn>;

const validBody = {
  type: 'backend',
  targetUrl: 'http://example.com',
  description: 'smoke test',
  options: { vus: 5, duration: '30s' },
};

beforeAll(async () => {
  app = await buildApp();
  mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal('fetch', mockFetch);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockIsQueueConnected.mockReturnValue(true);
  mockFindExistingScript.mockResolvedValue(null);
  mockCheckDbHealth.mockResolvedValue(undefined);
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  mockIncrementUsedCount.mockResolvedValue(undefined);
});

// ─── POST /tests ──────────────────────────────────────────────────────────────

describe('POST /tests', () => {
  it('creates a pending record and publishes to queue for a new URL', async () => {
    const res = await app.inject({ method: 'POST', url: '/tests', payload: validBody });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.success).toBe(true);
    expect(json.scriptReused).toBe(false);
    expect(json.test.targetUrl).toBe('http://example.com');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/results/pending'),
      expect.objectContaining({ method: 'POST' })
    );
    const pendingBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(pendingBody.testId).toBe(json.test.id);
    expect(pendingBody.type).toBe('backend');
    expect(mockPublishTest).toHaveBeenCalledWith(expect.objectContaining({ targetUrl: 'http://example.com' }), false);
  });

  it('bypasses ai-service when cached script found and no description provided', async () => {
    mockFindExistingScript.mockResolvedValueOnce({
      id: 'script-id-1',
      script: 'export default function() {}',
      description: 'some stored description',
      usedCount: 5,
      targetUrl: 'http://example.com',
      testType: 'backend',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const noDescBody = { ...validBody, description: '' };
    const res = await app.inject({ method: 'POST', url: '/tests', payload: noDescBody });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.scriptReused).toBe(true);
    expect(json.test.reusedScript).toBe(true);
    expect(mockIncrementUsedCount).toHaveBeenCalledWith('script-id-1');
    expect(mockPublishTest).toHaveBeenCalledWith(expect.objectContaining({ reusedScript: true }), true);
  });

  it('routes through ai-service for description comparison when cached script and description are both present', async () => {
    mockFindExistingScript.mockResolvedValueOnce({
      id: 'script-id-2',
      script: 'export default function() {}',
      description: 'load test 10 users 1 min',
      usedCount: 3,
      targetUrl: 'http://example.com',
      testType: 'backend',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const res = await app.inject({ method: 'POST', url: '/tests', payload: validBody });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.scriptReused).toBe(false);
    expect(mockIncrementUsedCount).not.toHaveBeenCalled();
    expect(mockPublishTest).toHaveBeenCalledWith(
      expect.objectContaining({
        cachedScript: 'export default function() {}',
        cachedScriptDescription: 'load test 10 users 1 min',
        scriptId: 'script-id-2',
      }),
      false
    );
  });

  it('bypasses ai-service for flow tests even when description is provided', async () => {
    mockFindExistingScript.mockResolvedValueOnce({
      id: 'flow-script-id',
      script: 'export default function() {}',
      description: 'flow test',
      usedCount: 1,
      targetUrl: 'http://example.com',
      testType: 'backend',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const flowBody = {
      type: 'flow',
      targetUrl: 'http://example.com',
      description: 'different description',
      options: { vus: 5, duration: '30s' },
      steps: [{ name: 'home', url: 'http://example.com', method: 'GET' }],
    };
    const res = await app.inject({ method: 'POST', url: '/tests', payload: flowBody });
    expect(res.statusCode).toBe(200);
    expect(mockPublishTest).toHaveBeenCalledWith(expect.objectContaining({ reusedScript: true }), true);
  });

  it('returns 400 for an invalid test type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tests',
      payload: { ...validBody, type: 'unsupported' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Invalid test type');
    expect(mockPublishTest).not.toHaveBeenCalled();
  });

  it('generates a UUID for the test id', async () => {
    const res = await app.inject({ method: 'POST', url: '/tests', payload: validBody });
    const { test } = res.json();
    expect(test.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('passes thresholds through to the published test', async () => {
    const payload = { ...validBody, thresholds: { p95: 500, errorRate: 0.5 } };
    const res = await app.inject({ method: 'POST', url: '/tests', payload });
    expect(res.statusCode).toBe(200);
    expect(mockPublishTest).toHaveBeenCalledWith(
      expect.objectContaining({ thresholds: { p95: 500, errorRate: 0.5 } }),
      false
    );
  });
});

// ─── POST /tests/:testId/cancel ───────────────────────────────────────────────

describe('POST /tests/:testId/cancel', () => {
  it('forwards the cancel to results-service and publishes cancel message', async () => {
    const testId = '00000000-0000-0000-0000-000000000001';
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const res = await app.inject({ method: 'POST', url: `/tests/${testId}/cancel` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, testId });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/results/${testId}/cancel`),
      expect.objectContaining({ method: 'POST' })
    );
    expect(mockPublishCancel).toHaveBeenCalledWith(testId);
  });

  it('returns the error from results-service when cancel fails', async () => {
    const testId = '00000000-0000-0000-0000-000000000002';
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'test not found or not cancellable' }),
    });
    const res = await app.inject({ method: 'POST', url: `/tests/${testId}/cancel` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('not found');
    expect(mockPublishCancel).not.toHaveBeenCalled();
  });
});

// ─── GET /health ──────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 when DB and queue are healthy', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
    expect(res.json().checks.database).toBe('ok');
    expect(res.json().checks.queue).toBe('ok');
  });

  it('returns 503 when DB is down', async () => {
    mockCheckDbHealth.mockRejectedValueOnce(new Error('connection refused'));
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('degraded');
    expect(res.json().checks.database).toBe('error');
  });

  it('returns 503 when queue is disconnected', async () => {
    mockIsQueueConnected.mockReturnValueOnce(false);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('degraded');
    expect(res.json().checks.queue).toBe('disconnected');
  });
});
