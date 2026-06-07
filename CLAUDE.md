# AI Load Testing Platform — Claude Code Context

## Project Overview
Distributed AI-powered load testing platform. Users describe what they want to test (or build a multi-step flow),
Gemini AI generates k6 or Puppeteer scripts automatically, workers execute them,
and results are stored with performance analysis, regression detection, and per-step breakdown.

## Architecture

```
POST /tests → api-service → checks DB for existing script
                    ↓ (no script)
              RabbitMQ: ai-requests
                    ↓ (script found, no description)        ↓ (script found + description)
              skip AI, go directly               ai-service: compareDescriptions()
                    ↓                               ↓ REUSE         ↓ REGENERATE
                    ↓                          use cached       generateScript()
                    ↓                               ↓                   ↓
              RabbitMQ: backend-tests OR client-tests
                    ↓                        ↓
          worker-backend (k6)      worker-client (Puppeteer)
                    ↓                        ↓
              RabbitMQ: test-results
                    ↓
          results-service → POST /analyse → analyser-service (Gemini AI insights)
                    ↓ (12s timeout; falls back to local deterministic analysis if unreachable)
          results-service → PostgreSQL
          (saves result + analysis + aiInsights + fires webhooks)

Cancel path:
POST /tests/:id/cancel → api-service → cancel-fanout exchange → all worker replicas

Scheduled path:
node-cron in results-service → POST /tests (auto-trigger on schedule)
```

## Services & Ports

| Service           | Port       | Description                                           |
|-------------------|------------|-------------------------------------------------------|
| api-service       | 3000       | Fastify REST API, test routing, CORS                  |
| ai-service        | 3001       | Gemini API integration, script generation             |
| analyser-service  | 3008       | Deterministic analysis + AI insights (Gemini)         |
| worker-backend    | 3002       | k6 runner, metrics parsing, live metrics posting      |
| worker-client     | 3003       | Puppeteer + Lighthouse, Web Vitals collector          |
| results-service   | 3004       | PostgreSQL storage, REST API + WebSocket (/ws), analyzer, scheduler |
| ui                | 3006       | Vite + React Router v7 SPA                            |
| recorder-service  | 3007/6080  | Flow recorder (Puppeteer CDP capture + noVNC viewer)  |
| postgres          | 5432       | Main database                                         |
| rabbitmq          | 5672       | Message queue (management UI: 15672)                  |
| redis             | 6379       | Running but not yet used                              |

## Tech Stack

- **Runtime:** Node.js 20 + TypeScript
- **API Framework:** Fastify + @fastify/cors + @fastify/cookie v11
- **Message Queue:** RabbitMQ (amqplib)
- **Database:** PostgreSQL (pg)
- **AI:** Google Gemini API (@google/generative-ai), model: gemini-2.5-flash
- **Load Testing:** k6 (installed in worker-backend Docker image)
- **Browser Testing:** Puppeteer 22 + Lighthouse (headless Chromium in Alpine)
- **Frontend:** Vite 6 + React Router v7 + Tailwind CSS 4 + Recharts
- **Containerization:** Docker + docker-compose
- **Monorepo:** npm workspaces
- **Logging:** Pino (structured JSON, every service)
- **Scheduling:** node-cron (in results-service)
- **PDF Reports:** pdfkit
- **Testing:** Vitest + @testcontainers/postgresql + Playwright

## Repository Structure

