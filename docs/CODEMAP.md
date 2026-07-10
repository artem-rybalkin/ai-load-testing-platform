# CODEMAP.md — AI Load Testing Platform

Grep-friendly map of all modules, entry points, and key files.

## Monorepo Root

```
ai-load-testing-platform/
├── package.json              # npm workspaces: packages/shared + all services/ui
├── tsconfig.json             # base TS config (extended by all services)
├── vitest.config.ts          # Vitest root config (unit + integration + UI)
├── playwright.config.ts      # Playwright E2E config (baseURL: localhost:3006)
├── docker-compose.yml        # base services + infrastructure
├── docker-compose.dev.yml    # dev overrides (tsx watch, WATCHPACK_POLLING)
├── docker-compose.prod.yml   # prod overrides (Caddy HTTPS, no internal ports, limits)
├── Caddyfile                 # Caddy reverse proxy + auto-TLS config
└── gain.json                 # Rosetta workspace config
```

## packages/shared — @alt/shared

```
packages/shared/
├── src/index.ts              # ALL shared types: TestType, FlowStep, BackendMetrics,
│                             #   ClientMetrics, StepMetrics, SLOThresholds, etc.
└── src/contracts.ts          # zod schemas mirroring the AMQP message-boundary types
                              #   (TestRequestSchema, EnrichedTestRequestSchema,
                              #   TestResultSchema, CancelMessageSchema) + compile-time
                              #   drift guards against the hand-written interfaces above
```

## services/api-service — Port 3000

```
services/api-service/src/
├── index.ts      # POST /tests (3-way routing), POST /tests/:id/cancel, GET /health
├── queue.ts      # RabbitMQ publisher: publishTest(), publishCancel(), getWorkerConsumerCount()
├── scripts.ts    # findExistingScript(), incrementUsedCount(), stepsToKey() (SHA-256 hash)
├── options.ts    # buildK6Options() (load profiles), replaceK6Options()
└── logger.ts     # Pino logger with redact
└── src/__tests__/
    ├── index.test.ts    # POST /tests routing, cancel, health, field redaction (23 tests)
    ├── options.test.ts  # buildK6Options, replaceK6Options (16 tests)
    └── scripts.test.ts  # findExistingScript integration/Testcontainers (9 tests)
```

## services/ai-service — No HTTP port

```
services/ai-service/src/
├── index.ts      # RabbitMQ consumer: compare branch + generation routing
├── generator.ts  # generateScript() (BACKEND/CLIENT/FLOW_PROMPT), compareDescriptions()
└── logger.ts
└── src/__tests__/
    └── generator.test.ts  # ExtractRule rendering, SharedArray, compareDescriptions (12 tests)
```

## services/worker-backend — Port 3002 (health only)

```
services/worker-backend/src/
├── index.ts   # RabbitMQ consumer, cancel handling, saveScript(), Fastify health
├── runner.ts  # runK6Test(): spawns k6, makeTailBuffer() (bounded stdout/stderr tail), makeLineBuffer()
├── parser.ts  # parseK6Output(), parseK6Errors(), aggregateWindow(), parseK6GroupMetrics()
└── logger.ts
└── src/__tests__/
    ├── runner.test.ts  # runK6Test, validateScript, makeLineBuffer, makeTailBuffer
    └── parser.test.ts  # All parser functions (25 tests)
```

## services/worker-client — Port 3003 (health only)

```
services/worker-client/src/
├── index.ts       # RabbitMQ consumer, cancel handling, Fastify health
├── runner.ts      # runClientTest(): Puppeteer sessions, Web Vitals, Lighthouse
├── browserPool.ts # createBrowserPool(): reuses idle browser processes across tests (sized to WORKER_CONCURRENCY)
└── retry.ts       # handleRetry(), DLQ routing
```

## services/analyser-service — Port 3008

```
services/analyser-service/src/
├── index.ts      # Fastify: POST /analyse, GET /health
├── analyzer.ts   # analyzeResult(): thresholds + regression detection
├── aiInsights.ts # generateAiInsights(): Gemini narrative + anomalies + recommendations
└── logger.ts
```

## services/recorder-service — Ports 3007 + 6080

```
services/recorder-service/src/
├── index.ts      # POST /recordings/start, GET /:id, POST /:id/stop, DELETE /:id
├── recorder.ts   # Puppeteer non-headless, CDP Network capture, toFlowSteps()
├── correlator.ts # Gemini correlation: ExtractRule per FlowStep
└── logger.ts
├── Dockerfile              # chromium + xvfb + x11vnc + novnc
├── Dockerfile.dev
├── docker-entrypoint.sh    # starts Xvfb :99, x11vnc, noVNC, then node
└── docker-entrypoint-dev.sh
```

## services/results-service — Port 3004

