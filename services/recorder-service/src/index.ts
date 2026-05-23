import Fastify from 'fastify';
import cors from '@fastify/cors';
import { RecordingSession } from '@alt/shared';
import { startSession, stopSession, toFlowSteps, compileIgnorePatterns, RecordingSessionInternal } from './recorder';
import { detectCorrelations } from './correlator';
import { log } from './logger';

const PORT = Number(process.env.PORT) || 3007;
const NOVNC_URL = process.env.NOVNC_URL || `http://localhost:6080`;

// Active sessions: sessionId → internal state
const sessions = new Map<string, RecordingSessionInternal>();

const app = Fastify({ logger: false });

(async () => {
  await app.register(cors, {
    origin: process.env.ALLOWED_ORIGIN || '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  });

  // ── Health ──────────────────────────────────────────────────────────────────
  app.get('/health', async () => ({
    status: 'ok',
    service: 'recorder-service',
    checks: { sessions: `${sessions.size} active` },
    timestamp: new Date().toISOString(),
  }));

  // ── POST /recordings/start ──────────────────────────────────────────────────
  app.post<{ Body: { targetUrl?: string; ignorePatterns?: string[] } }>('/recordings/start', async (request, reply) => {
    const sessionId = crypto.randomUUID();
    const ignorePatterns = compileIgnorePatterns(request.body?.ignorePatterns ?? []);

    let session: RecordingSessionInternal;
    try {
      session = await startSession(sessionId, () => { /* step callback — status polled by client */ }, ignorePatterns);
    } catch (err) {
      log.error({ err, sessionId }, 'Failed to start recording session');
      return reply.code(500).send({ error: 'Failed to launch recording browser — is DISPLAY set or noVNC running?' });
    }

    sessions.set(sessionId, session);

    // Navigate to targetUrl immediately if provided
    if (request.body?.targetUrl) {
      try {
        await session.page.goto(request.body.targetUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
      } catch { /* navigation may fail — user can type the URL manually in the browser */ }
    }

    const response: RecordingSession = {
      id: sessionId,
      status: 'active',
      noVncUrl: NOVNC_URL,
      stepCount: 0,
    };
    log.info({ sessionId, targetUrl: request.body?.targetUrl }, 'Recording session created');
    return response;
  });

  // ── GET /recordings/:id — polled by UI every second for live step count ─────
  app.get<{ Params: { id: string } }>('/recordings/:id', async (request, reply) => {
    const session = sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const response: RecordingSession = {
      id: session.id,
      status: session.status,
      noVncUrl: NOVNC_URL,
      stepCount: session.stepCount,
    };
    return response;
  });

  // ── POST /recordings/:id/stop ───────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/recordings/:id/stop', async (request, reply) => {
    const session = sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    if (session.status === 'stopping' || session.status === 'completed') {
      return reply.code(409).send({ error: 'Session already stopped' });
    }

    let capturedRequests;
    try {
      capturedRequests = await stopSession(session);
    } catch (err) {
      log.error({ err, sessionId: session.id }, 'Error stopping session');
      capturedRequests = [...session.completed];
    }

    // Convert to FlowSteps
    const rawSteps = toFlowSteps(capturedRequests);

    // AI correlation enrichment (best-effort — never fails the whole response)
    const enrichedSteps = await detectCorrelations(capturedRequests, rawSteps);

    sessions.delete(request.params.id);

    const response: RecordingSession = {
      id: request.params.id,
      status: 'completed',
      noVncUrl: NOVNC_URL,
      steps: enrichedSteps,
      stepCount: enrichedSteps.length,
    };

    log.info({ sessionId: request.params.id, stepCount: enrichedSteps.length }, 'Recording completed');
    return response;
  });

  // ── DELETE /recordings/:id — abort a session without returning steps ────────
  app.delete<{ Params: { id: string } }>('/recordings/:id', async (request, reply) => {
    const session = sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    try { await stopSession(session); } catch { /* ignore */ }
    sessions.delete(request.params.id);
    return { success: true };
  });

  // ── Start ───────────────────────────────────────────────────────────────────
  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    log.info({ port: PORT }, 'recorder-service started');
  } catch (err) {
    log.error(err, 'Failed to start recorder-service');
    process.exit(1);
  }
})();
