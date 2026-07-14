# ARCHITECTURE.md — AI Load Testing Platform

Architecture, modules, data flows, and technical decisions.

## System Architecture

```
User → UI (Vite/React, :3006)
  │
  ├─ POST /tests → api-service (:3000)
  │    ├─ [client-side test] → client-tests directly (skip AI/cache — worker-client never runs a generated script)
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

`type: 'client-side'` tests are pulled out ahead of all three branches (fixed 2026-07-12) — `worker-client` always runs its own native Puppeteer flow and never reads `generatedScript`/`scriptId`, so routing them through Gemini generation or `compareDescriptions()` was pure wasted quota/latency with no user-visible effect (the "View Script" panel could never render for them either way, since `test_results.script_id` was always `NULL` for client-side results).

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

## Service Internals — Deep Dive

Request lifecycles, auth flows, and retry semantics for each service, from a full-codebase reverse-engineering pass (2026-07-05). Complements the high-level tables above — the bugs found during that pass have since been fixed (2026-07-06/07); see `TODO.md`'s Completed section for the fix write-ups and its Open section for anything newer.

### ai-service — AI script generation

Consumes `ai-requests` (prefetch = `WORKER_CONCURRENCY`, default 3). Every message validated with `EnrichedTestRequestSchema.parse()`; malformed messages route straight to `ai-requests.dlq`. Routing inside `processAiRequest()`:
- **Comparison branch** (cached script + description both present): exact-match descriptions skip the LLM entirely (`REUSE`, quota-saving shortcut); otherwise `compareDescriptions()` classifies REUSE/REGENERATE via LLM. `REUSE` forwards the cached script unchanged with no generation step at all.
- **Generation branch** (cache miss, or REGENERATE): status message → `generateScript()` builds a type-specific prompt (`BACKEND_PROMPT`/`CLIENT_PROMPT`/`FLOW_PROMPT`) → status message → publish to the target worker queue.

User-controlled text is wrapped in `fenceUserContent()` (`<user_data>` tags + an instruction to treat it as data, not instructions) as a partial prompt-injection mitigation, applied consistently across all four prompt builders (`BACKEND_PROMPT`/`CLIENT_PROMPT`/`FLOW_PROMPT`/`compareDescriptions`; the last one was missing it until 2026-07-07).

LLM calls go through `@alt/shared`'s `generateAIText()` — provider-agnostic, tries `setting.provider` then each `fallbacks` entry in order, each provider skipped if its API key env var is unset. `getProviderSetting()` caches the team's provider chain from results-service for 30s.

The `capacity` load profile (`BACKEND_PROMPT`/`FLOW_PROMPT`) is the one place `options.thresholds` uses k6's object-form threshold instead of a plain string — `{ threshold: 'p(95)<A', abortOnFail: true, delayAbortEval: 'Bs' }` (fixed 2026-07-10) — so a capacity/stress test stops as soon as it proves the system broke instead of burning worker/compute time on the rest of the configured ramp. `buildK6Options()` (api-service `options.ts`) mirrors the same shape for cache-hit re-injection. The p95/error-rate/grace-period values (A/B, default `2000`ms/`5`%/`10`s) are admin-configurable from the Settings page rather than hardcoded (added 2026-07-11, see `docs/configuration.md`'s "Capacity/stress test abort thresholds") — ai-service has no DB of its own, so it fetches the current values from results-service's `GET /system/capacity-abort` with a 30s in-process cache (`getCapacityAbortConfig()`), same pattern as `getProviderSetting()`. A test that aborts this way surfaces why on the results page via a "Test stopped early" banner (added 2026-07-11; `worker-backend/parser.ts`'s `parseStoppedEarly()` extracts k6's own threshold-crossed message and VU-ramp progress from stdout).

Generated `http_req_duration` thresholds are multi-percentile (`p(90)<A`, `p(95)<B`, `p(99)<C`), not a single p(95) cliff-edge (fixed 2026-07-10) — mirrors the p50/p90/p95/p99 the results UI already computes and displays. `p90`/`p99` are derived from the single p95 budget via `@alt/shared`'s `deriveMultiPercentileThresholds()` (p90 = 0.8×, p99 = 2×), not separately user-configurable; shared by both `k6Thresholds()` (ai-service) and `buildK6Options()` (api-service) so the ratio can't drift between the two independent threshold-generation paths. For the capacity profile only p95 aborts the run — p90/p99 stay observational so a single tail outlier can't trigger a premature abort.

`FLOW_PROMPT` instructs tagging requests with `tags: { name: '<templated path>' }` whenever a URL interpolates an extracted variable (e.g. `/products/${vars.productId}` → `tags: { name: '/products/:id' }`) (fixed 2026-07-11) — otherwise k6 fragments metrics into a near-duplicate series per unique ID instead of one aggregated series per logical endpoint. Only gated on `hasExtractions` (the only way a dynamic URL segment can occur in this flow model), same as the extraction error-handling instructions it's grouped with.

**Gemini quota enforcement on the queue-consumer path (fixed 2026-07-11).** Per-team daily quota tracking used to only run on results-service's synchronous `/ai/*` HTTP endpoints — `processAiRequest()` (the path every queued backend/flow/client script generation and comparison actually goes through) never checked or incremented it, so the quota was silently unenforced for the majority of real Gemini traffic. `checkAndIncrementGeminiUsage(teamId)` now runs before every `compareFn`/`genScript` call here (skipped only for the free exact-match REUSE shortcut, which makes no LLM call), via a `POST /internal/gemini-usage` results-service endpoint (`X-Internal-Key` gated, fails open on network error). A `GeminiQuotaExceededError` skips the normal 3-retry loop and goes straight to DLQ + a `quota exceeded` failure message, instead of burning 3 retries against an already-exhausted quota.

Both `BACKEND_PROMPT` and `FLOW_PROMPT` also now instruct the generated script to log `res.body.slice(0, 500)` whenever a `check()` fails (fixed 2026-07-11) — the execution log used to only record that a check failed, not what the server actually returned, making failures hard to diagnose without re-running with manual instrumentation. Gated to failures only (not every response) to keep log volume bounded.

**`realistic` load profile — open-model / arrival-rate (added 2026-07-11).** A fifth, opt-in `LoadProfile` alongside load/spike/capacity/soak. Every other profile uses k6's VU-based `stages` executor (closed-model: a VU waits for its response before sending the next request, which under-represents real load once a system degrades); `realistic` uses k6's `ramping-arrival-rate` executor instead, which keeps sending at a fixed rate regardless of response time. `vus` is reinterpreted as the target rate in requests/sec, not a concurrent-user count; `preAllocatedVUs = max(rate, 10)` and `maxVUs = preAllocatedVUs × 10` give k6 headroom to spawn extra real VUs if responses slow down. Implemented identically in both generation paths — `profileInstructions()` (ai-service, prompt-embedded literal scenario config) and `buildK6Options()` (api-service, cache-hit re-injection, `realisticProfileMaxVus()` exported so the two can't drift). `checkTestQuota()` (api-service `quotas.ts`) checks the derived VU-pool ceiling (`realisticProfileMaxVus(vus)`), not the nominal rate — otherwise a team could request a rate within quota that k6 then silently scales up to 10× as many real VUs. Deliberately **not** wired into any AI-suggestion path (chat's `buildEnglishPrompt`/`FLOW_READY_SHAPE`, `/suggest-settings`) — those still only offer the original four profiles; `realistic` is manual-opt-in only, via the Advanced Settings profile picker (backend tests only — flow tests have no profile picker in the UI today, a pre-existing gap).

**`setupFirstStep` — run a flow's Step 1 once via k6 `setup()` (added 2026-07-11).** Opt-in per-flow-test boolean (`TestRequest.setupFirstStep`, UI toggle in the flow "Run as" section, shown once a flow has >1 step and `flowRunner === 'k6'`). Addresses a flow test redoing a one-time precondition (typically login) on every VU/iteration, which is noise when auth itself isn't the thing being measured. When set, `FLOW_PROMPT` instructs moving Step 1's `group()` out of the per-VU default function and into `export function setup() { ...; return vars; }`; the default function becomes `export default function(data) { const vars = { ...data }; ... }`, receiving Step 1's extracted values via k6's setup-data parameter. No worker-backend changes needed — k6 tags `group()` metrics from inside `setup()` the same way as from the default function, and `parser.ts` already aggregates `StepMetrics` purely by group-name tag regardless of which phase produced them. Because this changes the generated script's structure, `services/api-service/src/scripts.ts`'s `stepsToKey()` mixes `setupFirstStep` into the flow cache-key hash — but only when true, so the hash is byte-for-byte identical to before (and all existing cached flow scripts stay valid) when it's unset.

**Weighted parallel journeys — funnel-shaped flow tests (added 2026-07-14).** Opt-in per-step `FlowStep.userPercent` (0-100, UI input shown once a flow has >1 step, `services/ui/app/components/FlowBuilder.tsx`) models "only some users go all the way to checkout" instead of every VU always running every step. Missing = inherits the previous step's effective percent (step 1 defaults to 100), so an unmodified flow is untouched. `@alt/shared`'s `computeJourneys(steps, totalVus)` groups steps into maximal runs of equal effective percent and splits `totalVus` across them proportionally (remainder-adjusted so the split always sums to exactly `totalVus`); a single behavioral group collapses to one `'default'`-exec journey — the byte-for-byte backward-compat case `FLOW_PROMPT` never touches. When there's more than one journey, `FLOW_PROMPT` adds a self-contained `journeysSection` instructing one named `exec` function per journey (each repeating only its own prefix of steps — k6 scenarios share no iteration state) plus an `options.scenarios` block with a per-journey stage/rate shape mirroring whatever `profileInstructions()` would generate for a single scenario (load/spike/soak/capacity's VU-based stages, realistic's arrival-rate), scaled to that journey's own VU (or rate) share — spike/capacity's separate "peak" figure scales by the same ratio. `services/api-service/src/scripts.ts`'s `canonicalStep()` folds `userPercent` into the flow cache-key hash (only when set, so existing cached scripts stay valid), and `validateStepPercents()` (400 on out-of-range or non-monotonic percents) is wired into `POST /tests`. `worker-backend/parser.ts` needed no changes — it already aggregates `StepMetrics` purely by k6 group name, so steps shared across journeys merge automatically and the funnel shows up in the per-step request counts for free. `FlowBuilder.tsx`'s summary line and clamping logic use a **local duplicate** of `computeJourneys`, not a runtime import from `@alt/shared` — every other `@alt/shared` usage in `services/ui` is `import type` (erased before bundling); actually importing the runtime function hits a pre-existing circular require in `@alt/shared` (`aiProvider.ts` imports `redactPII` back from `index.ts`) that Vite's esbuild dependency pre-bundler can't resolve (dev: `Could not resolve './aiProvider'`; prod: Rollup won't statically trust a named export once any dynamic re-export coexists in the same CJS file). Fixing that circularity is a separate, monorepo-wide concern; duplicating this one small, stable, pure function was the lower-risk call.

Retry has two independent layers: an *inner* 429-backoff (up to 3 attempts, 60s/120s waits) inside `generateScript`/`compareDescriptions`, and an *outer* queue-level retry (`x-retry-count` header, immediate requeue, `MAX_RETRIES=3` then DLQ) in `processAiRequest`'s catch block.

### api-service — ingress / routing

Single `onRequest` hook checked in order: internal-trusted (`X-Internal-Key`) → per-team API key (`team_api_keys`) → global `API_KEYS` list → DB-backed session cookie (`getApiSession()`). Only two business routes: `POST /tests` and `POST /tests/:testId/cancel`.

`POST /tests`'s script-cache routing decision tree:
1. `customScript` present → publish directly to the worker queue, skip AI/cache entirely.
2. `type === 'client-side'` → publish directly to the worker queue, skip AI/cache entirely (added 2026-07-12 — see "Three-Way Script Routing" above).
3. No cached script → publish to `ai-requests` for generation.
4. Cached script, no description or type is `flow` → reuse directly (increment `used_count`), publish to worker queue.
5. Cached script + description → attach `cachedScript`/`cachedScriptDescription`, publish to `ai-requests` for comparison.

Script-cache lookup (`scripts.ts`): `canonicalStep()` picks a fixed field order before SHA-256-hashing the step array to a `flow:<hex16>` key, avoiding JSON key-order drift between HAR/manual/re-run step objects. `checkTestQuota()` (VUs, duration, concurrency) runs before every queue publish.

### analyser-service — deterministic analysis + AI insights

`POST /analyse` has no body validation, no CORS, and no rate limiting; it now requires `X-Internal-Key` to match `INTERNAL_API_KEY` unconditionally (fixed 2026-07-06 — previously had no auth hook at all, and unlike the rest of the codebase's "no-op when unset" convention, this route fails closed since it triggers a real costed LLM call). Deterministic analysis (`analyzeResult` in `@alt/shared`) computes backend/Web-Vitals threshold violations and a ±10%/>20% regression dead-zone against the previous run, including a `checksFailRate` violation (default: fail if >10% of k6 `check()` assertions fail) — separate from `http_req_failed`/HTTP status, this is what catches a request that returns 2xx with the wrong body (fixed 2026-07-10; every generated script now also carries `thresholds: { checks: ['rate>0.9'] }`, parsed out of the k6 JSON summary in `worker-backend/parser.ts`). AI insights (`aiInsights.ts`) build a size-capped prompt (top-5 steps by p95) and retry up to 2 attempts, classifying 429/quota errors (anchored `\b429\b` match, fixed 2026-07-07) as non-retried, `SyntaxError` as a non-retried parse failure, and now normalizes a mixed-case `severity` field instead of discarding an otherwise-usable insight (fixed 2026-07-07). The documented "12s timeout with local fallback" used to be enforced entirely on the *caller's* side (`results-service/src/consumer.ts`'s `AbortSignal.timeout(12000)`); analyser-service's own handler now races its retry loop against an internal 10s timeout too (fixed 2026-07-06), so a hung provider can't run indefinitely after the caller has already given up.

### recorder-service — flow recorder

`POST /recordings/start` launches non-headless `puppeteer-core` against an Xvfb display, opens a CDP session, and optionally navigates to `targetUrl` after an upfront SSRF check (`validateRecorderUrl` = shared `validateSsrfSafeUrl`); every subsequent request the page makes — including redirect hops — is re-validated live via `page.setRequestInterception(true)` + `createSsrfInterceptHandler()`, which aborts any request whose URL fails the check (fixed 2026-07-06; previously only the initial navigation was checked). `POST /recordings/:id/stop` deletes the session from its in-memory map *before* any `await`, specifically to prevent double-processing/double Gemini billing on a concurrent stop. `finishSession()` pipeline: `toFlowSteps`/`computeThinkTimes` (pure) → `detectCorrelations` (Gemini) → `suggestStepNames` + `suggestIgnorePatterns` (Gemini, parallel) → `detectDuplicateSteps` (pure). PII redaction (`redactPII()`) is applied to request/response bodies before truncation (with a safety margin so boundary-straddling values aren't missed) and auth header *values* are redacted before reaching the correlation prompt too (both fixed 2026-07-06/07 — previously truncation ran first and only bodies were redacted).

### results-service — storage, API, WebSocket, scheduler

Auth resolution order in the single `onRequest` hook: `/auth/*` exempt → `publicPaths` (`/health`, `/ws`) exempt → internal server-to-server callbacks (`X-Internal-Key`) → per-team API key → global `API_KEYS` → DB-backed session + `team_members` role → no-team gate (403) → org-membership resolution → mutation RBAC (`viewer` 403 on POST/PUT/PATCH/DELETE). Falls open (`projectId=undefined`) when `SESSION_SECRET` is unset. The project-scoping filter `($N::uuid IS NULL OR project_id = $N::uuid)` is the platform-wide convention for team isolation, applied almost everywhere — confirmed gaps are tracked in `TODO.md`. (`/system/ai-status` used to also be in `publicPaths`; removed 2026-07-07 — it now requires normal auth like any other route.)

WebSocket broadcast (`ws.ts`) delivers to same-process clients directly, plus Redis pub/sub so all horizontally-scaled replicas receive events (an `INSTANCE_ID` tag prevents double-delivery on the originating replica). The scheduler (`scheduler.ts`) registers one live `node-cron` task per enabled schedule at boot; each fire attempt now claims a Postgres advisory lock (`pg_try_advisory_xact_lock`, keyed on schedule ID + current UTC minute) before firing, so scaling to N replicas fires every schedule exactly once instead of N times (fixed 2026-07-06 — previously had no leader election).

`POST /auth/switch-team` rotates the session token rather than mutating the existing row's `team_id` in place (fixed 2026-07-11) — `switchSessionTeam()` revokes the old token and issues a fresh one via `createSession()`, and the handler sets it as the new `alt_session` cookie. Matches OWASP's session-regeneration-on-privilege-change guidance: a leaked pre-switch token no longer stays valid for the new team's scope.

Operational settings previously hardcoded via env var — `STALE_RUNNING_MINUTES`/`STALE_PENDING_MINUTES`/`LIVE_METRICS_RETENTION_DAYS`/`TEST_RESULTS_RETENTION_DAYS`/`AUDIT_LOG_RETENTION_DAYS`/`RATE_LIMIT_MAX`/`AI_RATE_LIMIT_MAX`, plus the capacity-abort thresholds noted in the ai-service section above — are now `app_settings`-backed via a shared `getNumberSetting()` helper (fixed 2026-07-11), admin-editable at runtime from the Settings page's "Retention & rate limits" panel (`GET/PUT /system/operational-settings`) with the env var kept only as the startup fallback default. `cleanup.ts`'s stale-test/purge sweep re-reads current values every tick instead of a fixed-at-startup snapshot; rate limits use a 30s in-process cache so a change takes effect without a restart but without a DB hit per request.

### worker-backend — k6 runner

`runK6Test` creates a per-test run directory (`k6-run-${testId}`), writes `script.js`/`data.json`/`data.csv`, validates via `k6 inspect`, then spawns `k6 run --out json=<jsonPath> ...` — the write-and-validate step is now wrapped in one try/catch that removes the run directory on any failure (fixed 2026-07-07; previously a write failure leaked the directory, only a `validateScript` failure cleaned up). Live metrics: stdout/stderr line-buffered into a bounded execution log; every `liveIntervalMs`, `readAndPost` incrementally parses new JSON lines (now buffering an incomplete trailing line across polls the same way the stdout/stderr buffer does, fixed 2026-07-07 — previously a line split across two polls was silently dropped) and POSTs a `LiveMetricPoint`. On close, the whole JSON file is re-read for final parsing and the run directory is removed. Cancel sends `SIGTERM`, escalating to `SIGKILL` after a 30s grace period if the process hasn't exited (fixed 2026-07-06, mirroring the max-duration watchdog's own escalation — previously had no follow-up at all). The stale-cleanup mechanism (`STALE_RUNNING_MINUTES`) lives in **results-service**, not here — it only flips DB status on a timer, never touches the worker's process or temp files.

### worker-client — Puppeteer runner

Per test: acquire a browser from `browserPool` (reuses idle instances) → run `options.sessions` sequentially, collecting Web Vitals via `PerformanceObserver` with a fixed 3s wait (LCP/FCP/CLS/TTFB now coalesce to `undefined` rather than `0` when their observer never fires, fixed 2026-07-06 — previously a page that never painted was reported as passing every Web Vitals SLO with a "perfect" 0ms score) → run a Lighthouse audit (non-fatal on failure) → aggregate and publish. A `killTimer` force-closes the browser after `maxDurationMs` (default 5 min); if it fires during the Lighthouse phase, the code now checks a `killTimerFired` flag after Lighthouse's own try/catch and re-throws instead of falling through to `'completed'` (fixed 2026-07-06 — previously this path silently reported success while the identical timer firing during the sessions loop correctly propagated as a hard failure). A cancel arriving while a browser is still being acquired is now recorded immediately rather than only once `runningBrowsers` is populated, so it's honored as soon as acquisition resolves instead of being silently dropped (fixed 2026-07-06).

Opt-in mobile device emulation via `options.device` (added 2026-07-11) — a Puppeteer `KnownDevices` preset name applied with `page.emulate(device)` before navigation; an unrecognized name is logged and ignored rather than failing the session. `KnownDevices` is typed as a literal-union-keyed `Readonly<Record<...>>`, so indexing it with the plain `string` from `options.device` needs an explicit cast — this type-checks fine under Vitest (which strips TS types via esbuild without checking them) but broke a real `tsc --noEmit` compile, which in turn broke the e2e workflow's Docker image build undetected until that stage, since CI's "Type check" step only covered 4 of 8 backend services at the time. Both fixed 2026-07-11: the cast in `runner.ts`, and CI's Type check step extended to all 7 backend services (worker-client, analyser-service, recorder-service were the missing 3).

### ui — Vite + React Router SPA

API client (`lib/api/*.ts`) used to be inconsistent about error handling: `teams.ts`/`orgs.ts`/`apiKeys.ts` funnel every response through an `orgJson()` helper that throws on non-2xx, while `cancelTest`/`setBaseline`/`clearBaseline`/`compareResults` (`tests.ts`) and `createWebhook` (`webhooks.ts`) used to call `res.json()` directly with no `res.ok` check, treating HTTP errors as successful payloads — all 5 now check `res.ok` and throw, matching the `orgJson()` convention (fixed 2026-07-06/07). `schedules.ts`/`presets.ts`/`system.ts`/`logSources.ts` were not part of that audit and may still have the same gap. WebSocket (`ResultsSocketContext.tsx`) is a single shared connection with exponential backoff (1s→30s) and a synthetic `reconnected` event so consumers know to re-sync. The `/results` list page's own fetch is wrapped in try/catch/finally so a rejected fetch shows an error instead of spinning forever (fixed 2026-07-07), and the compare-runs page's existing `.catch()` now actually fires since `compareResults()` throws on error instead of resolving with the error body.

**Router migration to data-router loaders (complete as of 2026-07-12).** `App.tsx` builds the route tree with `createBrowserRouter`, not a plain `<BrowserRouter>`; each top-level route gets its own `errorElement` (`RouteErrorBoundary`, a per-route `ErrorBoundary.tsx`) so a crash on one page doesn't unmount the shared `Sidebar`/`TopBar`. All 11 data-fetching pages (`Team`/`Org`/`Workspaces`/`Settings`/`Presets`/`Schedules`/`Webhooks`/`Results`/`Compare`/`app/page.tsx` home/`results/testId/page.tsx`) fetch their initial data via a route `loader()` + `useLoaderData()`; `app/chat/page.tsx` was audited and needs no conversion — it fetches nothing server-side on mount (chat history comes from `localStorage`; its two `useEffect`s are for auto-save and scroll-into-view, not data loading). Loaders execute outside the React component tree, so a loader needing the current user/team/workspace can't call `useAuth()`/`useWorkspace()` — it calls `getMe()` directly and, for the active workspace specifically, reads `localStorage` via `WorkspaceContext`'s exported `storageKey(teamId)` helper (the same key the context itself persists to). Because loaders don't observe React context changes either, the Sidebar's workspace-switcher `<select>` calls `useRevalidator().revalidate()` immediately after `setActiveWorkspaceId()` so loader-backed pages still refresh on a workspace switch, mirroring what each page's own `useEffect([activeWorkspaceId])` used to do implicitly.

`results/testId/page.tsx` (added 2026-07-12, the last holdout) is the first loader-backed page on a *dynamic* route segment (`/results/:testId`) — a real subtlety the earlier 10 conversions didn't hit: navigating from `/results/abc` to `/results/xyz` (e.g. clicking a different result link) re-runs the loader with new `params.testId` but does **not** remount the component (same route, same element type), so `useState(loaderData.result)`'s initializer is only read once and would otherwise keep showing the old test's data. Fixed with the same resync pattern already used for revalidation on the other pages: a `useEffect(() => { setResult(loaderData.result); ...}, [loaderData])` that re-syncs local state whenever `loaderData` gets a new object identity — which happens both on a param change and on an explicit revalidate. The loader itself parallels `getResult`/`getLogSources`/`getLiveMetrics` via `Promise.allSettled` (mirroring the old effect's partial-failure tolerance), then conditionally awaits `getTrend()` afterward since it depends on `result.target_url` and can't join that first batch. Everything else — the live WebSocket subscription, the countdown/elapsed timers, the 20s self-healing re-sync poll, cancel/baseline actions — stayed component-level logic untouched, same as the search-param pre-fill and WebSocket-triggered refresh that stayed component-level on the home page conversion.

The results page shows an amber "Test stopped early" banner (added 2026-07-11) when `BackendMetrics.stoppedEarly` is present — surfaces which threshold(s) triggered a capacity/stress test's `abortOnFail` and how far VU ramp-up got before it fired, so a short test run doesn't look identical to a normal one. A bare `"0"` status-code cell now reads `"0 (no response)"` — it means the connection never got an HTTP response (refused/reset/timeout), not a literal HTTP status.

### Cross-service patterns

- **429/rate-limit detection**: ai-service, analyser-service, and recorder-service all check `status === 429 || /\b429\b/.test(msg) || msg.includes('quota')` (fixed 2026-07-06/07 — ai-service used to check `.status === 429` only; analyser-service and recorder-service used to use an unanchored `msg.includes('429')` that could false-positive on text like "failed after 3429ms").
- **Internal service-to-service auth**: every internal HTTP call carries `X-Internal-Key` via `internalHeaders()` (`@alt/shared`) when `INTERNAL_API_KEY` is set.
- **AMQP resilience**: all 5 queue-connected services use the same `connectWithBackoff()` (1s→30s capped exponential, retries forever) for both initial connect and reconnect-on-close.
- **Postgres pool sizing** (fixed 2026-07-10): all 4 pools (results-service primary + read, api-service, worker-backend) now set an explicit `max`/`idleTimeoutMillis: 30_000`/`connectionTimeoutMillis: 5_000` instead of `pg`'s bare defaults (`max: 10`, `connectionTimeoutMillis: 0` i.e. wait forever for a pool slot). Sized per service's actual load: results-service `max: 20` (fronts nearly the whole REST API surface), api-service `max: 10` (test creation + script-cache lookups), worker-backend `max: WORKER_CONCURRENCY + 3, floor 5` (DB usage is only script-caching + result bookkeeping around each k6 run, scaling with concurrent test count rather than request volume).
- **Retry/DLQ shape**: every consumer uses the same `x-retry-count` header + `MAX_RETRIES=3` + `.dlq` queue pattern; retries are always an immediate requeue with no backoff at the queue layer — pacing (where it exists) is done inside the handler instead.

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
| bcryptjs for password hashing | Pure JS, no native build step — keeps Alpine-based Docker images (`node:22-alpine`) simple, unlike `bcrypt` which needs node-gyp |
| Vite proxy for /api + /data | Avoids CORS issues with cookies; same-origin requests mean SameSite=Strict cookies work without credentials: 'include' |
| @fastify/cookie v11 | v9.x only supported Fastify 4.x; v11 is the first release compatible with Fastify 5 |
| INP from Lighthouse preferred | Lighthouse `interaction-to-next-paint` audit measures the full interaction timeline (more accurate than PerformanceObserver event type which only measures pre-paint duration) |
| projects.org_id nullable, no backfill | Existing teams stay "ungrouped" (org_id = NULL); orgs are opt-in via `POST /orgs/:id/teams`, avoiding a breaking migration for pre-Phase-25 teams |
| Per-team API keys as a 2nd auth path | Lets CI/external automation call `POST /tests`/`/schedules/:id/run` scoped to one team without sharing session cookies or the global `API_KEYS` list; sha256-hashed like session tokens, revocable, last_used_at tracked |