```
ai-load-testing-platform/
├── package.json              # root — npm workspaces config
├── tsconfig.json             # base TypeScript config
├── vitest.config.ts          # Vitest config (unit + integration + UI tests)
├── playwright.config.ts      # Playwright E2E config (baseURL: localhost:3006)
├── docker-compose.yml        # base services + infrastructure
├── docker-compose.dev.yml    # dev hot-reload overrides (tsx watch + WATCHPACK_POLLING)
├── docker-compose.prod.yml   # production overrides (Caddy HTTPS, no internal ports, resource limits)
├── Caddyfile                 # Caddy reverse proxy config (subdomain routing, auto TLS)
├── .env                      # GEMINI_API_KEY (never commit)
├── CLAUDE.md                 # this file
├── e2e/                      # Playwright E2E specs (require docker compose up)
│   ├── happy-path.spec.ts    # create test → poll → completed
│   ├── cancel.spec.ts        # soak test → cancel → cancelled status
│   └── compare.spec.ts       # create 2 tests → select → compare view
├── packages/
│   └── shared/               # @alt/shared — shared types (build: npm run build:shared)
│       └── src/index.ts
└── services/
    ├── api-service/          # @alt/api-service
    │   └── src/
    │       ├── index.ts      # Fastify app, POST /tests (three-way routing), cancel
    │       ├── queue.ts      # RabbitMQ publisher (ai-requests, backend-tests, cancel-fanout)
    │       ├── scripts.ts    # findExistingScript, incrementUsedCount, stepsToKey
    │       ├── options.ts    # buildK6Options (load profiles), replaceK6Options
    │       └── logger.ts     # Pino logger
    │   └── src/__tests__/
    │       ├── index.test.ts # POST /tests routing branches, cancel, health
    │       ├── options.test.ts # buildK6Options + replaceK6Options unit tests
    │       └── scripts.test.ts # findExistingScript integration (Testcontainers)
    ├── ai-service/           # @alt/ai-service
    │   └── src/
    │       ├── index.ts      # RabbitMQ consumer: comparison branch + generation
    │       ├── generator.ts  # generateScript (BACKEND/CLIENT/FLOW_PROMPT) + compareDescriptions
    │       │                 #   renderExtractLine, parameterization instructions (SharedArray)
    │       └── logger.ts
    │   └── src/__tests__/
    │       └── generator.test.ts # FLOW_PROMPT extraction rules, parameterization, compareDescriptions
    ├── worker-backend/       # @alt/worker-backend
    │   └── src/
    │       ├── index.ts      # k6 runner, per-test runDir, data file writing (data.json/data.csv),
    │       │                 #   saveScript (with description), Fastify health server (port 3002)
    │       ├── parser.ts     # parseK6Output, parseK6Errors (replaces parseK6StatusCodes),
    │       │                 #   aggregateWindow (per-step), parseK6GroupMetrics
    │       └── logger.ts
    │   └── src/__tests__/
    │       └── parser.test.ts # unit tests for all parser functions incl. error categorization
    ├── worker-client/        # @alt/worker-client
    │   └── src/
    │       └── index.ts      # Puppeteer sessions, Web Vitals, Lighthouse, DLQ retry,
    │                         #   Fastify health server on PORT (default 3003)
    ├── analyser-service/     # @alt/analyser-service  (port 3008)
    │   └── src/
    │       ├── index.ts      # Fastify POST /analyse endpoint + GET /health
    │       ├── analyzer.ts   # Deterministic threshold + regression logic (mirror of results-service)
    │       ├── aiInsights.ts # Gemini AI insights: narrative, anomalies, root causes, recommendations
    │       └── logger.ts
    │   ├── Dockerfile
    │   └── tsconfig.json
    ├── recorder-service/     # @alt/recorder-service  (port 3007 + noVNC :6080)
    │   └── src/
    │       ├── index.ts      # Fastify REST: POST /recordings/start, GET /:id, POST /:id/stop, DELETE /:id
    │       ├── recorder.ts   # Puppeteer non-headless launch, CDP Network capture, toFlowSteps()
    │       ├── correlator.ts # AI correlation: Gemini prompt → ExtractRule per FlowStep
    │       └── logger.ts
    │   ├── Dockerfile        # node:20-alpine + chromium + xvfb + x11vnc + novnc; USER node
    │   ├── Dockerfile.dev    # same base, uses tsx watch
    │   ├── docker-entrypoint.sh      # starts Xvfb :99, x11vnc, noVNC, then node dist/index.js
    │   └── docker-entrypoint-dev.sh  # starts Xvfb :99, x11vnc, noVNC, then tsx watch
    ├── results-service/      # @alt/results-service
    │   └── src/
    │       ├── index.ts      # startup: initDb → consumer → scheduler → cleanup → app
    │       ├── app.ts        # Fastify REST API (all endpoints + auth: /auth/login, /auth/logout, /auth/me)
    │       ├── session.ts    # signSession/verifySession — HMAC-SHA256 HttpOnly cookie sessions
    │       ├── consumer.ts   # RabbitMQ consumer, handleResult, webhook firing
    │       ├── analyzer.ts   # analyzeResult: thresholds + regression detection
    │       ├── db.ts         # PostgreSQL pool, createSchema (all tables + migrations), findOrCreateProject
    │       ├── scheduler.ts  # node-cron, startScheduler, triggerSchedule
    │       ├── cleanup.ts    # runStaleCleanup: running>15min / pending>30min → failed
    │       └── logger.ts
    │   └── src/__tests__/
    │       ├── api.test.ts       # all REST endpoints (Testcontainers)
    │       ├── analyzer.test.ts  # analyzeResult unit tests (incl. INP/TBT thresholds)
    │       ├── auth.test.ts      # POST /auth/login, /logout, GET /auth/me, session middleware (Testcontainers)
    │       ├── session.test.ts   # signSession/verifySession unit tests
    │       ├── consumer.test.ts  # handleResult pipeline, webhooks, baseline ordering
    │       ├── stale.test.ts     # runStaleCleanup unit tests (Testcontainers)
    │       └── scheduler.test.ts # startScheduler, triggerSchedule (mocked node-cron)
    └── ui/                   # @alt/ui — Vite 6 + React Router v7 SPA
        ├── index.html        # Vite entry HTML (loads src/main.tsx)
        ├── vite.config.ts    # Vite config: tailwindcss plugin, @/ alias, polling watcher
        ├── src/
        │   ├── main.tsx      # React entry point (ReactDOM.createRoot)
        │   └── App.tsx       # BrowserRouter + route definitions + RootLayout
        ├── vitest.d.ts       # jest-dom type declarations (/// <reference types>)
        ├── lib/
        │   ├── api.ts        # fetch wrappers for all service endpoints + types (uses import.meta.env.VITE_*)
        │   │                 #   also: login(), logout(), getMe() for auth
        │   └── AuthContext.tsx  # AuthProvider + useAuth hook; SessionUser type; getMe() on mount
        ├── __tests__/
        │   ├── setup.ts      # expect.extend(jest-dom matchers)
        │   ├── ActiveTests.test.tsx
        │   ├── AnalysisPanel.test.tsx
        │   ├── AuthContext.test.tsx    # AuthProvider + AuthGate unit tests
        │   ├── home.test.tsx           # form validation + INP/TBT SLO inputs
        │   ├── LoginPage.test.tsx      # login form + API call behaviour
        │   └── results.test.tsx
        └── app/
            ├── globals.css   # Tailwind 4 CSS-first config; CSS vars for Command Center palette
            ├── layout.tsx    # shell: Sidebar + TopBar + ActiveTests strip + main + BottomNav
            ├── page.tsx      # New Test — 2-col bento: form left, quick-stats panel right
            │                 #   + INP/TBT SLO threshold inputs for browser type
            ├── login/
            │   └── page.tsx  # login form: username + project name → POST /auth/login
            ├── results/
            │   ├── page.tsx              # 2-line table rows (desktop) + card list (mobile)
            │   ├── [testId]/page.tsx     # 12-col bento grid: metric cells + charts + analysis
            │   └── compare/page.tsx      # side-by-side metric diff table
            ├── webhooks/page.tsx         # webhook CRUD management
            ├── schedules/page.tsx        # schedule CRUD + manual trigger
            ├── presets/page.tsx          # preset CRUD + load into form
            └── components/
                ├── Sidebar.tsx       # collapsible icon-rail sidebar (220px ↔ 48px, localStorage)
                ├── BottomNav.tsx     # mobile bottom tab bar (5 items, lg:hidden)
                ├── TopBar.tsx        # mobile top bar h-10 with page title (lg:hidden)
                ├── ActiveTests.tsx   # inline strip (bg-[#ddf4ff]) showing running tests
                ├── SystemHealth.tsx  # amber warning strip — polls /system/health every 15s; handles saturated
                ├── WorkerHealth.tsx  # compact CPU/memory/active-test bars per worker (polls /system/health)
                ├── BackendChart.tsx  # bar charts: response time distribution + request breakdown
                ├── ClientChart.tsx   # radar + Core Web Vitals cards (INP/TBT incl.) + Page Health + Resource Breakdown
                ├── FlowStepChart.tsx # grouped bar chart: avg+p95 per step (flow results)
                ├── AnalysisPanel.tsx # perf status badge + threshold violations + regression diffs
                ├── RealtimeChart.tsx # 3-panel live metrics (response time, error rate, throughput)
                ├── TrendChart.tsx    # p95/LCP trend line across runs for same URL
                └── FlowBuilder.tsx   # multi-step flow editor + HAR import + 🔴 Record button
                                    #   + extract source selector + inline data table + CSV upload
                                    #   + "Clear all" button + "Ignore list" for recordings
            # page.tsx also contains: flowRunner state + "Run as" toggle for flow tests
            #   + scriptMode state + "Script source" toggle (AI Generate | Custom Script) for backend tests
```

## Database Schema

