import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { FlowStep } from '@alt/shared';
import type { RecordingSessionInternal } from '../recorder';

// ── Mock heavy deps before importing index ────────────────────────────────────
// vi.hoisted ensures these are defined when vi.mock factory runs (mock hoisting)

const mockStartSession = vi.hoisted(() => vi.fn());
const mockStopSession  = vi.hoisted(() => vi.fn());
const mockToFlowSteps  = vi.hoisted(() => vi.fn());
const mockDetect       = vi.hoisted(() => vi.fn());

vi.mock('../recorder', () => ({
  startSession:          mockStartSession,
  stopSession:           mockStopSession,
  toFlowSteps:           mockToFlowSteps,
  compileIgnorePatterns: (patterns: string[]) => patterns.map(p => new RegExp(p)),
}));

vi.mock('../correlator', () => ({
  detectCorrelations: mockDetect,
}));

import { buildApp } from '../index';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeStep = (name: string): FlowStep => ({
  name,
  url: `https://example.com/${name}`,
  method: 'GET',
});

const makeSession = (id: string, overrides: Partial<RecordingSessionInternal> = {}): RecordingSessionInternal => {
  const { onStep, ...restOverrides } = overrides;
  return {
    id,
    status: 'active',
    browser: {} as never,
    page: { goto: vi.fn().mockResolvedValue(undefined) } as never,
    cdp: {} as never,
    pending: new Map(),
    completed: [],
    stepCount: 0,
    ignorePatterns: [],
    onStep: onStep ?? null,
    ...restOverrides,
  };
};

// ── Test setup ────────────────────────────────────────────────────────────────

let app: FastifyInstance;
let sessions: Map<string, RecordingSessionInternal>;
let completed: Map<string, { steps: FlowStep[]; at: number }>;

beforeEach(async () => {
  vi.clearAllMocks();
  sessions  = new Map();
  completed = new Map();
  mockToFlowSteps.mockReturnValue([]);
  mockDetect.mockResolvedValue([]);
  app = await buildApp(sessions, completed);
});

afterEach(async () => { await app.close(); });

// ─── POST /recordings/start ───────────────────────────────────────────────────

describe('POST /recordings/start', () => {
  it('returns an active session when browser launches successfully', async () => {
    const session = makeSession('test-id');
    mockStartSession.mockResolvedValue(session);

    const res = await app.inject({ method: 'POST', url: '/recordings/start', payload: {} });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('active');
    expect(body.stepCount).toBe(0);
    expect(body.noVncUrl).toBeDefined();
    expect(typeof body.id).toBe('string');
    expect(sessions.size).toBe(1);
  });

  it('navigates to targetUrl when provided', async () => {
    const session = makeSession('nav-id');
    mockStartSession.mockResolvedValue(session);

    await app.inject({
      method: 'POST',
      url: '/recordings/start',
      payload: { targetUrl: 'https://example.com' },
    });

    expect(session.page.goto).toHaveBeenCalledWith('https://example.com', expect.anything());
  });

  it('still returns 200 when navigation fails (user can navigate manually)', async () => {
    const session = makeSession('nav-fail-id');
    (session.page.goto as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));
    mockStartSession.mockResolvedValue(session);

    const res = await app.inject({
      method: 'POST',
      url: '/recordings/start',
      payload: { targetUrl: 'https://slow.example.com' },
    });

    expect(res.statusCode).toBe(200);
  });

  it('returns 500 when browser fails to launch', async () => {
    mockStartSession.mockRejectedValue(new Error('DISPLAY not set'));

    const res = await app.inject({ method: 'POST', url: '/recordings/start', payload: {} });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/Failed to launch/);
    expect(sessions.size).toBe(0);
  });
});

// ─── GET /recordings/:id ──────────────────────────────────────────────────────

