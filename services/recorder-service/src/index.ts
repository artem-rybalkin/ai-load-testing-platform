import Fastify from 'fastify';
import cors from '@fastify/cors';
import { RecordingSession } from '@alt/shared';
import { startSession, stopSession, toFlowSteps, compileIgnorePatterns, RecordingSessionInternal } from './recorder';
import { detectCorrelations } from './correlator';
import { log } from './logger';

const PORT = Number(process.env.PORT) || 3007;
const NOVNC_URL = process.env.NOVNC_URL || `http://localhost:6080/vnc.html?autoconnect=true`;

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

  // ── GET /viewer/:id — wrapper page with noVNC iframe + Stop toolbar ─────────
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
    body{background:#0d1117;display:flex;flex-direction:column;height:100vh;overflow:hidden;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .bar{display:flex;align-items:center;gap:12px;padding:0 14px;
         background:#161b22;border-bottom:1px solid #30363d;height:42px;flex-shrink:0}
    .dot{width:8px;height:8px;border-radius:50%;background:#f85149;
         animation:blink 1.2s ease-in-out infinite;flex-shrink:0}
    @keyframes blink{0%,100%{opacity:1}50%{opacity:.25}}
    .lbl{font-size:12px;font-family:ui-monospace,monospace;color:#e6edf3;font-weight:600}
    .steps{font-size:11px;font-family:ui-monospace,monospace;color:#8b949e}
    .gap{flex:1}
    .msg{font-size:11px;font-family:ui-monospace,monospace;color:#3fb950}
    .btn{padding:4px 14px;border-radius:6px;border:1px solid #f85149;background:transparent;
         color:#f85149;font-size:12px;font-weight:600;cursor:pointer;transition:background .15s,color .15s}
    .btn:hover:not(:disabled){background:#f85149;color:#fff}
    .btn:disabled{border-color:#30363d;color:#8b949e;cursor:default}
    .frame-wrap{flex:1;position:relative;overflow:hidden}
    iframe{position:absolute;inset:0;border:none;width:100%;height:100%}
    .novnc-wait{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
                justify-content:center;gap:10px;color:#8b949e;font-family:ui-monospace,monospace;font-size:12px}
    .novnc-wait .spinner{width:20px;height:20px;border:2px solid #30363d;border-top-color:#8b949e;
                         border-radius:50%;animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .novnc-wait a{color:#0969da;text-decoration:none}
    .novnc-wait a:hover{text-decoration:underline}
  </style>
</head>
<body>
  <div class="bar">
    <div class="dot" id="dot"></div>
    <span class="lbl" id="lbl">Recording…</span>
    <span class="steps" id="steps"></span>
    <div class="gap"></div>
    <span class="msg" id="msg"></span>
    <button class="btn" id="btn" onclick="doStop()">⏹ Stop Recording</button>
  </div>
  <div class="frame-wrap">
    <div class="novnc-wait" id="wait">
      <div class="spinner"></div>
      <span>Connecting to browser…</span>
      <span style="color:#57606a;font-size:11px">If this takes more than 10 s, <a href="${NOVNC_URL}" target="_blank">open noVNC directly ↗</a></span>
    </div>
    <iframe id="vnc" src="${NOVNC_URL}" allow="clipboard-read; clipboard-write; autoplay"
            onload="document.getElementById('wait').style.display='none'"></iframe>
  </div>
  <script>
    var SID='${id}',done=false;
    var poll=setInterval(function(){
      fetch('/recordings/'+SID).then(function(r){return r.json();}).then(function(d){
        var el=document.getElementById('steps');
        if(el)el.textContent=d.stepCount?(d.stepCount+' request'+(d.stepCount===1?'':'s')+' captured'):'';
        if(d.status!=='active'&&!done){done=true;clearInterval(poll);markStopped();}
      }).catch(function(){});
    },1000);
    function doStop(){
      if(done)return;
      var btn=document.getElementById('btn');
      btn.disabled=true;btn.textContent='Stopping…';
      fetch('/recordings/'+SID+'/stop',{method:'POST'})
        .then(function(){done=true;clearInterval(poll);markStopped();})
        .catch(function(){
          btn.disabled=false;btn.textContent='⏹ Stop Recording';
          document.getElementById('msg').textContent='Error — try again';
        });
    }
    function markStopped(){
      var dot=document.getElementById('dot'),lbl=document.getElementById('lbl'),btn=document.getElementById('btn');
      dot.style.background='#8b949e';dot.style.animation='none';
      lbl.textContent='Stopped';lbl.style.color='#8b949e';
      btn.textContent='✓ Stopped';
      document.getElementById('msg').textContent='Steps captured — you can close this tab';
    }
  </script>
</body>
</html>`;
    return reply.type('text/html').send(html);
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