```sql
-- Generated k6/Puppeteer scripts (reused across tests)
-- description: the user description used to generate the script (for AI-powered reuse comparison)
-- For flow tests, target_url stores the SHA-256 hash key: 'flow:<hex16>'
CREATE TABLE test_scripts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_url  TEXT NOT NULL,
  test_type   VARCHAR(20) NOT NULL,   -- 'backend' | 'client-side'
  script      TEXT NOT NULL,
  description TEXT,                   -- prompt description used when generating this script
  used_count  INTEGER DEFAULT 1,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(target_url, test_type)
);

-- Test results with analysis
CREATE TABLE test_results (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id          UUID NOT NULL UNIQUE,
  type             VARCHAR(20) NOT NULL,   -- 'backend' | 'client-side' | 'flow'
  target_url       TEXT NOT NULL,
  status           VARCHAR(20) NOT NULL,   -- 'pending'|'running'|'completed'|'failed'|'cancelled'
  status_message   TEXT,                   -- real-time progress from ai-service (retry info, errors)
  metrics          JSONB,                  -- BackendMetrics | ClientMetrics (incl. stepMetrics[])
  steps            JSONB,                  -- FlowStep[] stored for flow tests; enables re-run restoration
  script_id        UUID REFERENCES test_scripts(id),
  reused_script    BOOLEAN DEFAULT FALSE,
  perf_status      VARCHAR(20),            -- 'passed' | 'degraded' | 'failed'
  analysis         JSONB,                  -- diffs, threshold violations, summary
  is_baseline      BOOLEAN DEFAULT FALSE,  -- used as reference for regression comparisons
  duration_seconds INTEGER,               -- test duration in seconds (for countdown timer)
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_test_results_status ON test_results(status);
CREATE INDEX idx_test_results_url_type_status ON test_results(target_url, type, status);

-- Live streaming metrics during k6 execution (5-second windows)
CREATE TABLE live_metrics (
  id                SERIAL PRIMARY KEY,
  test_id           UUID NOT NULL,
  timestamp         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  vus               INTEGER NOT NULL DEFAULT 0,
  rps               FLOAT NOT NULL DEFAULT 0,
  avg_response_time FLOAT NOT NULL DEFAULT 0,
  error_rate        FLOAT NOT NULL DEFAULT 0,
  step_metrics      JSONB                 -- [{name, avgResponseTime, rps, errorRate}] for flow tests
);
CREATE INDEX live_metrics_test_id_idx ON live_metrics(test_id);

-- External log source deep-link templates (renders "View Logs" buttons on result detail page)
CREATE TABLE log_sources (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  platform     VARCHAR(30),             -- 'Grafana' | 'Datadog' | 'Kibana' | 'Loki' | 'OpenSearch' | 'Custom'
  url_template TEXT NOT NULL,           -- supports {startedAtMs}, {completedAtMs}, {startedAtISO}, {completedAtISO}, {targetUrl}, {targetUrlEncoded}, {testId}
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Webhook endpoints (fire on perf_status = failed or degraded)
CREATE TABLE webhooks (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url        TEXT NOT NULL,
  events     TEXT[] NOT NULL DEFAULT '{failed,degraded}',
  secret     TEXT,                    -- optional HMAC signing secret
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Scheduled test runs (node-cron)
CREATE TABLE schedules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  cron        TEXT NOT NULL,          -- standard cron expression
  type        VARCHAR(20) NOT NULL,
  target_url  TEXT NOT NULL,
  description TEXT,
  options     JSONB NOT NULL,
  thresholds  JSONB,
  enabled     BOOLEAN DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Reusable test presets (pre-fill form on home page)
CREATE TABLE test_presets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  type        VARCHAR(20) NOT NULL,
  target_url  TEXT,
  options     JSONB NOT NULL,
  thresholds  JSONB,
  used_count  INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Auth projects (multi-tenancy) — migration #5
-- All resource tables carry project_id FK; null = auth disabled (dev mode)
CREATE TABLE projects (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
-- project_id added to: test_results, test_scripts, test_presets, schedules, webhooks, log_sources
```

## Shared Types (@alt/shared)

```typescript
type TestType    = 'backend' | 'client-side' | 'flow'
type TestStatus  = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
type LoadProfile = 'load' | 'spike' | 'capacity' | 'soak'

type ExtractSource = 'jsonpath' | 'header' | 'cookie' | 'regex'
interface ExtractRule { source: ExtractSource; expression: string }

interface FlowStep {
  name: string; url: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  body?: string; headers?: Record<string, string>
  extract?: Record<string, ExtractRule>  // variable_name → extraction rule (source + expression)
}

interface StepMetrics {
  name: string; avgResponseTime: number; p95ResponseTime: number
  requestsTotal: number; requestsFailed: number
}

interface LiveStepMetric { name: string; avgResponseTime: number; rps: number; errorRate: number }

interface SLOThresholds {
  p95?: number; avg?: number; errorRate?: number; serverErrorRate?: number; timeoutRate?: number
  lcp?: number; fcp?: number; ttfb?: number; cls?: number
  inp?: number; tbt?: number
}

interface ErrorBreakdown { success, clientError, serverError, timeout, networkError: number }

interface TestRequest {
  id: string; type: TestType; targetUrl: string; description: string
  options: BackendTestOptions | ClientTestOptions
  thresholds?: SLOThresholds
  steps?: FlowStep[]               // for 'flow' type
  envVars?: Record<string, string> // passed to k6 as --env, never stored in DB
  testData?: Array<Record<string, string>> // inline data table — NOT stored in DB
  csvData?: string                 // base64-encoded CSV — NOT stored in DB
  csvFilename?: string
  createdAt: string
}

interface EnrichedTestRequest extends TestRequest {
  generatedScript?: string
  scriptId?: string
  reusedScript?: boolean
  scriptCacheKey?: string          // for flow: 'flow:<sha256hex16>'
  cachedScript?: string            // carried to ai-service when description comparison needed
  cachedScriptDescription?: string | null  // stored description of the cached script
}

interface HttpOptions { keepAlive?, timeout?, http2?, discardResponseBodies?: boolean }
interface BackendTestOptions { vus, duration, rampUp?, profile?: LoadProfile, peakVus?, httpOptions?: HttpOptions }
interface ClientTestOptions  { sessions, duration, collectWebVitals }

interface BackendMetrics {
  type: 'backend'
  requestsTotal, requestsFailed, avgResponseTime
  p50ResponseTime, p95ResponseTime, p99ResponseTime, rps
  statusCodes?: Record<string, number>
  errorBreakdown?: ErrorBreakdown  // categorized: success/4xx/5xx/timeout/network
  stepMetrics?: StepMetrics[]      // only for 'flow' type tests
}

interface WorkerMetrics { cpuPercent, memoryMb, memoryPercent, activeTests, maxTests: number }
interface ServiceHealth { name, status: 'ok'|'degraded'|'saturated'|'unreachable'; checks: Record<string,string>; metrics?: WorkerMetrics }

interface ResourceBreakdown { jsSize, cssSize, imageSize, fontSize, xhrSize, totalSize, requestCount: number }
interface LighthouseScore { performance, accessibility, bestPractices, seo } // 0-100
interface ClientMetrics {
  type: 'client'; lcp: number; fid: number; cls: number; ttfb: number; fcp: number
  inp?: number; tbt?: number; tti?: number
  jsErrors?: number; longTaskCount?: number; domNodeCount?: number
  resourceBreakdown?: ResourceBreakdown; lighthouseScore?: LighthouseScore
}

interface TestScript { id, targetUrl, testType, script, description?, usedCount, createdAt, updatedAt }
interface LiveMetricPoint { timestamp, vus, rps, avgResponseTime, errorRate, stepMetrics?: LiveStepMetric[] }
```

