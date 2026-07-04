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
| redis | 6379 | Shared store for @fastify/rate-limit (api-service + results-service) |

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

**DLQ policy:** x-retry-count header, 3 retries, then route to .dlq and mark test failed (see `docs/PATTERNS/rabbitmq-consumer-dlq.md`).

## Database Schema (key tables)

| Table | Purpose |
|-------|---------|
| test_results | Test run state, metrics, analysis, status |
| test_scripts | Generated k6/Puppeteer scripts (reused across tests) |
| live_metrics | Streaming metric windows during execution (admin-configurable aggregation window — 10s/30s/1min via Settings, default 30s; applies to new tests only) |
| log_sources | External log deep-link URL templates |
| webhooks | Webhook endpoints (fired on failed/degraded) |
| schedules | node-cron schedule definitions |
| test_presets | Reusable test form presets |
| projects | Auth projects ("teams") — `id`, `name`, `org_id` (nullable FK to organizations); all resource tables carry `project_id FK` |
| schema_migrations | Tracks applied numbered migrations (version, name, applied_at) |
| team_quotas | Per-team resource limits (concurrent tests, VUs, duration, scheduled tests, Gemini calls/day); absent row = `DEFAULT_TEAM_QUOTA` |
| gemini_usage | Per-team daily Gemini call counter (`team_id`, `usage_date`, `call_count`) for `/ai/*` quota enforcement |
| organizations | `id` + `name`; groups teams (`projects.org_id`) under an org admin panel |
| org_members | Maps users to organizations with `role IN ('owner','admin','member')` |
| team_api_keys | Per-team API keys (`key_hash` = sha256 of raw key); accepted as an alternative to session cookies, scoped to one team |

## Three-Way Script Routing (api-service)

`POST /tests` routes on cache state: cache miss generates via Gemini, cache hit with no description bypasses AI entirely, cache hit with a description asks `compareDescriptions()` to decide REUSE vs REGENERATE. Full decision tree: see `docs/PATTERNS/three-way-script-routing.md`.

## Real-time Strategy

| Mechanism | Frequency | Used For |
|-----------|-----------|---------|
| WebSocket push (/ws) | Event-driven | test:status, test:live, tests:changed |
| Polling /system/health | Every 15s | SystemHealth + WorkerHealth components |
| Polling /system/ai-status | Every 60s | AI status |
| Polling recorder-service | Every 1s | FlowBuilder recording progress |

## Security Architecture

