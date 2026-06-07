# ARCHITECTURE.md — AI Load Testing Platform

Architecture, modules, data flows, and technical decisions.

## System Architecture

```
User → UI (Vite/React, :3006)
  │
  ├─ POST /tests → api-service (:3000)
  │    ├─ [cache miss]      → RabbitMQ: ai-requests → ai-service → backend-tests/client-tests
  │    ├─ [hit + no desc]   → inject k6 options → backend-tests/client-tests (skip AI)
  │    └─ [hit + desc]      → RabbitMQ: ai-requests (with cachedScript) → compareDescriptions()
  │
  ├─ ai-service → RabbitMQ: backend-tests OR client-tests
  │    worker-backend (k6, :3002 health) OR worker-client (Puppeteer, :3003 health)
  │         └─ RabbitMQ: test-results → results-service (:3004)
  │                └─ POST /analyse → analyser-service (:3008)
  │                └─ WebSocket broadcast → UI
  │
  ├─ GET /results/** → results-service (:3004)
  ├─ ws://results-service/ws → WebSocket push (test:status, test:live, tests:changed)
  └─ Flow recording → recorder-service (:3007 + noVNC :6080)

Cancel path:
  POST /tests/:id/cancel → api-service → cancel-fanout exchange → all worker replicas

Scheduled path:
  node-cron (results-service) → POST /tests → same path as user-initiated
```

## Services

| Service | Port | Responsibility |
|---------|------|----------------|
| api-service | 3000 | Fastify REST API, test routing, CORS, auth |
| ai-service | — | Gemini script generation, description comparison |
| analyser-service | 3008 | Deterministic analysis + Gemini AI insights |
| worker-backend | 3002 (health) | k6 runner, metrics parsing, live metrics POST |
| worker-client | 3003 (health) | Puppeteer + Lighthouse, Web Vitals |
| results-service | 3004 | PostgreSQL storage, REST API, WebSocket server, scheduler |
| recorder-service | 3007 + 6080 | Flow recorder (CDP capture + noVNC viewer) |
| ui | 3006 | Vite + React Router SPA |
| postgres | 5432 | Main database |
| rabbitmq | 5672 + 15672 | Message queue |
| redis | 6379 | Reserved (not yet used) |

## Message Queue Topology

| Queue / Exchange | Type | Producer | Consumer |
|-----------------|------|----------|---------|
| ai-requests | queue | api-service | ai-service |
| ai-requests.dlq | queue | ai-service | — (dead letter) |
| backend-tests | queue | api-service / ai-service | worker-backend |
| backend-tests.dlq | queue | worker-backend | — |
| client-tests | queue | api-service / ai-service | worker-client |
| client-tests.dlq | queue | worker-client | — |
| test-results | queue | workers | results-service |
| cancel-fanout | fanout | api-service | all worker replicas |

**DLQ policy:** x-retry-count header, 3 retries, then route to .dlq and mark test failed.

## Database Schema (key tables)

| Table | Purpose |
|-------|---------|
| test_results | Test run state, metrics, analysis, status |
| test_scripts | Generated k6/Puppeteer scripts (reused across tests) |
| live_metrics | 5-second streaming metric windows during execution |
| log_sources | External log deep-link URL templates |
| webhooks | Webhook endpoints (fired on failed/degraded) |
| schedules | node-cron schedule definitions |
| test_presets | Reusable test form presets |
| projects | Auth projects — `id` + `name`; all resource tables carry `project_id FK` |
| schema_migrations | Tracks applied numbered migrations (version, name, applied_at) |

## Three-Way Script Routing (api-service)

1. **Cache miss** → send to `ai-requests` → ai-service generates via Gemini
2. **Hit + no description** (or flow test) → inject new k6 options → bypass ai-service, send directly to worker queue; increment used_count
3. **Hit + description** → send to `ai-requests` with cachedScript + cachedScriptDescription → ai-service calls `compareDescriptions()` → REUSE or REGENERATE

## Real-time Strategy

| Mechanism | Frequency | Used For |
|-----------|-----------|---------|
| WebSocket push (/ws) | Event-driven | test:status, test:live, tests:changed |
| Polling /system/health | Every 15s | SystemHealth + WorkerHealth components |
| Polling /system/ai-status | Every 60s | AI status |
| Polling recorder-service | Every 1s | FlowBuilder recording progress |

## Security Architecture