## API Endpoints

### api-service (port 3000)
- `GET  /health` — deep health check (DB + RabbitMQ); 503 if any dep is down
- `POST /tests`  — create test
  - body: `{ type, targetUrl, description, options, thresholds?, steps?, envVars?, testData?, csvData?, csvFilename?, customScript? }`
  - `type` = `'backend'` | `'client-side'` | `'flow'`
  - for flow: `steps[]` required, `targetUrl` defaults to `steps[0].url`
  - `envVars` passed to k6 as `--env KEY=VALUE` flags, **not stored in DB**
  - `customScript` (optional) — user-supplied k6 script (≤ 512 KB); bypasses AI and script cache entirely, routes direct to worker; **not stored in DB**
  - description is parsed for VUs/duration/ramp-up/profile at form level; AI uses it for script content
- `POST /tests/:testId/cancel` — cancel running/pending test; publishes to cancel-fanout exchange

### results-service (port 3004)
**Results**
- `POST /results/pending`         — create pending record `{ testId, type, targetUrl, durationSeconds?, steps? }` — steps stored for flow re-run
- `GET  /results`                 — all results (last 50, joined with script text)
- `GET  /results/active`          — tests with status pending/running
- `GET  /results/compare?a=&b=`   — side-by-side diff of two completed results
- `GET  /results/trend?url=`      — chronological metric trend for a URL (p95 or LCP)
- `GET  /results/:testId`         — single result with joined `script` + `script_description` from test_scripts
- `POST /results/:testId/cancel`  — set status = cancelled in DB
- `POST /results/:testId/running` — set status = running + started_at = NOW() + status_message = NULL (called by workers on start; clears stale AI message)
- `POST /results/:testId/fail`    — set status = failed (called by ai-service on DLQ exhaustion)
- `POST /results/:testId/message` — update status_message field (ai-service progress updates)
- `POST /results/:testId/live`    — save live metric point with optional `stepMetrics` (called by worker-backend)
- `GET  /results/:testId/live`    — all live points for a test (chronological), includes `stepMetrics`
- `POST /results/:testId/baseline` — mark as baseline for regression comparisons
- `DELETE /results/:testId/baseline` — clear baseline flag
- `GET  /results/:testId/report.pdf` — download pdfkit PDF report
- `GET  /system/health`           — aggregated health of all 5 services (calls each /health in parallel)

**Scripts**
- `GET  /scripts`      — all saved scripts (by used_count DESC)
- `GET  /scripts/:id`  — single script
- `DELETE /scripts/:id` — delete script (next test re-generates via AI)

**Webhooks**
- `GET    /webhooks`      — list all webhooks
- `POST   /webhooks`      — create `{ url, events?, secret? }`
- `DELETE /webhooks/:id`  — delete webhook

**Schedules**
- `GET  /schedules`          — list all schedules
- `POST /schedules`          — create `{ name, cron, type, target_url, options, ... }` — body uses snake_case `target_url`
- `PUT  /schedules/:id`      — update schedule (including enable/disable)
- `DELETE /schedules/:id`    — delete schedule (stops cron job)
- `POST /schedules/:id/run`  — manual immediate trigger

**Presets**
- `GET    /presets`      — list all presets (by used_count DESC)
- `POST   /presets`      — create `{ name, type, target_url, options, thresholds?, description? }`
- `GET    /presets/:id`  — single preset (increments used_count)
- `DELETE /presets/:id`  — delete preset

**Log Sources**
- `GET    /log-sources`      — list all log sources
- `POST   /log-sources`      — create `{ name, platform?, urlTemplate }` — `urlTemplate` supports `{startedAtMs}`, `{completedAtMs}`, `{startedAtISO}`, `{completedAtISO}`, `{targetUrl}`, `{targetUrlEncoded}`, `{testId}`
- `DELETE /log-sources/:id`  — delete log source

**Auth (cookie session — requires SESSION_SECRET)**
- `POST /auth/login`  — `{ username, projectName }` → creates or joins project → sets `alt_session` HttpOnly cookie; returns `{ projectId, username, projectName }`. If SESSION_SECRET empty: returns `{ dev: true }` with no cookie
- `POST /auth/logout` — clears `alt_session` cookie → `{ success: true }`
- `GET  /auth/me`     — returns current session payload or `401` if no valid cookie

## RabbitMQ Queues & Exchanges

| Queue / Exchange      | Type   | Producer          | Consumer          | Purpose                              |
|-----------------------|--------|-------------------|-------------------|--------------------------------------|
| `ai-requests`         | queue  | api-service       | ai-service        | tests needing AI script gen or comparison |
| `ai-requests.dlq`     | queue  | ai-service        | —                 | exhausted after 3 retries            |
| `backend-tests`       | queue  | ai-service        | worker-backend    | k6 tests (backend + flow type)       |
| `backend-tests.dlq`   | queue  | worker-backend    | —                 | failed k6 tests after 3 retries      |
| `client-tests`        | queue  | ai-service        | worker-client     | Puppeteer tests                      |
| `client-tests.dlq`    | queue  | worker-client     | —                 | failed Puppeteer tests               |
| `test-results`        | queue  | worker-backend    | results-service   | completed test results               |
|                       |        | worker-client     |                   |                                      |
| `cancel-fanout`       | fanout | api-service       | all worker replicas | cancel signal broadcast            |

**DLQ retry logic (all consumers):** `x-retry-count` header incremented on each retry.
After 3 retries the message is routed to `<queue>.dlq` and acked.

## Key Implementation Details

### Script Reuse — Three-Way Routing (api-service/index.ts)

`POST /tests` uses three-way logic based on whether an existing script and description are present:

1. **Cache miss** (no existing script) → send to `ai-requests` queue → ai-service generates via Gemini
2. **Hit + no description** (or flow test) → inject new k6 options into cached script → bypass ai-service, send directly to worker queue; increment `used_count`
3. **Hit + description provided** → send to `ai-requests` queue with `cachedScript` + `cachedScriptDescription` attached → ai-service calls `compareDescriptions()` for Gemini verdict

### Semantic Script Comparison (ai-service/generator.ts)

`compareDescriptions(newDescription, storedDescription)` → `'REUSE' | 'REGENERATE'`
- Sends both descriptions to `gemini-2.5-flash` with a tight prompt asking for one-word verdict
- Defaults to `'REGENERATE'` on any unexpected response or error (safe fallback)
- Same 3-attempt retry loop with 60/120/180s backoff as `generateScript`