- **API key auth**: X-API-Key header on api-service + results-service + recorder-service; exempt: /health, internal /results/pending
- **User accounts (Phase 3 Org/Team/RBAC)**: `users` table (email + bcrypt password hash via `bcryptjs`). `POST /auth/register { email, password, name?, teamName }` creates a user, a new team (`projects` row), an `admin` `team_members` row, and a session in one transaction. `POST /auth/login { email, password }` verifies via `bcrypt.compare`.
- **DB-backed sessions**: `sessions` table (`user_id`, `token_hash` = SHA-256 of a random 32-byte token, `team_id` = current team, `expires_at`, `revoked_at`). The raw token is set as the `alt_session` cookie (HttpOnly, SameSite=Strict, 30-day `maxAge`); only its hash is stored. `POST /auth/logout` sets `revoked_at`, immediately invalidating the cookie — closes the "no revocation" gap of the old HMAC-signed-cookie design. `SESSION_SECRET` env var now purely toggles whether session/RBAC enforcement is active — empty = auth disabled (dev/test), unchanged for the ~430 pre-existing tests.
- **Teams = projects**: "team" is the user-facing name for the existing `projects` table / `project_id` columns — kept as-is to avoid an 81-site rename. `team_members` (team_id, user_id, role) maps users to teams with `role IN ('admin','member','viewer')`. A user can belong to multiple teams; `sessions.team_id` tracks which team is "current" for that session, switchable via `POST /auth/switch-team`.
- **RBAC middleware**: the `onRequest` hook (when `SESSION_SECRET` set) loads `request.user`, `request.projectId` (= session's current `team_id`, feeding the existing project-scoping filters unchanged), and `request.role` (this user's role in the current team). A session with no current team is blocked (403) from all routes except `/teams` (create/join). On mutating methods (POST/PUT/PATCH/DELETE): `viewer` role gets 403 on resource routes; `/teams/:id/*` mutations additionally require `admin` role for that team. `/auth/*` routes are always exempt.
- **Team management**: `POST /teams` (any authenticated user creates+admins a new team), `GET/POST/PUT/DELETE /teams/:id/members` (admin-only mutations; "last admin" protection prevents demoting/removing the final admin of a team).
- **Session middleware** protects all routes except /health, /auth/*, internal /results/pending, and the internal POST variants of /running, /fail, /message, /live, /cancel (server-to-server, no cookie). `GET /results/:testId/live` is NOT exempt — it requires a session like other read endpoints, even though it shares the `/live` path suffix with the worker's internal POST.
- **Project-scoped data**: `project_id UUID` column on all resource tables. All queries filter by `($N::uuid IS NULL OR project_id = $N::uuid)` — null means auth is disabled. Covers results listing/detail, scripts (incl. `saveScript` upsert via `COALESCE(test_scripts.project_id, EXCLUDED.project_id)` so worker-inserted rows don't lose ownership), presets, schedules, webhooks, log sources, baseline set/clear, PDF report download, and live metrics (via `LEFT JOIN test_results` since `live_metrics` itself has no `project_id` column). `worker-client` propagates `projectId` on its `test-results` queue message so client-side test results are correctly attributed.
- **CORS**: ALLOWED_ORIGIN env var; defaults to * in dev
- **Sensitive fields**: envVars/testData/csvData stripped from POST /tests response (safeTestResponse())
- **Pino redact**: envVars, testData, csvData masked in all service logs; metrics/previousMetrics masked in analyser-service (see `docs/PATTERNS/pino-redact-logger.md`)
- **envVar injection**: k6 --env args validated against regex before spawn
- **Input validation**: URL with new URL() + http/https-only scheme check; description ≤ 500 chars; steps ≤ 20 (`POST /tests` returns 400 above this). FlowBuilder allows recording/HAR-import of up to 50 steps for review and trimming, but warns and blocks "Run Test" client-side once steps.length > 20.
- **SSRF protection**: recorder-service validateRecorderUrl() blocks RFC-1918 ranges and Docker-internal hostnames before page.goto()
- **Webhook HMAC**: X-Webhook-Signature: sha256=<hmac-sha256(secret, body)> computed server-side
- **Non-root containers**: all Dockerfiles use node user (UID 1000) (see `docs/PATTERNS/non-root-docker.md`)
- **No hardcoded credentials**: services throw on missing env vars at startup
- **api-service session bugfix (Phase 25)**: `api-service/src/session.ts` previously used a stale HMAC `verifySession()` that couldn't parse the Phase-24 opaque DB-backed session cookie, leaving `request.projectId` unset in production. Replaced with `getApiSession(pool, token)`, mirroring results-service's lookup (hash cookie token → `sessions` → `team_members` for role); `request.projectId`/`request.role` now populate correctly with `SESSION_SECRET` set.
- **Team quotas (Phase 25a)**: `team_quotas` row per team (falls back to `DEFAULT_TEAM_QUOTA` if absent) limits concurrent tests, max VUs/test, max test duration, max scheduled tests, and max Gemini calls/day. `checkTestQuota()` (api-service) gates `POST /tests` (429 on violation); `checkScheduleQuota()`/`checkGeminiQuota()`/`incrementGeminiUsage()` (results-service) gate `POST /schedules` and the explicit `/ai/*`/`suggest-*` endpoints. `GET/PUT /teams/:id/quotas` exposes usage + limits (admin-only edit); all checks are skipped (`teamId == null`) in dev mode.
- **Organizations (Phase 25b)**: `organizations` + `org_members` (`role IN ('owner','admin','member')`) sit above teams via `projects.org_id` (nullable — existing teams stay "ungrouped"). RBAC middleware additionally resolves `request.orgId`/`request.orgRole` for the session's current team. `POST /orgs`, `GET /orgs/:id`, `/orgs/:id/members*`, `POST /orgs/:id/teams` mirror the existing `/teams` endpoints with owner/admin RBAC + last-owner protection.
- **Per-team API keys (Phase 25b)**: `POST/GET/DELETE /teams/:id/api-keys` (admin-only) generate/list/revoke `crypto.randomBytes(24).toString('hex')` keys, stored as `sha256(key)` in `team_api_keys`; the raw key is shown once. Both api-service and results-service `onRequest` hooks accept a team API key via `X-API-Key` (try/catch-guarded DB lookup) as an alternative to the global `API_KEYS` list or a session cookie — sets `request.projectId`/`request.role='admin'` and updates `last_used_at`. The scheduler passes `projectId` on its server-to-server `POST /tests` calls (trusted via the global `API_KEYS` list) so scheduled tests stay scoped to their owning team.
- **Rate limiting (Phase 26)**: `@fastify/rate-limit`, registered globally (600 req/min/IP default) in both api-service and results-service, backed by `redisClient` (ioredis, shared store across replicas) when `REDIS_URL` is set, else in-memory. `skipOnError: true` — fails open if Redis is unreachable. `/health` (and results-service's internal worker callbacks) are exempt via `allowList`. Per-route overrides tighten `/auth/login`+`/auth/register` (`AUTH_RATE_LIMIT_MAX`, default 10/min) and the explicit `/ai/*`/`suggest-*`/`diagnose` endpoints (`AI_RATE_LIMIT_MAX`, default 20/min) — IP-based defense-in-depth on top of the per-team Gemini daily quota. `429` responses include a `Retry-After` header.

## Production Deployment (Caddy)

- `yourdomain.com` → UI (:3006)
- `api.yourdomain.com` → api-service (:3000)
- `data.yourdomain.com` → results-service (:3004)
- Internal ports hidden in prod; auto-TLS via Let's Encrypt

## Testing Architecture

| Layer | Framework | Isolation | Count |
|-------|-----------|-----------|-------|
| Unit | Vitest | In-process | ~165 tests |
| Integration | Vitest + Testcontainers | Real PostgreSQL | ~1000 tests |
| UI | Vitest + RTL + jsdom | DOM simulation | ~200 tests |
| E2E | Playwright | Full stack (docker compose up) | 11 specs |

**Total: ~1359 tests** across 64 test files (verified 2026-06-28). Includes worker-backend
`runner.test.ts` (35 tests — `runK6Test` via dependency injection context), worker-client
`runner.test.ts` (22 tests — `runClientTest` via dependency injection), `ui/ResultDetailPage.test.tsx`
(result detail page, baseline toggle), `results-service/db.test.ts` (schema idempotency).

## AI Feature Architecture

All 14 AI features follow a consistent pattern: lazy Gemini calls (only when user triggers), non-fatal fallbacks, and `GEMINI_MODEL` env var for model override.

| Feature | Entry point | Backend endpoint | Model used |
|---------|-------------|-----------------|------------|
| AI-1 Threshold suggestions | `✨ Suggest` in SLO panel | `GET /results/suggest-thresholds` | GEMINI_MODEL |
| AI-2 Auto-name steps | Automatic after recording stop | `suggestStepNames()` in correlator.ts | GEMINI_MODEL |
| AI-3 Ignore suggestions | Automatic after recording stop | `suggestIgnorePatterns()` in correlator.ts | GEMINI_MODEL |
| AI-4 Error diagnosis | `✨ Diagnose with AI` on result page | `GET /results/:id/diagnose` | GEMINI_MODEL |
| AI-5 Cron assistant | Text box in Schedules form | `POST /ai/cron` | GEMINI_MODEL |
| AI-6 Playwright translator | File upload in Custom Script mode | `POST /ai/translate` (results-service) | GEMINI_MODEL |
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
| ws (noServer) over @fastify/websocket | @fastify/websocket requires Fastify ^4.x, incompatible with our Fastify v5 (see `docs/PATTERNS/websocket-noserver.md`) |
| Vite over Next.js | Docker Desktop Windows filesystem latency (~574ms/op) caused Next.js lazy chunk compilation to exceed browser timeout |
| SHA-256 flow cache key | flow:<hex16> uniquely identifies step combination; avoids storing full step JSON in test_scripts.target_url |
| canonicalStep() before hashing | Property-order-sensitive JSON.stringify produced different keys for identical steps built via HAR vs manual vs re-run; canonical sort makes the key deterministic |
| Per-test run directories | Prevents file collisions at WORKER_CONCURRENCY > 1 (see `docs/PATTERNS/per-test-run-dir.md`) |
| analyser-service as separate service | Isolates Gemini AI from results-service; 12s timeout with local fallback |
| analyzeResult in @alt/shared | Single source of truth for deterministic thresholds; eliminates 220-line duplication and future drift between results-service fallback and analyser-service primary |
| AMQP connection.on(close) reconnect | amqplib has no built-in reconnect; silent channel faults were leaving services unable to consume without any health signal; 5s reconnect restores service automatically |
| @fastify/rate-limit + ioredis, fail-open via skipOnError | Shared Redis store lets rate limits work correctly across multiple replicas; skipOnError ensures a Redis outage degrades to unlimited (in-memory per-instance) rather than blocking all traffic |
| schema_migrations table | Numbered migration entries applied exactly once; idempotent ADD COLUMN IF NOT EXISTS pattern still used within each migration but guarded by version tracking |
| DB-backed opaque session tokens | Replaces HMAC-signed cookies (no revocation — gap A-U4). Random 32-byte token in cookie, SHA-256 hash stored in `sessions` table; `revoked_at` enables instant logout. `SESSION_SECRET` empty still = auth disabled, so local dev needs no config change |
| projects table reused as "team" | Avoids an ~81-site rename of `project_id`/`projectId` across services, UI, and docs; `team_members` + `sessions.team_id` add RBAC on top of the existing project-scoping filters unchanged |
| bcryptjs for password hashing | Pure JS, no native build step — keeps Alpine-based Docker images (`node:20-alpine`) simple, unlike `bcrypt` which needs node-gyp |
| Vite proxy for /api + /data | Avoids CORS issues with cookies; same-origin requests mean SameSite=Strict cookies work without credentials: 'include' |
| @fastify/cookie v11 | v9.x only supported Fastify 4.x; v11 is the first release compatible with Fastify 5 |
| INP from Lighthouse preferred | Lighthouse `interaction-to-next-paint` audit measures the full interaction timeline (more accurate than PerformanceObserver event type which only measures pre-paint duration) |
| projects.org_id nullable, no backfill | Existing teams stay "ungrouped" (org_id = NULL); orgs are opt-in via `POST /orgs/:id/teams`, avoiding a breaking migration for pre-Phase-25 teams |
| Per-team API keys as a 2nd auth path | Lets CI/external automation call `POST /tests`/`/schedules/:id/run` scoped to one team without sharing session cookies or the global `API_KEYS` list; sha256-hashed like session tokens, revocable, last_used_at tracked |
