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
├── gain.json                 # Rosetta workspace config
└── CLAUDE.md                 # AI coding agent context (comprehensive)
```

## packages/shared — @alt/shared

```
packages/shared/
└── src/index.ts              # ALL shared types: TestType, FlowStep, BackendMetrics,
                              #   ClientMetrics, StepMetrics, SLOThresholds, etc.
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
├── index.ts   # k6 runner, per-test runDir, data file writing, saveScript(), Fastify health
├── parser.ts  # parseK6Output(), parseK6Errors(), aggregateWindow(), parseK6GroupMetrics()
└── logger.ts
└── src/__tests__/
    └── parser.test.ts  # All parser functions (25 tests)
```

## services/worker-client — Port 3003 (health only)

```
services/worker-client/src/
└── index.ts   # Puppeteer sessions, Web Vitals, Lighthouse, DLQ retry, Fastify health
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
├── session.ts    # signSession()/verifySession(): HMAC-SHA256 cookie sessions; SessionPayload type
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
    ├── session.test.ts   # signSession/verifySession unit tests (11 tests)
    ├── consumer.test.ts  # handleResult pipeline, webhooks (11 tests)
    ├── stale.test.ts     # runStaleCleanup (10 tests)
    └── scheduler.test.ts # startScheduler, triggerSchedule (12 tests)
```

## services/ui — Port 3006

```
services/ui/
├── index.html        # Vite entry HTML
├── vite.config.ts    # Vite config: tailwind plugin, @/ alias, polling watcher, /api+/data proxy
├── src/
│   ├── main.tsx      # React entry (ReactDOM.createRoot)
│   └── App.tsx       # BrowserRouter + routes + RootLayout + AuthGate
├── lib/
│   ├── api.ts              # All fetch wrappers (API + Results service) + types; login/logout/getMe
│   ├── AuthContext.tsx     # AuthProvider + useAuth hook; SessionUser type; getMe on mount
│   └── ResultsSocketContext.tsx  # WebSocket context (useResultsSocket hook)
├── app/
│   ├── globals.css   # Tailwind 4 CSS-first config + Command Center CSS vars
│   ├── layout.tsx    # Shell: Sidebar + TopBar + ActiveTests + main + BottomNav
│   ├── page.tsx      # New Test form (2-col bento) + flow runner + script mode + INP/TBT SLOs
│   ├── login/
│   │   └── page.tsx          # Login form — username + project name → POST /auth/login
│   ├── results/
│   │   ├── page.tsx           # Results list (table + mobile cards)
│   │   ├── [testId]/page.tsx  # Test detail (bento grid + charts + analysis)
│   │   └── compare/page.tsx   # Side-by-side metric diff
│   ├── webhooks/page.tsx      # Webhook CRUD + Log Sources CRUD
│   ├── schedules/page.tsx     # Schedule CRUD + manual trigger
│   └── presets/page.tsx       # Preset CRUD + load into form
└── app/components/
    ├── Sidebar.tsx          # Collapsible icon-rail sidebar
    ├── BottomNav.tsx        # Mobile bottom tab bar
    ├── TopBar.tsx           # Mobile top bar
    ├── ActiveTests.tsx      # Running tests strip (WS-driven)
    ├── SystemHealth.tsx     # Amber warning strip (polls /system/health 15s)
    ├── WorkerHealth.tsx     # CPU/memory/active bars per worker
    ├── BackendChart.tsx     # Bar charts: response time + request breakdown
    ├── ClientChart.tsx      # Radar + VitalCards (Core Web Vitals incl. INP/TBT) + Page Health + Resource Breakdown
    ├── FlowStepChart.tsx    # Grouped bar: avg+p95 per step
    ├── AnalysisPanel.tsx    # Perf badge + threshold violations + AI insights
    ├── RealtimeChart.tsx    # 3-panel live metrics (response time, error rate, throughput)
    ├── TrendChart.tsx       # p95/LCP trend line across runs for same URL
    └── FlowBuilder.tsx      # Multi-step flow editor + HAR import + Record button + per-step "Request headers" editor
└── __tests__/
    ├── setup.ts                       # jest-dom matchers
    ├── ActiveTests.test.tsx           # (6 tests)
    ├── AnalysisPanel.test.tsx         # (9 tests)
    ├── AuthContext.test.tsx           # AuthProvider + AuthGate (6 tests)
    ├── FlowBuilder.test.tsx           # (new)
    ├── home.test.tsx                  # form validation, presets, INP/TBT SLOs (14 tests)
    ├── LoginPage.test.tsx             # login form + API calls (5 tests)
    ├── ResultsSocketContext.test.tsx  # (new)
    ├── results.test.tsx               # compare bar, checkboxes, Re-run button (9 tests)
    ├── SystemHealth.test.tsx          # (new)
    ├── WorkerHealth.test.tsx          # (new)
    └── interpolateLogSourceUrl.test.tsx  # (new)
```

## E2E Tests

```
e2e/
├── happy-path.spec.ts  # fill URL → run → poll → completed
├── cancel.spec.ts      # soak test → cancel → cancelled
└── compare.spec.ts     # create 2 tests → select → compare view
```

## Infrastructure

```
docker-compose.yml
├── postgres         # PostgreSQL 16 (port 5432)
├── rabbitmq         # RabbitMQ 3 management (ports 5672, 15672)
├── redis            # Redis 7 (port 6379, unused)
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
| Cookie session signing | results-service/src/session.ts signSession()/verifySession() |
| Project creation/lookup | results-service/src/db.ts findOrCreateProject() |
| Auth endpoints | results-service/src/app.ts POST /auth/login, POST /auth/logout, GET /auth/me |
| UI auth state | services/ui/lib/AuthContext.tsx AuthProvider + useAuth |
| Browser metrics collection | services/worker-client/src/index.ts (INP, TBT, TTI, jsErrors, longTaskCount, domNodeCount, resourceBreakdown) |