- **API key auth**: X-API-Key header on api-service + results-service + recorder-service; exempt: /health, internal /results/pending
- **Cookie session auth**: `POST /auth/login` → `findOrCreateProject()` → HMAC-SHA256 signed `alt_session` cookie (HttpOnly, SameSite=Strict). `SESSION_SECRET` env var — empty = auth disabled (dev/test). Session middleware protects all routes except /health, /auth/*, and internal /results/pending.
- **Project-scoped data**: `project_id UUID` column on all resource tables. All queries filter by `($N::uuid IS NULL OR project_id = $N::uuid)` — null means auth is disabled.
- **CORS**: ALLOWED_ORIGIN env var; defaults to * in dev
- **Sensitive fields**: envVars/testData/csvData stripped from POST /tests response (safeTestResponse())
- **Pino redact**: envVars, testData, csvData masked in all service logs; metrics/previousMetrics masked in analyser-service
- **envVar injection**: k6 --env args validated against regex before spawn
- **Input validation**: URL with new URL() + http/https-only scheme check; description ≤ 500 chars; steps ≤ 20
- **SSRF protection**: recorder-service validateRecorderUrl() blocks RFC-1918 ranges and Docker-internal hostnames before page.goto()
- **Webhook HMAC**: X-Webhook-Signature: sha256=<hmac-sha256(secret, body)> computed server-side
- **Non-root containers**: all Dockerfiles use node user (UID 1000)
- **No hardcoded credentials**: services throw on missing env vars at startup

## Production Deployment (Caddy)

- `yourdomain.com` → UI (:3006)
- `api.yourdomain.com` → api-service (:3000)
- `data.yourdomain.com` → results-service (:3004)
- Internal ports hidden in prod; auto-TLS via Let's Encrypt

## Testing Architecture

| Layer | Framework | Isolation | Count |
|-------|-----------|-----------|-------|
| Unit | Vitest | In-process | ~111 tests |
| Integration | Vitest + Testcontainers | Real PostgreSQL | ~125 tests |
| UI | Vitest + RTL + jsdom | DOM simulation | ~49 tests |
| E2E | Playwright | Full stack (docker compose up) | 3 suites |

**Total: ~430 tests**

## AI Feature Architecture

All 14 AI features follow a consistent pattern: lazy Gemini calls (only when user triggers), non-fatal fallbacks, and `GEMINI_MODEL` env var for model override.

| Feature | Entry point | Backend endpoint | Model used |
|---------|-------------|-----------------|------------|
| AI-1 Threshold suggestions | `✨ Suggest` in SLO panel | `GET /results/suggest-thresholds` | GEMINI_MODEL |
| AI-2 Auto-name steps | Automatic after recording stop | `suggestStepNames()` in correlator.ts | GEMINI_MODEL |
| AI-3 Ignore suggestions | Automatic after recording stop | `suggestIgnorePatterns()` in correlator.ts | GEMINI_MODEL |
| AI-4 Error diagnosis | `✨ Diagnose with AI` on result page | `GET /results/:id/diagnose` | GEMINI_MODEL |
| AI-5 Cron assistant | Text box in Schedules form | `POST /ai/cron` | GEMINI_MODEL |
| AI-6 Playwright translator | File upload in Custom Script mode | `POST /translate` (ai-service) | GEMINI_MODEL |
| AI-7 Trend narrative | `✨ Summarise trend` on Trend chart | `POST /ai/trend-narrative` | GEMINI_MODEL |
| AI-8 PDF summary | Auto on every PDF download | inline in `/results/:id/report.pdf` | GEMINI_MODEL |
| AI-9 Settings recommendation | `✨ Suggest settings` below URL | `GET /results/suggest-settings` | GEMINI_MODEL |
| AI-10 Param suggestions | `✨ Suggest columns` in FlowBuilder | `POST /ai/param-suggestions` | GEMINI_MODEL |
| AI-11 Alert noise prediction | On webhook event toggle | `POST /ai/webhook-noise` | GEMINI_MODEL |
| AI-12 Think-time hints | Automatic — from timestamps | `computeThinkTimes()` in recorder.ts (pure) | — |
| AI-13 Step deduplication | Automatic after recording stop | `detectDuplicateSteps()` in correlator.ts (pure) | — |
| AI-14 Preset name | On "Save preset" click | `POST /ai/preset-name` | GEMINI_MODEL |

AI-12 and AI-13 are pure functions (no Gemini). All others degrade gracefully when `GEMINI_API_KEY` is absent or quota is exceeded.

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| ws (noServer) over @fastify/websocket | @fastify/websocket requires Fastify ^4.x; ws noServer attaches to same HTTP server, compatible with Fastify v5 |
| Vite over Next.js | Docker Desktop Windows filesystem latency (~574ms/op) caused Next.js lazy chunk compilation to exceed browser timeout |
| SHA-256 flow cache key | flow:<hex16> uniquely identifies step combination; avoids storing full step JSON in test_scripts.target_url |
| canonicalStep() before hashing | Property-order-sensitive JSON.stringify produced different keys for identical steps built via HAR vs manual vs re-run; canonical sort makes the key deterministic |
| Per-test run directories | Prevents file collisions at WORKER_CONCURRENCY > 1 |
| analyser-service as separate service | Isolates Gemini AI from results-service; 12s timeout with local fallback |
| analyzeResult in @alt/shared | Single source of truth for deterministic thresholds; eliminates 220-line duplication and future drift between results-service fallback and analyser-service primary |
| AMQP connection.on(close) reconnect | amqplib has no built-in reconnect; silent channel faults were leaving services unable to consume without any health signal; 5s reconnect restores service automatically |
| schema_migrations table | Numbered migration entries applied exactly once; idempotent ADD COLUMN IF NOT EXISTS pattern still used within each migration but guarded by version tracking |
| HMAC-SHA256 cookie sessions | JWT adds library complexity; signed cookies are HttpOnly and same-origin — no CSRF risk behind Caddy. `SESSION_SECRET` empty = auth disabled so local dev needs no config change |
| Vite proxy for /api + /data | Avoids CORS issues with cookies; same-origin requests mean SameSite=Strict cookies work without credentials: 'include' |
| @fastify/cookie v11 | v9.x only supported Fastify 4.x; v11 is the first release compatible with Fastify 5 |
| INP from Lighthouse preferred | Lighthouse `interaction-to-next-paint` audit measures the full interaction timeline (more accurate than PerformanceObserver event type which only measures pre-paint duration) |