```
services/results-service/src/
├── index.ts      # startup: initDb → consumer → scheduler → cleanup → app
├── app.ts        # ALL REST endpoints (results, scripts, webhooks, schedules, presets, log-sources, auth)
├── session.ts    # createSession()/getSession()/revokeSession(): DB-backed opaque token sessions (SHA-256 hash in `sessions` table); switchSessionTeam(), hashApiKey()
├── consumer.ts   # RabbitMQ consumer, handleResult(), webhook firing, broadcast()
├── analyzer.ts   # analyzeResult(): thresholds + regression detection
├── db.ts         # PostgreSQL pool, createSchema() (all tables + migrations), findOrCreateProject()
├── scheduler.ts  # startScheduler(), triggerSchedule()
├── cleanup.ts    # runStaleCleanup(): running>15min / pending>30min → failed
├── ws.ts         # WebSocketServer (noServer), setupWebSocketServer(), broadcast()
└── logger.ts
└── src/__tests__/
    ├── api.test.ts       # All REST endpoints, Testcontainers (64 tests)
    ├── analyzer.test.ts  # analyzeResult unit tests (44 tests — includes INP/TBT thresholds)
    ├── auth.test.ts      # POST /auth/login, /logout, GET /auth/me, session middleware (18 tests)
    ├── session.test.ts   # createSession/getSession/revokeSession/switchSessionTeam unit tests (11 tests)
    ├── consumer.test.ts  # handleResult pipeline, webhooks (11 tests)
    ├── startConsumer.test.ts # real-module: connection lifecycle, malformed guard, retry/DLQ (16 tests)
    ├── stale.test.ts     # runStaleCleanup (10 tests)
    └── scheduler.test.ts # startScheduler, triggerSchedule (12 tests)
```

## services/ui — Port 3006

Not Next.js — Vite + `react-router` v7 data router (`createBrowserRouter`), see `docs/vite-migration.md`. As of the 2026-07-10 router migration, `Team`/`Org`/`Workspaces`/`Settings`/`Presets`/`Schedules`/`Webhooks`/`Results`/`Compare` fetch their data via a route `loader()` + `useLoaderData()` instead of a mount-time `useEffect`; loaders run outside the React tree (no context access), so any loader needing the active team/workspace calls `getMe()` / reads `localStorage` directly rather than `useAuth()`/`useWorkspace()`. `app/page.tsx` (home), `app/chat/page.tsx`, and `results/testId/page.tsx` are the 3 pages still on mount-time `useEffect` (deliberately out of scope so far — see `TODO.md`).

```
services/ui/
├── index.html        # Vite entry HTML
├── vite.config.ts    # Vite config: tailwind plugin, @/ alias, polling watcher, /api+/data proxy
├── src/
│   ├── main.tsx      # React entry (ReactDOM.createRoot)
│   └── App.tsx       # createBrowserRouter + route loaders + RootLayout (Sidebar/TopBar/ActiveTests/WorkerHealth) + AuthGate + per-route errorElement
├── lib/
│   ├── api.ts               # Barrel re-exporting lib/api/*.ts + types; login/logout/getMe
│   ├── api/                 # Per-domain fetch wrappers: auth, tests, teams, orgs, workspaces, presets,
│   │                         #   schedules, webhooks, apiKeys, logSources, system, ai, recording, core (shared res.ok/throw helper)
│   ├── AuthContext.tsx       # AuthProvider + useAuth hook; SessionUser type; getMe on mount
│   ├── HealthContext.tsx     # Worker/service health + activeTests polling
│   ├── WorkspaceContext.tsx  # Active workspace selection (persisted to localStorage per team); storageKey() exported for route loaders
│   ├── ResultsSocketContext.tsx  # WebSocket context (useResultsSocket hook)
│   └── useDarkMode.ts / useFetch.ts / useMediaQuery.ts / useResultsSocket.ts
├── app/
│   ├── globals.css   # Tailwind 4 CSS-first config + Command Center CSS vars
│   ├── page.tsx       # New Test form (2-col bento) + flow runner + script mode + INP/TBT SLOs — useEffect-fetched
│   ├── chat/page.tsx  # AI chat-driven test creation flow — useEffect-fetched
│   ├── library/page.tsx  # Built-in k6/Puppeteer script template library
│   ├── login/page.tsx    # Login form — email + password → POST /auth/login
│   ├── results/
│   │   ├── page.tsx         # Results list (table + mobile cards) — loader
│   │   ├── testId/page.tsx  # Test detail (bento grid + charts + analysis) — useEffect-fetched (live WebSocket)
│   │   └── compare/page.tsx # Side-by-side metric diff — loader
│   ├── webhooks/page.tsx    # Webhook CRUD + Log Sources CRUD — loader (webhooks only; log sources still useEffect)
│   ├── schedules/page.tsx   # Schedule CRUD + manual trigger — loader
│   ├── presets/page.tsx     # Preset CRUD + load into form — loader
│   ├── team/page.tsx        # Team members, quota/usage, API keys, audit log, per-team AI provider override — loader
│   ├── org/page.tsx         # Organization (multi-team) management — loader
│   ├── workspaces/page.tsx  # Workspace/sub-project CRUD — loader
│   └── settings/page.tsx    # Platform-admin settings: live-metrics window, platform-default AI provider — loader
└── app/components/
    ├── Sidebar.tsx          # Icon-rail sidebar incl. workspace switcher (calls useRevalidator().revalidate() on switch so loader-backed pages refresh)
    ├── TopBar.tsx            # Mobile top bar
    ├── ActiveTests.tsx       # Running tests strip (WS-driven)
    ├── SystemHealth.tsx      # Amber warning strip (polls /system/health 15s)
    ├── WorkerHealth.tsx      # CPU/memory/active bars per worker
    ├── AIStatus.tsx          # AI provider availability/degraded-mode banner
    ├── ErrorBoundary.tsx     # Class component + RouteErrorBoundary (per-route errorElement)
    ├── Skeleton.tsx          # Loading-state placeholder shared across pages
    ├── AdvancedSettings.tsx / ThresholdSection.tsx  # New-test form subsections
    ├── BackendChart.tsx      # Bar charts: response time + request breakdown
    ├── ClientChart.tsx       # Radar + VitalCards (Core Web Vitals incl. INP/TBT) + Page Health + Resource Breakdown
    ├── FlowStepChart.tsx     # Grouped bar: avg+p95 per step
    ├── AnalysisPanel.tsx     # Perf badge + threshold violations (incl. checksFailRate) + AI insights
    ├── RealtimeChart.tsx     # 4-panel live metrics (response time, error rate, virtual users, throughput) + table-view toggle
    ├── TrendChart.tsx        # p95/LCP trend line across runs for same URL
    └── FlowBuilder.tsx       # Multi-step flow editor + HAR import + Record button + per-step "Request headers" editor
└── __tests__/            # One file per page/component/context, `PageName.test.tsx` — render loader-backed
                            # pages through react-router's `createRoutesStub`, not a bare `render(<Page/>)`
    └── setup.ts          # jest-dom matchers
```