**ai-service consumer branching:**
- If `cachedScript` + `description` present and `cachedScriptDescription != null` → call `compareDescriptions()`
  - `REUSE` → forward cached script to worker queue, mark `reusedScript: true`
  - `REGENERATE` → clear `scriptId`, fall through to `generateScript()`
- If `cachedScriptDescription` is null (legacy row) → always regenerate
- Otherwise → standard `generateScript()` path

**used_count tracking:** `findExistingScript` no longer auto-increments. Increment happens in:
- api-service (`incrementUsedCount`) on direct bypass (path 2 above)
- worker-backend (`saveScript` with `scriptId` present) on confirmed REUSE from ai-service

### Script Description Storage (worker-backend/index.ts)

`saveScript(targetUrl, script, scriptId?, description?)`:
- If `scriptId` present (REUSE path) → increment `used_count` only, no INSERT
- If `scriptId` absent → INSERT/UPDATE with `description` column populated from `test.description`

### k6 Metrics Parsing (worker-backend/parser.ts)

- `parseK6Output(output)` — regex over k6 text output → `BackendMetrics`; k6 is invoked with `--summary-trend-stats avg,min,med,max,p(90),p(95),p(99)` so p99 is always present
- `parseK6StatusCodes(jsonContent)` — counts `http_reqs` points by `data.tags.status`
- `aggregateWindow(lines)` — aggregates 5-second k6 JSON windows → `LiveMetricPoint` with per-step data:
  - Collects `http_req_duration`, `http_reqs`, `http_req_failed` per `data.tags.group`
  - Returns `stepMetrics: [{name, avgResponseTime, rps, errorRate}]` when groups present
- `parseK6GroupMetrics(jsonContent)` — final per-step breakdown after test completes → `StepMetrics[]`

### Flow Test Execution (worker-backend)
- AI generates k6 script using `FLOW_PROMPT` with `group('Step N: name', fn)` per step
- `runK6Test(testId, script, envVars?)` passes `--env KEY=VALUE` args to k6 process
- `started_at` is set in DB when status transitions to `'running'` (used for countdown timer)
- After k6 exits, `parseK6GroupMetrics(jsonContent)` extracts per-step metrics
- `stepMetrics[]` attached to `BackendMetrics`; UI shows `FlowStepChart` + `StepMetricsTable`

### Live Metrics with Per-Step Data
- `aggregateWindow` returns `stepMetrics` per 5-second window when k6 group tags are present
- Results-service stores `step_metrics JSONB` in `live_metrics` table
- GET `/results/:testId/live` returns `stepMetrics` alongside aggregate metrics
- `RealtimeChart` detects `stepMetrics` and renders one colored line per step in all 3 charts:
  - Response time per step, Error rate per step, Throughput per step
  - Step names are sanitized (`toKey()`) for safe Recharts dataKey usage
  - Fixed chart height (`CHART_H = 160px`) regardless of step count; Recharts `<Legend>` removed from charts; single shared collapsible legend rendered below all 3 charts (shows first 4 steps, `+ N more` expands)

### Performance Analyzer (results-service/analyzer.ts)
Default thresholds: p95 < 1000ms, avg < 500ms, error rate < 1%, LCP < 2500ms,
FCP < 1800ms, TTFB < 800ms, CLS < 0.1, Lighthouse performance ≥ 50.
- Per-test SLO overrides via `thresholds` field in `TestRequest` (also saveable in presets)
- Compares vs baseline (if set) or vs previous run for same URL
- Regression: >20% worse on any metric → `degraded`; threshold violation → `failed`

### Test Cancellation
- `POST /tests/:testId/cancel` → api-service → results-service (sets DB status) → publishes to `cancel-fanout`
- Each worker replica has an exclusive auto-delete queue bound to the fanout exchange
- worker-backend: kills k6 process with SIGTERM; waits GRACE_PERIOD_MS then SIGKILL
- worker-client: calls `browser.close()`
- If test completes before cancel arrives, the cancel is a no-op

### Execution Timeouts
- worker-backend: `K6_MAX_DURATION_MS` (default 600000 = 10 min) → SIGTERM + 30s grace SIGKILL
- worker-client: `PUPPETEER_MAX_DURATION_MS` (default 300000 = 5 min) → same pattern
- worker-client: `PUPPETEER_NAV_TIMEOUT_MS` (default 60000 = 1 min) → `page.goto()` navigation timeout; raise for slow/heavy/bot-protected sites

### Stale Test Cleanup (results-service/cleanup.ts)
`setInterval` every 60 seconds:
- `status = 'running'` AND `started_at < NOW() - STALE_RUNNING_MINUTES` → `failed`
- `status = 'pending'` AND `created_at < NOW() - STALE_PENDING_MINUTES` → `failed`

### Scheduled Tests (results-service/scheduler.ts)
- `startScheduler(pool)` loads all enabled schedules from DB, registers `cron.schedule()` callbacks
- `triggerSchedule(schedule)` POSTs to api-service and updates `last_run_at`
- CRUD via REST API triggers `reloadSchedule` / `removeSchedule` to sync cron registry

### Webhook Firing (results-service/consumer.ts)
After `handleResult()` saves a result with non-null `perf_status`:
- Queries `webhooks` table for rows matching `events @> ARRAY[perf_status]`
- POSTs JSON payload `{ testId, targetUrl, perfStatus, metrics }` to each matching URL
- If `secret` is set, sends `X-Webhook-Signature: sha256=<hmac>` header
- Fired as fire-and-forget (`.catch(() => {})`) — does not block result save

### Extended Browser Metrics (worker-client/src/index.ts)

In addition to Core Web Vitals (LCP, FCP, CLS, TTFB), worker-client now collects:

| Metric | Source | Notes |
|--------|--------|-------|
| `inp` | Lighthouse `interaction-to-next-paint` audit (preferred) OR PerformanceObserver `event` type | INP replaced FID as a Core Web Vital (March 2024); threshold: 200ms |
| `tbt` | Lighthouse `total-blocking-time` audit | threshold: 200ms |
| `tti` | Lighthouse `interactive` audit | display only, no threshold |
| `jsErrors` | `page.on('pageerror', ...)` accumulator | count across all sessions |
| `longTaskCount` | PerformanceObserver `longtask` type with `{buffered: true}` | count per session |
| `domNodeCount` | Lighthouse `dom-size` audit `numericValue` | count of DOM nodes |
| `resourceBreakdown` | `performance.getEntriesByType('resource')` grouped by `initiatorType` | sizes in KB per type |

`avgResourceBreakdown()` helper averages across sessions that have resource data, then rounds to 1 decimal place.
All new fields are optional in `ClientMetrics` — absent when Lighthouse is not run or the metric is unsupported.

