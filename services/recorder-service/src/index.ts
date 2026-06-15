import './tracing';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { RecordingSession, FlowStep } from '@alt/shared';
import { startSession, stopSession, toFlowSteps, computeThinkTimes, compileIgnorePatterns, RecordingSessionInternal } from './recorder';
import { detectCorrelations, suggestStepNames, suggestIgnorePatterns, detectDuplicateSteps, correlatorRateLimited, DeduplicationSuggestion } from './correlator';
import { log } from './logger';

const PORT = Number(process.env.PORT) || 3007;
const NOVNC_URL = process.env.NOVNC_URL || `http://localhost:6080/vnc.html?autoconnect=true&resize=scale`;

// Auto-stop long-running or abandoned recording sessions so the headless
// browser + Gemini correlation don't run indefinitely if the user never clicks Stop.
const RECORDER_MAX_DURATION_MS = Number(process.env.RECORDER_MAX_DURATION_MS) || 30 * 60 * 1000; // 30 min
const RECORDER_IDLE_TIMEOUT_MS = Number(process.env.RECORDER_IDLE_TIMEOUT_MS) || 10 * 60 * 1000; // 10 min

// RFC-1918 + link-local + loopback + Docker-internal SSRF blocklist
const BLOCKED_HOSTNAME_RE = /^(localhost|.*\.local|host\.docker\.internal|.*\.internal|metadata\.google\.internal)$/i;
const PRIVATE_IPV4_RE = /^(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|127\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+)$/;

export const validateRecorderUrl = (raw: string): string | null => {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return 'Invalid URL'; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'URL must use http or https';
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAME_RE.test(host)) return 'URL targets a blocked internal hostname';
  if (PRIVATE_IPV4_RE.test(host)) return 'URL targets a private/internal IP range';
  return null;
};

// Active sessions: sessionId → internal state
const sessions = new Map<string, RecordingSessionInternal>();

// Completed results kept for 10 min so the UI can retrieve steps + AI suggestions after an external stop
interface CompletedResult {
  steps: FlowStep[];
  at: number;
  geminiRateLimited?: boolean;
  suggestedIgnore?: string[];
  thinkTimes?: number[];
  duplicates?: DeduplicationSuggestion[];
}
const completedResults = new Map<string, CompletedResult>();
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, r] of completedResults) {
    if (r.at < cutoff) completedResults.delete(id);
  }
}, 5 * 60 * 1000);

// ── App factory (exported for testing) ───────────────────────────────────────