## E2E Tests

```
e2e/
├── auth.setup.ts                             # registers a user, saves storageState for the chromium project's other specs
├── auth.spec.ts                              # login validation, redirect-when-unauthenticated, session persistence, logout — fresh unauthenticated browser
├── happy-path.spec.ts                       # fill URL → run → poll → completed
├── cancel.spec.ts                           # soak test → cancel → cancelled
├── compare.spec.ts                          # create 2 tests → select → compare view
├── navigation.spec.ts                       # all main pages render without errors
├── flow-builder.spec.ts                     # build a multi-step flow by hand — steps, extract-variable rules, ignore-list (client-side only, no test run)
├── templates.spec.ts                        # save a preset from the home form, load it back, verify round-trip
├── schedules-webhooks.spec.ts                # schedule + webhook CRUD
├── result-detail.spec.ts                     # results/testId page interactions
├── recorder.spec.ts                          # drives the recorded browser via noVNC (test.slow())
└── error-handling-regressions.spec.ts        # 4 ui-service findings — non-2xx responses treated as success (TODO follow-up #5)
```

`trace: 'retain-on-failure'` (`playwright.config.ts`) captures a Playwright trace on any failed run — no `--retries` needed to get one, since the project runs with `retries: 0`.

## Infrastructure

```
docker-compose.yml
├── postgres         # PostgreSQL 16 (port 5432)
├── rabbitmq         # RabbitMQ 3 management (ports 5672, 15672)
├── redis            # Redis 7 (port 6379, shared store for @fastify/rate-limit)
├── api-service      # (port 3000)
├── ai-service       # (no external port)
├── worker-backend   # (port 3002 health)
├── worker-client    # (port 3003 health)
├── analyser-service # (port 3008)
├── results-service  # (port 3004)
├── recorder-service # (port 3007 + 6080 noVNC)
└── ui               # (port 3006)
```

## Key Patterns by Location

| Concern | File |
|---------|------|
| 3-way script routing | api-service/src/index.ts |
| k6 script generation | ai-service/src/generator.ts (FLOW_PROMPT, BACKEND_PROMPT, CLIENT_PROMPT) |
| k6 metrics parsing | worker-backend/src/parser.ts |
| Performance thresholds | results-service/src/analyzer.ts |
| WebSocket broadcasts | results-service/src/ws.ts |
| DB schema + migrations | results-service/src/db.ts createSchema() |
| Sensitive field masking | api-service/src/index.ts safeTestResponse() |
| Load profile options | api-service/src/options.ts buildK6Options() |
| Opaque session tokens | results-service/src/session.ts createSession()/getSession()/revokeSession() |
| Project creation/lookup | results-service/src/db.ts findOrCreateProject() |
| Auth endpoints | results-service/src/app.ts POST /auth/login, POST /auth/logout, GET /auth/me |
| UI auth state | services/ui/lib/AuthContext.tsx AuthProvider + useAuth |
| Browser metrics collection | services/worker-client/src/index.ts (INP, TBT, TTI, jsErrors, longTaskCount, domNodeCount, resourceBreakdown) |