### Lighthouse Integration (worker-client)
- Runs after Puppeteer sessions, reuses the same Chrome instance via remote debugging port
- Collects performance, accessibility, best-practices, SEO scores (0–100)
- Extracts `interaction-to-next-paint`, `total-blocking-time`, `interactive`, `dom-size` audits
- `performance < 50` → analyzer treats as threshold violation → `perf_status = 'failed'`

### UI Layout — Command Center Design (Phase 6)
The UI follows a "Command Center" aesthetic: GitHub-style color palette, collapsible sidebar, bento grid, monospace metrics.

**Design tokens** (`globals.css` CSS vars): `#f6f7f8` background, `#ffffff` surface, `#d0d7de` border, `#0969da` accent, `#1f883d` success (primary button), `#cf222e` danger.

**Navigation:**
- Desktop: `Sidebar.tsx` — 220px full / 48px icon-rail (toggle persisted to `localStorage`). Active item highlighted with `bg-[#ddf4ff] text-[#0969da]`.
- Mobile: `TopBar.tsx` (h-10 sticky header) + `BottomNav.tsx` (5-tab bar, `fixed bottom-0`, `lg:hidden`).
- `ActiveTests.tsx` renders as an inline strip directly below the top bar when tests are running — not a floating element.

**Home page (`page.tsx`):**
- 2-column layout on `lg:` screens: form (flex-1) + quick-stats panel (w-72 fixed).
- Quick-stats panel fetches `getResults()` and `getActiveTests()` on mount; shows today's count, avg p95, pass rate, active tests, recent runs, preset shortcuts.
- Form type selector: segmented border-collapse buttons (Backend / Browser / Multi-step Flow).
- Preset select: `<select>` in header row, placeholder "Load from preset…".
- Action buttons in a `bg-[#f6f8fa]` footer strip: green primary "▶ Run Test" + ghost "Save preset".

**Results list (`results/page.tsx`):**
- Desktop: `<table>` with 2-line rows — primary line (URL + type/status badges), secondary line (date · rps · p95 in `font-mono text-[#57606a]`). Full-row `cursor-pointer` click navigates; "View →" link in last column.
- Mobile: stacked cards (`md:hidden`), one card per result with status dot + key metric.
- Status representation: colored `w-2 h-2 rounded-full` dot + `font-mono` text, not pill badges.

**Test detail (`results/[testId]/page.tsx`):**
- Bento grid: `grid grid-cols-2 md:grid-cols-4 lg:grid-cols-12 gap-3`.
- Metric cells: `lg:col-span-3` each — `font-mono font-bold text-[22px]` value, uppercase mono label.
- BackendChart + AnalysisPanel sit side by side: `lg:col-span-7` / `lg:col-span-5`.
- TrendChart and script block: `col-span-full`.
- Progress bar: `bg-[#0969da]` fill, displayed in a card with `LIVE` badge.

**Charts (all components):**
- `CartesianGrid stroke="#eaeef2" vertical={false}` — horizontal lines only, no verticals.
- All axis ticks: `{ fill: '#57606a', fontSize: 11, fontFamily: 'monospace' }`.
- Tooltip: `{ background: '#fff', border: '1px solid #d0d7de', borderRadius: '6px', fontFamily: 'monospace', boxShadow: 'none' }`.
- Primary line color `#0969da`; step colors `['#0969da','#1f883d','#9a6700','#7c3aed','#cf222e','#0891b2','#c2410c']`.

### UI Form — Test Creation (app/page.tsx)
- **Description field** is the primary input; Advanced settings (VUs, duration, ramp-up, profile) are collapsed by default
- **Auto-extraction from description:** on blur, `applyDescriptionParams()` parses natural language and updates the form:
  - **Test type detection:** "browser/puppeteer/web vitals/lighthouse" → switches to `client-side`; "backend/load test/api test/k6" → switches to `backend`; for flow tab, also flips `flowRunner` between `'k6'` and `'browser'`
  - **Numeric params:** VUs, sessions, duration (many formats), ramp-up
  - **Load profile:** spike / soak / capacity / load keywords
  - Advanced settings section auto-opens when any numeric param is detected
- **SLO thresholds:** collapsible section; backend/flow gets p95/avg/errorRate, browser gets LCP/FCP/TTFB/CLS/INP/TBT
- **Presets:** save/load includes description, URL, VUs, duration, profile, peakVus, thresholds; dropdown is controlled (always resets to placeholder after selection)
- **Flow runner selector** — below FlowBuilder, a toggle "Run as ⚡ k6 HTTP / 🌐 Puppeteer Browser" controls `flowRunner` state (`'k6'` | `'browser'`); when `'browser'` is selected `handleSubmit` sends `type: 'client-side'` with `sessions/duration/collectWebVitals` options; auto-set by `applyDescriptionParams` type detection

### UI Real-time Strategy
Real-time updates use **WebSocket push** (`ws://localhost:3004/ws`) for the highest-frequency events; low-frequency diagnostics remain as polling.
WebSocket server: `ws` package with `{ noServer: true }` attached to Fastify's `http.Server` via `server.on('upgrade', ...)`. `@fastify/websocket` not used — incompatible with Fastify v5 (requires `^4.x`).

- **WebSocket** (`useResultsSocket` hook, `services/ui/lib/useResultsSocket.ts`):
  - Result detail page: `test:status` event → update status immediately; `test:live` event → append metric point (replaces 2s polls)
  - `ActiveTests` strip: `tests:changed` / `test:status` → refetch active list (replaces 3s poll)
  - Results list page: `tests:changed` / `test:status` → refetch results (replaces 5s poll)
  - Auto-reconnects with exponential backoff (1s → 2s → … → 30s cap)
- **Still polling** (infrequent, acceptable overhead):
  - `SystemHealth` / `WorkerHealth`: `GET /system/health` every 15s
  - `AIStatus`: `GET /system/ai-status` every 60s
  - Home page: fetches `getResults()` + `getActiveTests()` once on mount for the quick-stats panel
  - FlowBuilder recording: polls recorder-service `GET /recordings/:id` every 1s (separate service)

### Countdown Timer & Elapsed X-axis
- `duration_seconds` stored in `test_results` at pending-record creation
- `started_at` set to `NOW()` when worker-backend transitions test to `'running'`
- Result detail page shows countdown + progress bar once both fields are non-null
- `RealtimeChart` X-axis shows elapsed time (`Xs` / `XmYYs`) by computing `timestamp - started_at`; falls back to wall-clock if `startedAt` is null

### Load Profile Stages (api-service/options.ts)
`buildK6Options(opts)` generates k6 JSON options based on `profile`:
- `load` (default): ramp 0→vus over 30s (or rampUp if set), hold for duration, ramp down
- `spike`: warm-up → pre-spike → spike to peakVus over 10s → hold → ramp down
- `capacity`: linear ramp from 0 to peakVus over duration (find the breaking point)
- `soak`: ramp to vus, hold for duration, ramp down (detect memory leaks)
`peakVus` defaults to `vus * 10` when not specified.

