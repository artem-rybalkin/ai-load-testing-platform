import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp, parseDurationSeconds } from '../index';
import { publishTest, publishCancel, isQueueConnected, getWorkerConsumerCount } from '../queue';
import { findExistingScript, checkDbHealth, incrementUsedCount } from '../scripts';
import { getApiSession } from '../session';
import { checkTestQuota } from '../quotas';

vi.mock('../queue', () => ({
  publishTest: vi.fn(),
  publishCancel: vi.fn(),
  isQueueConnected: vi.fn().mockReturnValue(true),
  connectQueue: vi.fn().mockResolvedValue(undefined),
  getWorkerConsumerCount: vi.fn().mockResolvedValue(1),
}));

vi.mock('../scripts', () => ({
  findExistingScript: vi.fn().mockResolvedValue(null),
  checkDbHealth: vi.fn().mockResolvedValue(undefined),
  incrementUsedCount: vi.fn().mockResolvedValue(undefined),
  stepsToKey: vi.fn().mockReturnValue('flow:abc123'),
  pool: {},
}));

vi.mock('../session', () => ({
  getApiSession: vi.fn().mockResolvedValue(null),
}));

vi.mock('../quotas', () => ({
  checkTestQuota: vi.fn().mockResolvedValue(null),
}));

const mockPublishTest        = vi.mocked(publishTest);
const mockPublishCancel      = vi.mocked(publishCancel);
const mockIsQueueConnected   = vi.mocked(isQueueConnected);
const mockGetWorkerConsumerCount = vi.mocked(getWorkerConsumerCount);
const mockFindExistingScript = vi.mocked(findExistingScript);
const mockCheckDbHealth      = vi.mocked(checkDbHealth);
const mockIncrementUsedCount = vi.mocked(incrementUsedCount);
const mockGetApiSession      = vi.mocked(getApiSession);
const mockCheckTestQuota     = vi.mocked(checkTestQuota);

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
  mockGetWorkerConsumerCount.mockResolvedValue(1);
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

// ─── POST /tests — workspaceId contract ──────────────────────────────────────

describe('POST /tests — workspaceId passthrough contract', () => {
  it('passes workspaceId through to POST /results/pending when provided', async () => {
    const res = await app.inject({
      method: 'POST', url: '/tests',
      payload: { ...validBody, workspaceId: '00000000-0000-0000-0000-aabbccddeeff' },
    });
    expect(res.statusCode).toBe(200);
    const pendingBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(pendingBody.workspaceId).toBe('00000000-0000-0000-0000-aabbccddeeff');
  });

  it('passes workspaceId on the published test message when provided', async () => {
    await app.inject({
      method: 'POST', url: '/tests',
      payload: { ...validBody, workspaceId: '00000000-0000-0000-0000-aabbccddeeff' },
    });
    expect(mockPublishTest).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: '00000000-0000-0000-0000-aabbccddeeff' }),
      false,
    );
  });

  it('omits workspaceId from /results/pending body when not provided', async () => {
    await app.inject({ method: 'POST', url: '/tests', payload: validBody });
    const pendingBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(pendingBody.workspaceId).toBeUndefined();
  });
});

// ─── POST /tests — customScript bypass path ───────────────────────────────────