describe('GET /recordings/:id', () => {
  it('returns live session data while recording is active', async () => {
    const id = 'active-id';
    sessions.set(id, makeSession(id, { stepCount: 3 }));

    const res = await app.inject({ method: 'GET', url: `/recordings/${id}` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(id);
    expect(body.status).toBe('active');
    expect(body.stepCount).toBe(3);
    expect(body.steps).toBeUndefined(); // steps only in completed response
  });

  it('returns completed data with steps when session is in completed cache', async () => {
    const id = 'done-id';
    const steps = [makeStep('login'), makeStep('dashboard')];
    completed.set(id, { steps, at: Date.now() });

    const res = await app.inject({ method: 'GET', url: `/recordings/${id}` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('completed');
    expect(body.stepCount).toBe(2);
    expect(body.steps).toHaveLength(2);
    expect(body.steps[0].name).toBe('login');
  });

  it('returns 404 when session is neither active nor in completed cache', async () => {
    const res = await app.inject({ method: 'GET', url: '/recordings/unknown-id' });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it('normalizes internal stopping status to active so UI poll continues', async () => {
    const id = 'stopping-id';
    // Simulate session that is being processed (internal status = 'stopping')
    sessions.set(id, makeSession(id, { status: 'stopping', stepCount: 5 }));

    const res = await app.inject({ method: 'GET', url: `/recordings/${id}` });

    expect(res.statusCode).toBe(200);
    // Client must never see 'stopping' — it would kill the polling interval in the FlowBuilder
    expect(res.json().status).toBe('active');
    expect(res.json().stepCount).toBe(5);
  });

  it('prefers active session over completed cache when both present (should not happen but defensive)', async () => {
    const id = 'both-id';
    sessions.set(id, makeSession(id, { stepCount: 1 }));
    completed.set(id, { steps: [makeStep('x')], at: Date.now() });

    const res = await app.inject({ method: 'GET', url: `/recordings/${id}` });

    expect(res.json().status).toBe('active');
  });
});

// ─── POST /recordings/:id/stop ────────────────────────────────────────────────

describe('POST /recordings/:id/stop', () => {
  it('stops session, runs correlation and returns steps', async () => {
    const id = 'stop-id';
    const rawStep = makeStep('checkout');
    sessions.set(id, makeSession(id, { completed: [] }));
    mockStopSession.mockResolvedValue([]);
    mockToFlowSteps.mockReturnValue([rawStep]);
    mockDetect.mockResolvedValue([rawStep]);

    const res = await app.inject({ method: 'POST', url: `/recordings/${id}/stop` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('completed');
    expect(body.stepCount).toBe(1);
    expect(body.steps[0].name).toBe('checkout');
    // Session moves to completed cache and is removed from active map
    expect(sessions.has(id)).toBe(false);
    expect(completed.has(id)).toBe(true);
    expect(completed.get(id)!.steps).toHaveLength(1);
  });

  it('returns 404 when session does not exist', async () => {
    const res = await app.inject({ method: 'POST', url: '/recordings/nonexistent/stop' });

    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when session is already stopped', async () => {
    const id = 'already-stopped';
    sessions.set(id, makeSession(id, { status: 'completed' }));

    const res = await app.inject({ method: 'POST', url: `/recordings/${id}/stop` });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already stopped/i);
  });

  it('still returns steps when stopSession throws (uses accumulated completed requests)', async () => {
    const id = 'stop-error-id';
    const partial = makeStep('partial');
    sessions.set(id, makeSession(id, { completed: [] }));
    mockStopSession.mockRejectedValue(new Error('browser crashed'));
    mockToFlowSteps.mockReturnValue([partial]);
    mockDetect.mockResolvedValue([partial]);

    const res = await app.inject({ method: 'POST', url: `/recordings/${id}/stop` });

    expect(res.statusCode).toBe(200);
    expect(res.json().steps).toHaveLength(1);
  });

  it('stores enriched steps in completed cache for later polling', async () => {
    const id = 'cache-id';
    const step = makeStep('api-call');
    sessions.set(id, makeSession(id));
    mockStopSession.mockResolvedValue([]);
    mockToFlowSteps.mockReturnValue([step]);
    mockDetect.mockResolvedValue([step]);

    await app.inject({ method: 'POST', url: `/recordings/${id}/stop` });

    expect(completed.get(id)).toBeDefined();
    expect(completed.get(id)!.steps[0].name).toBe('api-call');
    // Timestamp should be recent
    expect(Date.now() - completed.get(id)!.at).toBeLessThan(1000);
  });
});

// ─── DELETE /recordings/:id ───────────────────────────────────────────────────

describe('DELETE /recordings/:id', () => {
  it('aborts session and removes it from active map', async () => {
    const id = 'delete-id';
    sessions.set(id, makeSession(id));
    mockStopSession.mockResolvedValue([]);

    const res = await app.inject({ method: 'DELETE', url: `/recordings/${id}` });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(sessions.has(id)).toBe(false);
    // Does NOT go to completed cache (abort path)
    expect(completed.has(id)).toBe(false);
  });

  it('returns 404 when session does not exist', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/recordings/ghost-id' });

    expect(res.statusCode).toBe(404);
  });

  it('still returns success even if stopSession throws during abort', async () => {
    const id = 'del-err-id';
    sessions.set(id, makeSession(id));
    mockStopSession.mockRejectedValue(new Error('browser already gone'));

    const res = await app.inject({ method: 'DELETE', url: `/recordings/${id}` });

    expect(res.statusCode).toBe(200);
    expect(sessions.has(id)).toBe(false);
  });
});

// ─── GET /viewer/:id ──────────────────────────────────────────────────────────

describe('GET /viewer/:id', () => {
  const viewerId = '52aef63c-6746-4b03-a3de-42b6f4892847';

  it('returns HTML with correct content-type', async () => {
    const res = await app.inject({ method: 'GET', url: `/viewer/${viewerId}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('includes the session id in the HTML', async () => {
    const res = await app.inject({ method: 'GET', url: `/viewer/${viewerId}` });

    expect(res.body).toContain(viewerId);
  });

  it('includes the Stop Recording button', async () => {
    const res = await app.inject({ method: 'GET', url: `/viewer/${viewerId}` });

    expect(res.body).toContain('Stop Recording');
    expect(res.body).toContain('doStop()');
  });

  it('includes the window.opener callback for step import', async () => {
    const res = await app.inject({ method: 'GET', url: `/viewer/${viewerId}` });

    expect(res.body).toContain('window.opener');
    expect(res.body).toContain('__recordingDone');
  });

  it('includes the noVNC open button', async () => {
    const res = await app.inject({ method: 'GET', url: `/viewer/${viewerId}` });

    expect(res.body).toContain('Open Browser');
    expect(res.body).toContain('noVNC');
  });

  it('truncates id to 8 chars in the page title', async () => {
    const res = await app.inject({ method: 'GET', url: `/viewer/${viewerId}` });

    expect(res.body).toContain(`Recording — ${viewerId.slice(0, 8)}`);
  });
});

// ─── GET /health ──────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns ok with active session count', async () => {
    sessions.set('s1', makeSession('s1'));
    sessions.set('s2', makeSession('s2'));

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.checks.sessions).toContain('2');
  });
});

// ─── completedResults cache behaviour ─────────────────────────────────────────

describe('completedResults cache — cross-endpoint', () => {
  it('GET after stop returns completed data with steps', async () => {
    const id = 'roundtrip-id';
    const step = makeStep('list-items');
    sessions.set(id, makeSession(id));
    mockStopSession.mockResolvedValue([]);
    mockToFlowSteps.mockReturnValue([step]);
    mockDetect.mockResolvedValue([step]);

    // Stop the recording
    await app.inject({ method: 'POST', url: `/recordings/${id}/stop` });

    // Poll after stop — should find completed result
    const poll = await app.inject({ method: 'GET', url: `/recordings/${id}` });

    expect(poll.statusCode).toBe(200);
    expect(poll.json().status).toBe('completed');
    expect(poll.json().steps).toHaveLength(1);
    expect(poll.json().steps[0].name).toBe('list-items');
  });

  it('GET after delete returns 404 (delete does not add to completed cache)', async () => {
    const id = 'abort-id';
    sessions.set(id, makeSession(id));
    mockStopSession.mockResolvedValue([]);

    await app.inject({ method: 'DELETE', url: `/recordings/${id}` });
    const poll = await app.inject({ method: 'GET', url: `/recordings/${id}` });

    expect(poll.statusCode).toBe(404);
  });
});