### Script Dry-Run Validation
Before executing any k6 script, `validateScript(scriptPath)` spawns `k6 inspect`.
On non-zero exit the script is rejected; the message is nacked and retried / DLQ'd.
k6 exit codes: `0` = pass, `99` = threshold violation (test ran; resolve with metrics), other non-zero = hard failure (reject → DLQ retry).

### Status Messages & Worker Health (ai-service/index.ts, api-service/index.ts)

**Real-time status messages** — ai-service posts to `POST /results/:testId/message` at each key point:
- `"Generating test script with AI…"` — before calling Gemini
- `"Gemini unavailable — retrying… (N attempts left)"` — on 429/503 retry
- `"Script ready — starting test…"` — after successful generation
- `"Script generation failed after 3 attempts — test could not start"` — on DLQ + marks test failed

**Worker availability check** — api-service calls `channel.checkQueue(queueName)` after publishing. If `consumerCount === 0`, posts a warning message: `"No browser (Puppeteer) worker is running — test will start when a worker comes online"`. Checked separately for backend (`backend-tests`) and browser (`client-tests`) queues. (`api-service/src/queue.ts` → `getWorkerConsumerCount`)

**Worker health endpoints** — both workers now expose `GET /health` via a lightweight Fastify server:
- `worker-backend` (port 3002): checks DB pool + RabbitMQ connection
- `worker-client` (port 3003): checks RabbitMQ connection

**System health aggregation** — `GET /system/health` on results-service calls all 4 service `/health` endpoints in parallel (3s timeout each), includes self-check, returns `{ healthy, services[] }`. HTTP 200 = all ok, 207 = partial degradation.

**SystemHealth UI component** (`services/ui/app/components/SystemHealth.tsx`):
- Polls `/system/health` every 15 seconds
- Shows dismissible amber warning strip when any service is `degraded` or `unreachable`
- Per-service impact text: "AI (Gemini) unreachable — New tests cannot be started", etc.
- Auto-clears when all services recover

### Baseline Management
`is_baseline` column on `test_results`. When a baseline exists for a URL:
- `consumer.ts` queries `ORDER BY is_baseline DESC, created_at DESC`
- Regression diffs are computed against the baseline, not the previous run
- UI shows amber "baseline" badge; Set/Clear buttons on result detail page

### Security

**API Key Authentication** (`api-service/src/index.ts`, `results-service/src/app.ts`):
- `onRequest` hook checks `X-API-Key` header against `API_KEYS` env var (comma-separated list)
- Returns `401` on missing/invalid key; `/health` and internal `/results/pending` are exempt
- Empty `API_KEYS` disables auth entirely — safe for local dev, required for cloud

**Cookie Session Authentication** (`results-service/src/session.ts`, `results-service/src/app.ts`):
- `POST /auth/login { username, projectName }` → `findOrCreateProject(name)` → HMAC-SHA256 sign payload → set `alt_session` cookie (HttpOnly, SameSite=Strict)
- `SESSION_SECRET` env var controls signing. Empty = auth disabled (no cookie, dev mode)
- Session middleware (Fastify `onRequest` hook) on all results-service routes except `/health`, `/auth/*`, internal `/results/pending`, `/results/:id/running|fail|message`, `/results/pending`
- Project isolation: all resource queries filter by `($N::uuid IS NULL OR project_id = $N::uuid)` — null when SESSION_SECRET is empty
- `signSession` / `verifySession` use `crypto.createHmac` + `timingSafeEqual` (constant-time comparison)

**CORS**: `ALLOWED_ORIGIN` env var replaces hardcoded `*` in both services. Defaults to `*` in dev.

**No hardcoded credentials**: all services throw `Error('... environment variable is required')` at startup if `DATABASE_URL` or `RABBITMQ_URL` are absent — no fallback to `alt_password` defaults.

**envVar injection safety** (`worker-backend/src/index.ts`): keys validated against `/^[A-Z_][A-Z0-9_]*$/i`, values stripped of `\n`/`\0`, length-capped (key ≤ 64, value ≤ 1024) before passing to k6 spawn.

**Input validation** (`api-service/src/index.ts`): `targetUrl` validated with `new URL()`, `description` ≤ 500 chars, `steps` ≤ 20.

**Production compose** (`docker-compose.prod.yml`): removes all internal port bindings (Postgres 5432, Redis 6379, RabbitMQ 5672/15672), adds memory/CPU limits per service.

**Deployment checklist:**
1. Rotate `GEMINI_API_KEY` (never commit `.env`)
2. Set strong random `API_KEYS` + `API_KEY`
3. Set `SESSION_SECRET` to a 32+ char random string
4. Set `DOMAIN=yourdomain.com` and add DNS A records for `yourdomain.com`, `api.yourdomain.com`, `data.yourdomain.com`
5. Set `ALLOWED_ORIGIN=https://yourdomain.com`
6. Run with `docker-compose.prod.yml` — Caddy handles HTTPS automatically

**HTTPS via Caddy** (`Caddyfile` + `docker-compose.prod.yml`):
- Caddy service listens on ports 80/443; auto-provisions TLS via Let's Encrypt
- `yourdomain.com` → UI (:3006) | `api.yourdomain.com` → api-service (:3000) | `data.yourdomain.com` → results-service (:3004)
- Direct service ports (3000, 3004, 3006) are NOT exposed in prod — only 80/443 via Caddy
- TLS certificates stored in `caddy_data` Docker volume (persists across restarts)

## Environment Variables

```bash
# .env (root — NEVER commit, add to .gitignore)
GEMINI_API_KEY=your_key_here
# COMPOSE_BAKE=true           # disabled — Windows path bug (doubled absolute path in bake evaluation)

# Set automatically by docker-compose:
RABBITMQ_URL=amqp://user:password@rabbitmq:5672
DATABASE_URL=postgresql://user:password@postgres:5432/alt_db
RESULTS_URL=http://results-service:3004
VITE_API_URL=http://localhost:3000
VITE_RESULTS_URL=http://localhost:3004

# Security (required for cloud/production):
DOMAIN=yourdomain.com         # used by Caddy for TLS + UI env var rewrites
API_KEYS=key1,key2            # comma-separated; empty string = auth disabled (dev only)
API_KEY=key1                  # single key passed to UI as VITE_API_KEY
SESSION_SECRET=change-me-...  # results-service: HMAC-SHA256 cookie signing; empty = auth disabled
ALLOWED_ORIGIN=https://yourdomain.com  # CORS origin; defaults to * in dev

# Worker tuning (optional, have defaults):
WORKER_CONCURRENCY=1          # worker-backend (default 1)
# WORKER_CONCURRENCY=2        # worker-client  (default 2)
# WORKER_CONCURRENCY=3        # ai-service     (default 3)
K6_MAX_DURATION_MS=600000     # 10 minutes hard limit per k6 test
PUPPETEER_MAX_DURATION_MS=300000  # 5 minutes hard limit per Puppeteer test
PUPPETEER_NAV_TIMEOUT_MS=60000    # page.goto() navigation timeout (default 60s; raise for slow/heavy sites)

# Stale cleanup (results-service):
STALE_RUNNING_MINUTES=15      # running tests older than this → failed
STALE_PENDING_MINUTES=30      # pending tests older than this → failed
```