export async function buildApp(
  _sessions = sessions,
  _completed = completedResults,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(cors, {
    origin: process.env.ALLOWED_ORIGIN || '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  });

  // API key auth — exempt /health and /viewer/:id (browser UI page, opened directly)
  const apiKeys = (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
  if (apiKeys.length > 0) {
    app.addHook('onRequest', async (request, reply) => {
      if (request.url === '/health' || request.url.startsWith('/viewer/')) return;
      const key = request.headers['x-api-key'];
      if (!key || !apiKeys.includes(key as string)) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
    });
  }

  // ── Health ──────────────────────────────────────────────────────────────────
  app.get('/health', async () => ({
    status: 'ok',
    service: 'recorder-service',
    checks: {
      sessions: `${_sessions.size} active`,
      gemini: correlatorRateLimited ? 'rate_limited' : 'ok',
    },
    timestamp: new Date().toISOString(),
  }));

  // ── POST /recordings/start ──────────────────────────────────────────────────
  app.post<{ Body: { targetUrl?: string; ignorePatterns?: string[]; teamId?: string | null } }>('/recordings/start', async (request, reply) => {
    const sessionId = crypto.randomUUID();
    const ignorePatterns = compileIgnorePatterns(request.body?.ignorePatterns ?? []);

    let session: RecordingSessionInternal;
    try {
      session = await startSession(sessionId, () => { /* step callback — status polled by client */ }, ignorePatterns);
    } catch (err) {
      log.error({ err, sessionId }, 'Failed to start recording session');
      return reply.code(500).send({ error: 'Failed to launch recording browser — is DISPLAY set or noVNC running?' });
    }

    session.teamId = request.body?.teamId ?? null;
    _sessions.set(sessionId, session);

    if (request.body?.targetUrl) {
      const urlError = validateRecorderUrl(request.body.targetUrl);
      if (urlError) {
        await stopSession(session).catch(() => {});
        _sessions.delete(sessionId);
        return reply.code(400).send({ error: urlError });
      }
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
    const session = _sessions.get(request.params.id);
    if (session) {
      return {
        id: session.id,
        // Normalize internal 'stopping' to 'active' — the UI polls until 'completed'
        // which only appears once the session moves to the completedResults cache.
        status: session.status === 'stopping' ? 'active' : session.status,
        noVncUrl: NOVNC_URL,
        stepCount: session.stepCount,
      } as RecordingSession;
    }
    const done = _completed.get(request.params.id);
    if (done) {
      return {
        id: request.params.id,
        status: 'completed',
        noVncUrl: NOVNC_URL,
        steps: done.steps,
        stepCount: done.steps.length,
        ...(done.geminiRateLimited ? { geminiRateLimited: true } : {}),
        ...(done.suggestedIgnore ? { suggestedIgnore: done.suggestedIgnore } : {}),
        ...(done.thinkTimes ? { thinkTimes: done.thinkTimes } : {}),
        ...(done.duplicates ? { duplicates: done.duplicates } : {}),
      } as RecordingSession;
    }
    return reply.code(404).send({ error: 'Session not found' });
  });

  // Stops `session`, runs AI post-processing, and stores the result in `_completed`.
  // Shared by the manual /stop endpoint and the auto-stop sweep below. Callers must
  // have already verified session.status was not 'stopping'/'completed' and the
  // session has been removed from `_sessions` synchronously before calling this,
  // so a concurrent call can't process the same session twice.
  const finishSession = async (sessionId: string, session: RecordingSessionInternal) => {
    let capturedRequests;
    try {
      capturedRequests = await stopSession(session);
    } catch (err) {
      log.error({ err, sessionId }, 'Error stopping session');
      capturedRequests = [...session.completed];
    }

    const rawSteps = toFlowSteps(capturedRequests);
    const thinkTimes = computeThinkTimes(capturedRequests);
    const correlatedSteps = await detectCorrelations(capturedRequests, rawSteps, session.teamId);
    const [enrichedSteps, suggestedIgnore] = await Promise.all([
      suggestStepNames(correlatedSteps, session.teamId),
      suggestIgnorePatterns(capturedRequests, session.teamId),
    ]);
    const duplicates = detectDuplicateSteps(enrichedSteps);

    _completed.set(sessionId, {
      steps: enrichedSteps,
      at: Date.now(),
      ...(correlatorRateLimited ? { geminiRateLimited: true } : {}),
      ...(suggestedIgnore.length > 0 ? { suggestedIgnore } : {}),
      ...(thinkTimes.some(t => t > 500) ? { thinkTimes } : {}),
      ...(duplicates.length > 0 ? { duplicates } : {}),
    });

    log.info({ sessionId, stepCount: enrichedSteps.length, correlatorRateLimited }, 'Recording completed');
    return { enrichedSteps, suggestedIgnore, thinkTimes, duplicates };
  };

  // ── POST /recordings/:id/stop ───────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/recordings/:id/stop', async (request, reply) => {
    const session = _sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    if (session.status === 'stopping' || session.status === 'completed') {
      return reply.code(409).send({ error: 'Session already stopped' });
    }

    // Mark + remove synchronously (before any await) so a concurrent /stop call
    // or the auto-stop sweep can't also pass the check above and process this
    // session a second time (which would double the Gemini correlation calls).
    session.status = 'stopping';
    _sessions.delete(request.params.id);

    const { enrichedSteps, suggestedIgnore, thinkTimes, duplicates } = await finishSession(request.params.id, session);

    const response: RecordingSession & { geminiRateLimited?: boolean; suggestedIgnore?: string[]; thinkTimes?: number[]; duplicates?: typeof duplicates } = {
      id: request.params.id,
      status: 'completed',
      noVncUrl: NOVNC_URL,
      steps: enrichedSteps,
      stepCount: enrichedSteps.length,
      ...(correlatorRateLimited ? { geminiRateLimited: true } : {}),
      ...(suggestedIgnore.length > 0 ? { suggestedIgnore } : {}),
      ...(thinkTimes.some(t => t > 500) ? { thinkTimes } : {}),
      ...(duplicates.length > 0 ? { duplicates } : {}),
    };

    return response;
  });

  // ── Auto-stop sweep: end sessions that ran too long or went idle ────────────
  const autoStopInterval = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of _sessions) {
      if (session.status !== 'active') continue;
      const age = now - session.startedAt;
      const idle = now - session.lastActivityAt;
      if (age < RECORDER_MAX_DURATION_MS && idle < RECORDER_IDLE_TIMEOUT_MS) continue;

      session.status = 'stopping';
      _sessions.delete(sessionId);
      const reason = age >= RECORDER_MAX_DURATION_MS ? 'max duration exceeded' : 'idle timeout';
      log.warn({ sessionId, reason }, 'Auto-stopping recording session');
      finishSession(sessionId, session).catch((err) => {
        log.error({ err, sessionId }, 'Error auto-stopping session');
      });
    }
  }, 60 * 1000);
  app.addHook('onClose', () => clearInterval(autoStopInterval));

  // ── GET /viewer/:id — recording control panel (noVNC opens in its own tab) ───
  app.get<{ Params: { id: string } }>('/viewer/:id', async (request, reply) => {
    const { id } = request.params;
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><circle cx='5' cy='5' r='5' fill='%23f85149'/></svg>">
  <title>Recording — ${id.slice(0, 8)}</title>
  <style>
    *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
    body{background:#0d1117;display:flex;flex-direction:column;align-items:center;justify-content:center;
         min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e6edf3;padding:24px}
    .card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;max-width:480px;width:100%}
    .header{display:flex;align-items:center;gap:10px;margin-bottom:24px}
    .dot{width:10px;height:10px;border-radius:50%;background:#f85149;flex-shrink:0;
         animation:blink 1.2s ease-in-out infinite}
    @keyframes blink{0%,100%{opacity:1}50%{opacity:.25}}
    h1{font-size:16px;font-weight:600;margin:0}
    .steps{font-size:12px;font-family:ui-monospace,monospace;color:#8b949e;margin-top:2px}
    .open-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:10px 16px;
              border-radius:8px;border:1px solid #388bfd;background:transparent;color:#388bfd;
              font-size:13px;font-weight:600;cursor:pointer;text-decoration:none;margin-bottom:12px;
              transition:background .15s,color .15s}
    .open-btn:hover{background:#388bfd;color:#fff}
    .hint{font-size:11px;color:#57606a;text-align:center;margin-bottom:20px;line-height:1.6}
    .hint code{background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:1px 5px;
               font-family:ui-monospace,monospace;color:#a5d6ff}
    hr{border:none;border-top:1px solid #21262d;margin:20px 0}
    .stop-btn{width:100%;padding:10px 16px;border-radius:8px;border:1px solid #f85149;background:transparent;
              color:#f85149;font-size:13px;font-weight:600;cursor:pointer;transition:background .15s,color .15s}
    .stop-btn:hover:not(:disabled){background:#f85149;color:#fff}
    .stop-btn:disabled{border-color:#30363d;color:#8b949e;cursor:default}
    .msg{font-size:11px;font-family:ui-monospace,monospace;color:#3fb950;text-align:center;margin-top:10px;min-height:16px}
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="dot" id="dot"></div>
      <div>
        <h1 id="lbl">Recording in progress…</h1>
        <div class="steps" id="steps">0 requests captured</div>
      </div>
    </div>

    <a class="open-btn" href="${NOVNC_URL}" target="_blank" rel="noopener" id="open-link">
      🖥 Open Browser (noVNC) ↗
    </a>
    <p class="hint">
      Navigate your app in the browser tab that opens.<br>
      Use <code>host.docker.internal</code> instead of <code>localhost</code><br>
      to reach services on your host machine.
    </p>

    <hr>

    <button class="stop-btn" id="btn" onclick="doStop()">⏹ Stop Recording &amp; Import Steps</button>
    <div class="msg" id="msg"></div>
  </div>
  <script>
    var SID='${id}',done=false;
    window.open('${NOVNC_URL}','_blank','noopener,noreferrer');
    var poll=setInterval(function(){
      fetch('/recordings/'+SID).then(function(r){return r.json();}).then(function(d){
        var el=document.getElementById('steps');
        if(el)el.textContent=(d.stepCount||0)+' request'+(d.stepCount===1?'':'s')+' captured';
        if(d.status!=='active'&&!done){done=true;clearInterval(poll);markStopped();}
      }).catch(function(){});
    },1000);
    function doStop(){
      if(done)return;
      var btn=document.getElementById('btn');
      btn.disabled=true;btn.textContent='⏳ Processing…';
      document.getElementById('msg').textContent='Running AI correlation…';
      fetch('/recordings/'+SID+'/stop',{method:'POST'})
        .then(function(r){return r.json();})
        .then(function(result){
          done=true;clearInterval(poll);
          if(window.opener&&typeof window.opener.__recordingDone==='function'){
            window.opener.__recordingDone(result);
          }
          markStopped();
        })
        .catch(function(){
          btn.disabled=false;btn.textContent='⏹ Stop Recording &amp; Import Steps';
          document.getElementById('msg').textContent='Error — try again';
        });
    }
    function markStopped(){
      var dot=document.getElementById('dot'),lbl=document.getElementById('lbl'),btn=document.getElementById('btn');
      dot.style.background='#3fb950';dot.style.animation='none';
      lbl.textContent='Recording stopped';lbl.style.color='#3fb950';
      btn.textContent='✓ Done — you can close this tab';
      document.getElementById('msg').textContent='Steps will appear in the FlowBuilder automatically.';
      document.getElementById('open-link').style.display='none';
    }
  </script>
</body>
</html>`;
    return reply.type('text/html').send(html);
  });

  // ── DELETE /recordings/:id — abort a session without returning steps ────────
  app.delete<{ Params: { id: string } }>('/recordings/:id', async (request, reply) => {
    const session = _sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    try { await stopSession(session); } catch { /* ignore */ }
    _sessions.delete(request.params.id);
    return { success: true };
  });

  return app;
}

// ── Startup ───────────────────────────────────────────────────────────────────
if (!process.env.VITEST) {
  (async () => {
    const app = await buildApp(sessions, completedResults);
    try {
      await app.listen({ port: PORT, host: '0.0.0.0' });
      log.info({ port: PORT }, 'recorder-service started');
    } catch (err) {
      log.error(err, 'Failed to start recorder-service');
      process.exit(1);
    }
  })();
}