describe('POST /tests — customScript bypass', () => {
  const customScriptBody = {
    type: 'backend',
    targetUrl: 'http://example.com',
    description: '',
    options: { vus: 5, duration: '30s' },
    customScript: "import http from 'k6/http';\nexport default function() { http.get('http://example.com'); }",
  };

  it('routes directly to the worker queue without going through AI', async () => {
    const res = await app.inject({ method: 'POST', url: '/tests', payload: customScriptBody });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.success).toBe(true);
    expect(json.scriptReused).toBe(false);
    // skipAI = true → direct to worker queue (backend-tests), not ai-requests
    expect(mockPublishTest).toHaveBeenCalledWith(
      expect.objectContaining({ generatedScript: customScriptBody.customScript }),
      true
    );
  });

  it('does not look up or use the script cache', async () => {
    await app.inject({ method: 'POST', url: '/tests', payload: customScriptBody });
    expect(mockFindExistingScript).not.toHaveBeenCalled();
    expect(mockIncrementUsedCount).not.toHaveBeenCalled();
  });

  it('does not persist the custom script to the response or DB-bound fields', async () => {
    const res = await app.inject({ method: 'POST', url: '/tests', payload: customScriptBody });
    expect(res.statusCode).toBe(200);
    // customScript / generatedScript must never leak back in the HTTP response
    expect(res.json().test.customScript).toBeUndefined();
    expect(res.json().test.generatedScript).toBeUndefined();
  });

  it('returns 400 when customScript exceeds 512 KB', async () => {
    const oversized = 'a'.repeat(512 * 1024 + 1);
    const res = await app.inject({
      method: 'POST',
      url: '/tests',
      payload: { ...customScriptBody, customScript: oversized },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('512 KB');
    expect(mockPublishTest).not.toHaveBeenCalled();
  });

  it('accepts a customScript exactly at the 512 KB boundary', async () => {
    const atLimit = 'a'.repeat(512 * 1024);
    const res = await app.inject({
      method: 'POST',
      url: '/tests',
      payload: { ...customScriptBody, customScript: atLimit },
    });
    expect(res.statusCode).toBe(200);
    expect(mockPublishTest).toHaveBeenCalled();
  });
});

// ─── POST /tests — client-side tests skip AI/script-cache entirely ────────────
// worker-client never reads generatedScript/scriptId — it always runs its own
// native Puppeteer flow — so routing client-side tests through Gemini generation
// or description comparison burns quota/latency on output nothing consumes.

describe('POST /tests — client-side AI bypass', () => {
  const clientBody = {
    type: 'client-side',
    targetUrl: 'http://example.com',
    description: 'browser test',
    options: { sessions: 1, duration: '30s', collectWebVitals: true },
  };

  it('routes directly to the worker queue without ever consulting the script cache', async () => {
    const res = await app.inject({ method: 'POST', url: '/tests', payload: clientBody });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.success).toBe(true);
    expect(json.scriptReused).toBe(false);
    expect(mockFindExistingScript).not.toHaveBeenCalled();
    expect(mockIncrementUsedCount).not.toHaveBeenCalled();
    // skipAI = true → direct to worker queue (client-tests), not ai-requests
    expect(mockPublishTest).toHaveBeenCalledWith(expect.objectContaining({ type: 'client-side' }), true);
  });

  it('still skips AI even when a description is provided and a cached script exists', async () => {
    mockFindExistingScript.mockResolvedValueOnce({
      id: 'script-id-3',
      script: 'export default function() {}',
      description: 'some stored description',
      usedCount: 2,
      targetUrl: 'http://example.com',
      testType: 'client-side',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const res = await app.inject({ method: 'POST', url: '/tests', payload: clientBody });
    expect(res.statusCode).toBe(200);
    expect(mockFindExistingScript).not.toHaveBeenCalled();
    expect(mockPublishTest).toHaveBeenCalledWith(expect.objectContaining({ type: 'client-side' }), true);
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

// ─── POST /tests — parameterization passthrough ───────────────────────────────

describe('POST /tests — parameterization', () => {
  const flowBody = {
    type: 'flow',
    targetUrl: 'http://example.com',
    description: 'login flow',
    options: { vus: 2, duration: '30s' },
    steps: [{ name: 'Login', url: 'http://example.com/login', method: 'POST' }],
  };

  it('passes testData through to the published test', async () => {
    const testData = [{ username: 'user1', password: 'pass1' }];
    const res = await app.inject({
      method: 'POST',
      url: '/tests',
      payload: { ...flowBody, testData },
    });
    expect(res.statusCode).toBe(200);
    expect(mockPublishTest).toHaveBeenCalledWith(
      expect.objectContaining({ testData }),
      false
    );
  });

  it('passes csvData and csvFilename through to the published test', async () => {
    const csvData = Buffer.from('username,password\nuser1,pass1').toString('base64');
    const res = await app.inject({
      method: 'POST',
      url: '/tests',
      payload: { ...flowBody, csvData, csvFilename: 'users.csv' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockPublishTest).toHaveBeenCalledWith(
      expect.objectContaining({ csvData, csvFilename: 'users.csv' }),
      false
    );
  });

  it('publishes without testData when not provided', async () => {
    const res = await app.inject({ method: 'POST', url: '/tests', payload: flowBody });
    expect(res.statusCode).toBe(200);
    const published = mockPublishTest.mock.calls[0][0] as { testData?: unknown };
    expect(published.testData).toBeUndefined();
  });
});

// ─── POST /tests — sensitive fields never returned in HTTP response ───────────

describe('POST /tests — response does not leak sensitive fields', () => {
  it('strips envVars from the HTTP response even when provided in the request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tests',
      payload: { ...validBody, envVars: { SECRET_KEY: 'super-secret', DB_PASSWORD: 'hunter2' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().test.envVars).toBeUndefined();
  });

  it('strips testData from the HTTP response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tests',
      payload: {
        type: 'flow',
        targetUrl: 'http://example.com',
        description: 'login flow',
        options: { vus: 2, duration: '30s' },
        steps: [{ name: 'Login', url: 'http://example.com/login', method: 'POST' }],
        testData: [{ username: 'user1', password: 'pass1' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().test.testData).toBeUndefined();
  });

  it('strips csvData and csvFilename from the HTTP response', async () => {
    const csvData = Buffer.from('username,password\nuser1,pass1').toString('base64');
    const res = await app.inject({
      method: 'POST',
      url: '/tests',
      payload: {
        type: 'flow',
        targetUrl: 'http://example.com',
        description: 'login flow',
        options: { vus: 2, duration: '30s' },
        steps: [{ name: 'Login', url: 'http://example.com/login', method: 'POST' }],
        csvData,
        csvFilename: 'users.csv',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().test.csvData).toBeUndefined();
    expect(res.json().test.csvFilename).toBeUndefined();
  });

  it('still returns test.id, targetUrl, and type in the response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tests',
      payload: { ...validBody, envVars: { API_KEY: 'secret' } },
    });
    expect(res.statusCode).toBe(200);
    const { test } = res.json();
    expect(test.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(test.targetUrl).toBe('http://example.com');
    expect(test.type).toBe('backend');
  });
});

// ─── POST /tests — session-aware projectId + quota enforcement ────────────────

describe('POST /tests — session and quota enforcement', () => {
  let sessionApp: FastifyInstance;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'test-secret';
    sessionApp = await buildApp();
  });

  afterAll(async () => {
    delete process.env.SESSION_SECRET;
    await sessionApp.close();
  });

  beforeEach(() => {
    mockGetApiSession.mockReset();
    mockCheckTestQuota.mockReset().mockResolvedValue(null);
  });

  it('returns 401 when no valid session is present', async () => {
    mockGetApiSession.mockResolvedValueOnce(null);
    const res = await sessionApp.inject({ method: 'POST', url: '/tests', payload: validBody });
    expect(res.statusCode).toBe(401);
    expect(mockPublishTest).not.toHaveBeenCalled();
  });

  it('sets projectId from the session and forwards it to checkTestQuota', async () => {
    mockGetApiSession.mockResolvedValue({ projectId: 'team-123', role: 'admin' });
    const res = await sessionApp.inject({
      method: 'POST',
      url: '/tests',
      payload: validBody,
      cookies: { alt_session: 'sometoken' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().test.projectId).toBe('team-123');
    expect(mockCheckTestQuota).toHaveBeenCalledWith(
      expect.anything(),
      'team-123',
      expect.objectContaining({ type: 'backend', durationSeconds: 30 })
    );
  });

  it('returns 429 and does not publish when checkTestQuota rejects (over VUs/duration/concurrent)', async () => {
    mockGetApiSession.mockResolvedValue({ projectId: 'team-123', role: 'admin' });
    mockCheckTestQuota.mockResolvedValueOnce('Team has reached its concurrent test limit (max 1)');
    const res = await sessionApp.inject({
      method: 'POST',
      url: '/tests',
      payload: validBody,
      cookies: { alt_session: 'sometoken' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toContain('concurrent test limit');
    expect(mockPublishTest).not.toHaveBeenCalled();
  });

  it('returns 403 when the session has no current team (role is null)', async () => {
    mockGetApiSession.mockResolvedValue({ projectId: null, role: null });
    const res = await sessionApp.inject({
      method: 'POST',
      url: '/tests',
      payload: validBody,
      cookies: { alt_session: 'sometoken' },
    });
    expect(res.statusCode).toBe(403);
    expect(mockPublishTest).not.toHaveBeenCalled();
  });
});

// ─── POST /tests — X-Internal-Key trusted channel (regression) ───────────────
// Covers the documented production config: SESSION_SECRET set (RBAC on) but no
// separate global API_KEY for service-to-service callers like the scheduler.
// Previously, a scheduled-test trigger with no session and no API_KEY got
// rejected with 401 "Not authenticated" — silently, since the caller
// (results-service) didn't check the response status before marking success.

describe('POST /tests — X-Internal-Key trusted channel', () => {
  let internalApp: FastifyInstance;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'test-secret';
    process.env.INTERNAL_API_KEY = 'test-internal-key';
    internalApp = await buildApp();
  });

  afterAll(async () => {
    delete process.env.SESSION_SECRET;
    delete process.env.INTERNAL_API_KEY;
    await internalApp.close();
  });

  beforeEach(() => {
    mockCheckTestQuota.mockReset().mockResolvedValue(null);
  });

  it('rejects with 401 when neither a session cookie nor X-Internal-Key is present (the bug scenario)', async () => {
    mockGetApiSession.mockResolvedValueOnce(null);
    const res = await internalApp.inject({ method: 'POST', url: '/tests', payload: validBody });
    expect(res.statusCode).toBe(401);
    expect(mockPublishTest).not.toHaveBeenCalled();
  });

  it('accepts the request via X-Internal-Key with no session cookie, scoped to the body projectId', async () => {
    const res = await internalApp.inject({
      method: 'POST',
      url: '/tests',
      payload: { ...validBody, projectId: 'scheduled-team-456' },
      headers: { 'x-internal-key': 'test-internal-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().test.projectId).toBe('scheduled-team-456');
    expect(mockGetApiSession).not.toHaveBeenCalled();
  });

  it('rejects an incorrect X-Internal-Key', async () => {
    mockGetApiSession.mockResolvedValueOnce(null);
    const res = await internalApp.inject({
      method: 'POST',
      url: '/tests',
      payload: { ...validBody, projectId: 'scheduled-team-456' },
      headers: { 'x-internal-key': 'wrong-key' },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ─── POST /tests — duration validation ────────────────────────────────────────

describe('POST /tests — duration validation', () => {
  beforeEach(() => {
    mockCheckTestQuota.mockReset().mockResolvedValue(null);
  });

  it('rejects an unparseable duration with 400 instead of bypassing quota checks', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tests',
      payload: { ...validBody, options: { ...validBody.options, duration: 'forever' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Invalid duration');
    expect(mockPublishTest).not.toHaveBeenCalled();
  });

  it('accepts compound durations like "1h30m"', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tests',
      payload: { ...validBody, options: { ...validBody.options, duration: '1h30m' } },
    });
    expect(res.statusCode).toBe(200);
    expect(mockCheckTestQuota).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({ durationSeconds: 5400 })
    );
  });

  it('accepts a bare numeric duration as seconds', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tests',
      payload: { ...validBody, options: { ...validBody.options, duration: 45 } },
    });
    expect(res.statusCode).toBe(200);
    expect(mockCheckTestQuota).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({ durationSeconds: 45 })
    );
  });
});

// ─── POST /tests — worker-consumer-count warning message ──────────────────────

describe('POST /tests — no-worker warning message', () => {
  it('posts a backend (k6) worker warning when backend-tests has 0 consumers', async () => {
    mockGetWorkerConsumerCount.mockResolvedValueOnce(0);
    const res = await app.inject({ method: 'POST', url: '/tests', payload: validBody });
    expect(res.statusCode).toBe(200);
    expect(mockGetWorkerConsumerCount).toHaveBeenCalledWith('backend');

    const messageCall = mockFetch.mock.calls.find(([url]) =>
      typeof url === 'string' && url.includes('/message')
    );
    expect(messageCall).toBeDefined();
    const body = JSON.parse(messageCall![1].body);
    expect(body.message).toContain('No backend (k6) worker is running');
  });

  it('posts a browser (Puppeteer) worker warning when client-tests has 0 consumers', async () => {
    mockGetWorkerConsumerCount.mockResolvedValueOnce(0);
    const clientBody = {
      type: 'client-side',
      targetUrl: 'http://example.com',
      description: 'browser test',
      options: { sessions: 1, duration: '30s', collectWebVitals: true },
    };
    const res = await app.inject({ method: 'POST', url: '/tests', payload: clientBody });
    expect(res.statusCode).toBe(200);
    expect(mockGetWorkerConsumerCount).toHaveBeenCalledWith('client-side');

    const messageCall = mockFetch.mock.calls.find(([url]) =>
      typeof url === 'string' && url.includes('/message')
    );
    expect(messageCall).toBeDefined();
    const body = JSON.parse(messageCall![1].body);
    expect(body.message).toContain('No browser (Puppeteer) worker is running');
  });

  it('does not post a warning message when consumers are present', async () => {
    mockGetWorkerConsumerCount.mockResolvedValueOnce(2);
    await app.inject({ method: 'POST', url: '/tests', payload: validBody });

    const messageCall = mockFetch.mock.calls.find(([url]) =>
      typeof url === 'string' && url.includes('/message')
    );
    expect(messageCall).toBeUndefined();
  });
});

// ─── RBAC: viewer role not enforced on mutating routes (regression #1 / #2) ───
// Audit findings, fixed 2026-07-06:
//   #1 (High) — "viewer role isn't enforced on POST /tests or POST /tests/:testId/cancel"
//   #2 (High) — "customScript code execution is reachable by a viewer-role user"
//
// Fix: the onRequest hook (index.ts) now returns 403 for role === 'viewer' on
// every mutating method (POST/PUT/PATCH/DELETE) in the session-auth branch —
// api-service has no /teams or /orgs routes to except, unlike results-service.

describe('RBAC — viewer role not enforced on mutating routes (regression #1/#2)', () => {
  let viewerApp: FastifyInstance;

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'test-secret';
    viewerApp = await buildApp();
  });

  afterAll(async () => {
    delete process.env.SESSION_SECRET;
    await viewerApp.close();
  });

  beforeEach(() => {
    mockGetApiSession.mockReset();
    mockCheckTestQuota.mockReset().mockResolvedValue(null);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  });

  // Bug #1a: a viewer session should receive 403 on POST /tests, not 200.
  it('returns 403 for viewer role on POST /tests', async () => {
    mockGetApiSession.mockResolvedValue({ projectId: 'team-123', role: 'viewer' });
    const res = await viewerApp.inject({
      method: 'POST',
      url: '/tests',
      payload: validBody,
      cookies: { alt_session: 'viewertoken' },
    });
    expect(res.statusCode).toBe(403);
    expect(mockPublishTest).not.toHaveBeenCalled();
  });

  // Bug #1b: a viewer session should receive 403 on POST /tests/:testId/cancel, not 200.
  it('returns 403 for viewer role on POST /tests/:testId/cancel', async () => {
    mockGetApiSession.mockResolvedValue({ projectId: 'team-123', role: 'viewer' });
    const testId = '00000000-0000-0000-0000-000000000099';
    const res = await viewerApp.inject({
      method: 'POST',
      url: `/tests/${testId}/cancel`,
      cookies: { alt_session: 'viewertoken' },
    });
    expect(res.statusCode).toBe(403);
    expect(mockPublishCancel).not.toHaveBeenCalled();
  });

  // Bug #2: the same RBAC gap lets a viewer submit a customScript for direct execution.
  it('returns 403 for viewer role on POST /tests with customScript (code execution via RBAC gap)', async () => {
    mockGetApiSession.mockResolvedValue({ projectId: 'team-123', role: 'viewer' });
    const res = await viewerApp.inject({
      method: 'POST',
      url: '/tests',
      payload: {
        ...validBody,
        customScript: "import http from 'k6/http';\nexport default function() { http.get('http://example.com'); }",
      },
      cookies: { alt_session: 'viewertoken' },
    });
    expect(res.statusCode).toBe(403);
    expect(mockPublishTest).not.toHaveBeenCalled();
  });
});

// ─── parseDurationSeconds — "ms" unit misparsing (regression #4) ──────────────
// Audit finding #4 (Low):
//   "parseDurationSeconds() misparses any '…ms' duration as minutes (~60 000x inflation)"
//
// Root cause: regex alternation `(h|m|s|ms)` — JS RegExp matches the first
// successful branch, not the longest. For input "500ms" the engine matches unit
// 'm' (minutes) before it reaches 'ms', so 500 minutes = 30 000 seconds is
// returned instead of 500/1000 = 0.5 seconds.
//
// The fix is to reorder the alternation to put "ms" before "m": `(h|ms|m|s)`.

describe('parseDurationSeconds — ms unit misparsing regression (#4)', () => {
  // Fixed: regex reordered to `(h|ms|m|s)` so "ms" is matched before "m".
  // 500ms = 0.5 s, which Math.round rounds to 1. Before the fix the regex
  // matched 'm' (minutes) first and returned Math.round(500 * 60) = 30000.
  it('"500ms" should parse to 1 second (500 ms rounded, not 30000 s from the "m" unit bug)', () => {
    expect(parseDurationSeconds('500ms')).toBe(1);
  });
});