## Common Commands

```bash
# Start all services — dev (auth disabled, internal ports exposed on localhost)
docker compose up --build

# Start with hot-reload (dev mode) — UI uses Vite with polling watcher (works on Docker Desktop Windows)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build

# Deploy to cloud/production (Caddy HTTPS, auth on, internal ports hidden, resource limits)
# Required env: DOMAIN, API_KEYS, API_KEY, ALLOWED_ORIGIN, GEMINI_API_KEY
# DNS: A records for yourdomain.com, api.yourdomain.com, data.yourdomain.com → server IP
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Start without cache
docker compose build --no-cache
docker compose up

# Start a single service
docker compose up --build api-service

# Scale workers horizontally
docker compose up --scale worker-backend=3

# View logs
docker compose logs -f worker-backend

# Reset DB (WARNING: deletes all data)
docker compose down -v

# Build shared types (required after any change to packages/shared/src/index.ts)
npm run build:shared

# Run unit + integration tests (~430 tests)
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run Playwright E2E tests (requires docker compose up first)
npm run test:e2e

# Run Playwright E2E with interactive UI
npm run test:e2e:ui

# Lint
npm run lint

# PostgreSQL operations
docker compose exec postgres psql -U alt_user -d alt_db -c "SELECT * FROM test_results LIMIT 5;"
docker compose exec postgres psql -U alt_user -d alt_db -c "DROP TABLE test_results;"
```

## Test Suite

**Stack:** Vitest (unit + integration), @testcontainers/postgresql (real DB), Playwright (E2E)
**Config:** `vitest.config.ts` at root; `playwright.config.ts` at root
**Total:** ~430 tests passing across 18+ test files

### Unit Tests
| File | Subject | Tests |
|------|---------|-------|
| `worker-backend/src/__tests__/parser.test.ts` | `parseK6Output`, `aggregateWindow` (per-step), `parseK6Errors` (error categorization) | 25 |
| `results-service/src/__tests__/analyzer.test.ts` | `analyzeResult` thresholds + regression + error breakdown + INP/TBT thresholds | 44 |
| `results-service/src/__tests__/session.test.ts` | `signSession`, `verifySession` (tamper, wrong secret, invalid base64) | 11 |
| `api-service/src/__tests__/options.test.ts` | `buildK6Options`, `replaceK6Options`, `httpOptions` (http2, discard) | 16 |
| `api-service/src/__tests__/index.test.ts` | POST /tests routing, parameterization passthrough, cancel, health, sensitive-field redaction | 23 |
| `results-service/src/__tests__/scheduler.test.ts` | `startScheduler`, `triggerSchedule` (mocked cron) | 12 |
| `ai-service/src/__tests__/generator.test.ts` | `FLOW_PROMPT` ExtractRule rendering, parameterization, `compareDescriptions` | 12 |

### Integration Tests (real PostgreSQL via Testcontainers)
| File | Subject | Tests |
|------|---------|-------|
| `results-service/src/__tests__/api.test.ts` | all REST endpoints + preset regression + script_description in result response | 64 |
| `results-service/src/__tests__/auth.test.ts` | POST /auth/login, /logout, GET /auth/me, session middleware, dev mode | 18 |
| `results-service/src/__tests__/consumer.test.ts` | `handleResult`, webhook firing, baseline ordering | 11 |
| `results-service/src/__tests__/stale.test.ts` | `runStaleCleanup` | 10 |
| `api-service/src/__tests__/scripts.test.ts` | `findExistingScript` + description field + no auto-increment | 9 |

### UI Tests (RTL + jsdom via Vitest)
| File | Subject | Tests |
|------|---------|-------|
| `ui/__tests__/AnalysisPanel.test.tsx` | threshold violations, diff rows, badges | 9 |
| `ui/__tests__/ActiveTests.test.tsx` | count display, link, WS-triggered refetch | 6 |
| `ui/__tests__/AuthContext.test.tsx` | AuthProvider loading/user state, AuthGate redirect/render | 6 |
| `ui/__tests__/home.test.tsx` | form validation, Advanced settings, preset dropdown, INP/TBT SLO inputs | 14 |
| `ui/__tests__/LoginPage.test.tsx` | renders inputs, calls login(), setUser+navigate on success, error, disabled during submit | 5 |
| `ui/__tests__/results.test.tsx` | compare bar, checkboxes, links, Re-run button | 9 |

### Playwright E2E (requires `docker compose up`)
| File | Flow |
|------|------|
| `e2e/happy-path.spec.ts` | fill URL → run → poll → completed status |
| `e2e/cancel.spec.ts` | soak test → cancel button → cancelled status |
| `e2e/compare.spec.ts` | create 2 tests via API → select both → compare view |

## Known Issues / Tech Debt
- Redis is running but not used (planned: caching, rate limiting, pub/sub)
- Gemini rate limit: **20 requests/day** on free tier (`gemini-2.5-flash`); `compareDescriptions()` also consumes quota so each new-description test costs 2 calls. Paid key removes daily cap. Backoff retry (60s/120s/180s) handles 429 automatically.
- Semantic comparison adds ~1-3s latency when description + cached script both exist (Gemini round-trip)
- No rate limiting yet — planned via `@fastify/rate-limit` (Redis back-end when Redis is wired up)
- **recorder-service**: noVNC requires `xvfb` + `x11vnc` + `novnc` APK packages; these add ~60 MB to the Docker image. On Windows/Mac host without Docker the recording browser appears natively (no virtual display needed) when `DISPLAY` is unset.
- **Playwright → Puppeteer script import**: allow users to upload existing Playwright test scripts; an AI agent would translate them to Puppeteer scripts compatible with worker-client. Requires a new conversion endpoint in ai-service (or a dedicated converter-service) and a UI file upload step in the test form.
- **Strict input contract for analyser-service AI prompt** — `aiInsights.ts` currently forwards raw metric objects to the Gemini prompt without enforcing which fields are included or capping array lengths (e.g. `stepMetrics` for large flows, `statusCodes` maps). This risks inflated token usage, inconsistent prompt structure across test types, and weaker model output. Define a typed `AnalysisPromptPayload` interface that explicitly picks only the fields the prompt uses, caps lists (e.g. top-5 step metrics by p95), and normalises units (all times in ms, rates as percentages) before building the prompt string.
