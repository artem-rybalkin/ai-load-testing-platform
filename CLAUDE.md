# AI Load Testing Platform — Claude Code Context

## Project Overview
Distributed AI-powered load testing platform. Users describe what they want to test (or build a multi-step flow),
Gemini AI generates k6 or Puppeteer scripts automatically, workers execute them,
and results are stored with performance analysis, regression detection, and per-step breakdown.

## Architecture

```
POST /tests → api-service → checks DB for existing script
                    ↓ (new URL / flow)        ↓ (script cached)
              RabbitMQ: ai-requests      skip AI, go directly
                    ↓
              ai-service (Gemini → k6 or Puppeteer script)
                    ↓
         RabbitMQ: backend-tests OR client-tests
                    ↓                        ↓
          worker-backend (k6)      worker-client (Puppeteer)
                    ↓                        ↓
              RabbitMQ: test-results
                    ↓
          results-service → PostgreSQL
          (saves result + runs performance analysis + fires webhooks)

Cancel path:
POST /tests/:id/cancel → api-service → cancel-fanout exchange → all worker replicas

Scheduled path:
node-cron in results-service → POST /tests (auto-trigger on schedule)
```

## Services & Ports

| Service          | Port  | Description                                       |
|------------------|-------|---------------------------------------------------|
| api-service      | 3000  | Fastify REST API, test routing, CORS              |
| ai-service       | 3001  | Gemini API integration, script generation         |
| worker-backend   | 3002  | k6 runner, metrics parsing, live metrics posting  |
| worker-client    | 3003  | Puppeteer + Lighthouse, Web Vitals collector      |
| results-service  | 3004  | PostgreSQL storage, REST API, analyzer, scheduler |
| ui               | 3006  | Next.js frontend                                  |
| postgres         | 5432  | Main database                                     |
| rabbitmq         | 5672  | Message queue (management UI: 15672)              |
| redis            | 6379  | Running but not yet used                          |

## Tech Stack

- **Runtime:** Node.js 20 + TypeScript
- **API Framework:** Fastify + @fastify/cors
- **Message Queue:** RabbitMQ (amqplib)
- **Database:** PostgreSQL (pg)
- **AI:** Google Gemini API (@google/generative-ai), model: gemini-2.5-flash
- **Load Testing:** k6 (installed in worker-backend Docker image)
- **Browser Testing:** Puppeteer 22 + Lighthouse (headless Chromium in Alpine)
- **Frontend:** Next.js 15 + Tailwind CSS + Recharts
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
├── docker-compose.yml        # production services + infrastructure
├── docker-compose.dev.yml    # dev hot-reload overrides (tsx watch)
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
    │       ├── index.ts      # Fastify app, POST /tests, POST /tests/:id/cancel
    │       ├── queue.ts      # RabbitMQ publisher (ai-requests, backend-tests, cancel-fanout)
    │       ├── scripts.ts    # script reuse + stepsToKey (SHA-256 for flow cache)
    │       ├── options.ts    # buildK6Options (load profiles), replaceK6Options
    │       └── logger.ts     # Pino logger
    │   └── src/__tests__/
    │       ├── index.test.ts # POST /tests, cancel, health (mocked queue + scripts)
    │       ├── options.test.ts # buildK6Options + replaceK6Options unit tests
    │       └── scripts.test.ts # findExistingScript integration (Testcontainers)
    ├── ai-service/           # @alt/ai-service
    │   └── src/
    │       ├── index.ts      # RabbitMQ consumer (ai-requests → backend/client queues)
    │       ├── generator.ts  # Gemini API: BACKEND_PROMPT, CLIENT_PROMPT, FLOW_PROMPT
    │       └── logger.ts
    ├── worker-backend/       # @alt/worker-backend
    │   └── src/
    │       ├── index.ts      # k6 runner, DLQ retry, cancel handler, live metrics posting
    │       ├── parser.ts     # parseK6Output, parseK6StatusCodes, aggregateWindow,
    │       │                 #   parseK6GroupMetrics (per-step group metrics)
    │       └── logger.ts
    │   └── src/__tests__/
    │       └── parser.test.ts # unit tests for all parser functions
    ├── worker-client/        # @alt/worker-client
    │   └── src/
    │       └── index.ts      # Puppeteer sessions, Web Vitals, Lighthouse, DLQ retry
    ├── results-service/      # @alt/results-service
    │   └── src/
    │       ├── index.ts      # startup: initDb → consumer → scheduler → cleanup → app
    │       ├── app.ts        # Fastify REST API (all endpoints)
    │       ├── consumer.ts   # RabbitMQ consumer, handleResult, webhook firing
    │       ├── analyzer.ts   # analyzeResult: thresholds + regression detection
    │       ├── db.ts         # PostgreSQL pool, createSchema (all 6 tables + indexes)
    │       ├── scheduler.ts  # node-cron, startScheduler, triggerSchedule
    │       ├── cleanup.ts    # runStaleCleanup: running>15min / pending>30min → failed
    │       └── logger.ts
    │   └── src/__tests__/
    │       ├── api.test.ts       # all REST endpoints (Testcontainers)
    │       ├── analyzer.test.ts  # analyzeResult unit tests
    │       ├── consumer.test.ts  # handleResult pipeline, webhooks, baseline ordering
    │       ├── stale.test.ts     # runStaleCleanup unit tests (Testcontainers)
    │       └── scheduler.test.ts # startScheduler, triggerSchedule (mocked node-cron)
    └── ui/                   # @alt/ui — Next.js 15 app
        ├── vitest.d.ts       # jest-dom type declarations (/// <reference types>)
        ├── lib/
        │   └── api.ts        # fetch wrappers for all service endpoints + types
        ├── __tests__/
        │   ├── setup.ts      # expect.extend(jest-dom matchers)
        │   ├── ActiveTests.test.tsx
        │   ├── AnalysisPanel.test.tsx
        │   ├── home.test.tsx
        │   └── results.test.tsx
        └── app/
            ├── layout.tsx    # nav + ActiveTests polling header
            ├── page.tsx      # test creation form (backend / browser / flow tabs)
            ├── results/
            │   ├── page.tsx              # all results table (compare checkboxes)
            │   ├── [testId]/page.tsx     # result detail + charts + step breakdown
            │   └── compare/page.tsx      # side-by-side metric diff view
            ├── webhooks/page.tsx         # webhook CRUD management
            ├── schedules/page.tsx        # schedule CRUD + manual trigger
            ├── templates/page.tsx        # template CRUD + load into form
            └── components/
                ├── ActiveTests.tsx       # polling header (active test count)
                ├── BackendChart.tsx      # Recharts bar chart for k6 metrics
                ├── ClientChart.tsx       # radar chart for Web Vitals + Lighthouse
                ├── AnalysisPanel.tsx     # threshold violations + regression diffs
                ├── RealtimeChart.tsx     # live metrics during test execution
                ├── TrendChart.tsx        # p95/LCP trend across runs for same URL
                └── FlowBuilder.tsx       # multi-step flow editor + HAR import
```

## Database Schema

```sql
-- Generated k6/Puppeteer scripts (reused across tests)
-- For flow tests, target_url stores the SHA-256 hash key: 'flow:<hex16>'
CREATE TABLE test_scripts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_url  TEXT NOT NULL,
  test_type   VARCHAR(20) NOT NULL,   -- 'backend' | 'client-side'
  script      TEXT NOT NULL,
  used_count  INTEGER DEFAULT 1,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(target_url, test_type)
);

-- Test results with analysis
CREATE TABLE test_results (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id       UUID NOT NULL UNIQUE,
  type          VARCHAR(20) NOT NULL,   -- 'backend' | 'client-side' | 'flow'
  target_url    TEXT NOT NULL,
  status        VARCHAR(20) NOT NULL,   -- 'pending'|'running'|'completed'|'failed'|'cancelled'
  metrics       JSONB,                  -- BackendMetrics | ClientMetrics (incl. stepMetrics[])
  script_id     UUID REFERENCES test_scripts(id),
  reused_script BOOLEAN DEFAULT FALSE,
  perf_status   VARCHAR(20),            -- 'passed' | 'degraded' | 'failed'
  analysis      JSONB,                  -- diffs, threshold violations, summary
  is_baseline   BOOLEAN DEFAULT FALSE,  -- used as reference for regression comparisons
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
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
  error_rate        FLOAT NOT NULL DEFAULT 0
);
CREATE INDEX live_metrics_test_id_idx ON live_metrics(test_id);

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

-- Reusable test templates (pre-fill form on home page)
CREATE TABLE test_templates (
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
```

## Shared Types (@alt/shared)

```typescript
type TestType   = 'backend' | 'client-side' | 'flow'
type TestStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
type LoadProfile = 'load' | 'spike' | 'capacity' | 'soak'

interface FlowStep {
  name: string
  url: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  body?: string
  headers?: Record<string, string>
  extract?: Record<string, string>  // variable_name → jsonpath field name
}

interface StepMetrics {
  name: string
  avgResponseTime: number
  p95ResponseTime: number
  requestsTotal: number
  requestsFailed: number
}

interface SLOThresholds {
  p95?: number; avg?: number; errorRate?: number
  lcp?: number; fcp?: number; ttfb?: number; cls?: number
}

interface TestRequest {
  id: string; type: TestType; targetUrl: string
  description: string
  options: BackendTestOptions | ClientTestOptions
  thresholds?: SLOThresholds
  steps?: FlowStep[]               // for 'flow' type
  envVars?: Record<string, string> // passed to k6 as --env, never stored in DB
  createdAt: string
}

interface EnrichedTestRequest extends TestRequest {
  generatedScript?: string
  scriptId?: string
  reusedScript?: boolean
  scriptCacheKey?: string          // for flow: 'flow:<sha256hex16>'
}

interface BackendTestOptions { vus, duration, rampUp?, profile?: LoadProfile, peakVus? }
interface ClientTestOptions  { sessions, duration, collectWebVitals }

interface BackendMetrics {
  type: 'backend'
  requestsTotal, requestsFailed, avgResponseTime
  p50ResponseTime, p95ResponseTime, p99ResponseTime, rps
  statusCodes?: Record<string, number>
  stepMetrics?: StepMetrics[]      // only for 'flow' type tests
}

interface LighthouseScore { performance, accessibility, bestPractices, seo } // 0-100
interface ClientMetrics   { type: 'client', lcp, fid, cls, ttfb, fcp, lighthouseScore? }

interface TestResult {
  testId, targetUrl, status, metrics, thresholds?
  startedAt, completedAt?
  perfStatus?: 'passed' | 'degraded' | 'failed'
  analysis?: { perfStatus, diffs[], summary, thresholdViolations[] }
}

interface TestScript { id, targetUrl, testType, script, usedCount, createdAt, updatedAt }
interface LiveMetricPoint { timestamp, vus, rps, avgResponseTime, errorRate }
```

## API Endpoints

### api-service (port 3000)
- `GET  /health` — deep health check (DB + RabbitMQ); 503 if any dep is down
- `POST /tests`  — create test
  - body: `{ type, targetUrl, description, options, thresholds?, steps?, envVars? }`
  - `type` = `'backend'` | `'client-side'` | `'flow'`
  - for flow: `steps[]` required, `targetUrl` defaults to `steps[0].url`
  - `envVars` passed to k6 as `--env KEY=VALUE` flags, **not stored in DB**
- `POST /tests/:testId/cancel` — cancel running/pending test; publishes to cancel-fanout exchange

### results-service (port 3004)
**Results**
- `POST /results/pending`         — create pending record `{ testId, type, targetUrl }`
- `GET  /results`                 — all results (last 50, joined with script text)
- `GET  /results/active`          — tests with status pending/running
- `GET  /results/compare?a=&b=`   — side-by-side diff of two completed results
- `GET  /results/trend?url=`      — chronological metric trend for a URL (p95 or LCP)
- `GET  /results/:testId`         — single result with joined script
- `POST /results/:testId/cancel`  — set status = cancelled in DB
- `POST /results/:testId/live`    — save live metric point (called by worker-backend)
- `GET  /results/:testId/live`    — all live points for a test (chronological)
- `POST /results/:testId/baseline` — mark as baseline for regression comparisons
- `DELETE /results/:testId/baseline` — clear baseline flag
- `GET  /results/:testId/report.pdf` — download pdfkit PDF report

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
- `POST /schedules`          — create `{ name, cron, type, target_url, options, ... }`
- `PUT  /schedules/:id`      — update schedule (including enable/disable)
- `DELETE /schedules/:id`    — delete schedule (stops cron job)
- `POST /schedules/:id/run`  — manual immediate trigger

**Templates**
- `GET    /templates`      — list all templates (by used_count DESC)
- `POST   /templates`      — create `{ name, type, target_url, options, ... }`
- `GET    /templates/:id`  — single template (increments used_count)
- `DELETE /templates/:id`  — delete template

## RabbitMQ Queues & Exchanges

| Queue / Exchange      | Type   | Producer          | Consumer          | Purpose                              |
|-----------------------|--------|-------------------|-------------------|--------------------------------------|
| `ai-requests`         | queue  | api-service       | ai-service        | new tests needing AI script gen      |
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

### Script Reuse & Flow Cache
- **Backend / client-side:** `api-service` queries `test_scripts` by `(target_url, test_type)`.
  - Hit → increments `used_count`, injects new k6 options into cached script, sends directly to worker queue.
  - Miss → sends to `ai-requests` queue; ai-service generates and forwards.
- **Flow tests:** cache key = `stepsToKey(steps)` = `'flow:' + sha256(JSON.stringify(steps)).slice(0,16)`.
  This is stored as `target_url` in `test_scripts` (type = `'backend'`).
  Worker uses `scriptCacheKey` from `EnrichedTestRequest` when inserting a newly generated flow script.

### k6 Metrics Parsing (worker-backend/parser.ts)
- `parseK6Output(output)` — regex over k6 text output → `BackendMetrics`
  - `http_reqs[^:]*:\s*(\d+)\s+[\d.]+\/s` → requestsTotal
  - `http_req_failed[^:]*:\s*([\d.]+)%` → error rate
  - `http_req_duration[^\n]*\bavg=([\d.]+)(ms|s|µs)?` → avgResponseTime
  - `http_req_duration[^\n]*\bp\(50\)=...` / `p\(95\)=...` / `p\(99\)=...`
  - Unit normalisation: `ms` (identity), `s` (×1000), `µs` (÷1000)
- `parseK6StatusCodes(jsonContent)` — counts `http_reqs` points by `data.tags.status`
- `aggregateWindow(lines)` — aggregates 5-second k6 JSON windows → `LiveMetricPoint`
- `parseK6GroupMetrics(jsonContent)` — groups `http_req_duration` / `http_reqs` / `http_req_failed`
  by `data.tags.group` (strip leading `::`) → `StepMetrics[]`

### Flow Test Execution (worker-backend)
- AI generates k6 script using `FLOW_PROMPT` with `group('Step N: name', fn)` per step
- `runK6Test(testId, script, envVars?)` passes `--env KEY=VALUE` args to k6 process
- After k6 exits, `parseK6GroupMetrics(jsonContent)` extracts per-step metrics
- `stepMetrics[]` is attached to `BackendMetrics` and stored in `metrics` JSONB column
- UI result page shows `StepMetricsTable` when `metrics.stepMetrics.length > 0`

### Performance Analyzer (results-service/analyzer.ts)
Default thresholds: p95 < 1000ms, avg < 500ms, error rate < 1%, LCP < 2500ms,
FCP < 1800ms, TTFB < 800ms, CLS < 0.1, Lighthouse performance ≥ 50.
- Per-test SLO overrides via `thresholds` field in `TestRequest`
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

### Lighthouse Integration (worker-client)
- Runs after Puppeteer sessions, reuses the same Chrome instance via remote debugging port
- Collects performance, accessibility, best-practices, SEO scores (0–100)
- `performance < 50` → analyzer treats as threshold violation → `perf_status = 'failed'`

### UI Polling Strategy
- `ActiveTests` header: polls `/results/active` every 3s while component is mounted
- Result detail page: polls `/results/:testId` every 2s until `completed` / `failed` / `cancelled`
- Live metrics: polls `/results/:testId/live` every 3s while `status === 'running'`
- Results list page: polls `/results` every 5s

### Load Profile Stages (api-service/options.ts)
`buildK6Options(opts)` generates k6 JSON options based on `profile`:
- `load` (default): ramp 0→vus over 30s, hold for duration, ramp down
- `spike`: warm-up → pre-spike → spike to peakVus over 10s → hold → ramp down
- `capacity`: linear ramp from 0 to peakVus over duration (find the breaking point)
- `soak`: ramp to vus, hold for duration, ramp down (detect memory leaks)
`peakVus` defaults to `vus * 10` when not specified.

### Script Dry-Run Validation
Before executing any k6 script, `validateScript(scriptPath)` spawns `k6 inspect`.
On non-zero exit the script is rejected; the message is nacked and retried / DLQ'd.

### Baseline Management
`is_baseline` column on `test_results`. When a baseline exists for a URL:
- `consumer.ts` queries `ORDER BY is_baseline DESC, created_at DESC`
- Regression diffs are computed against the baseline, not the previous run
- UI shows amber "baseline" badge; Set/Clear buttons on result detail page

## Environment Variables

```bash
# .env (root, never commit)
GEMINI_API_KEY=your_key_here

# Set automatically by docker-compose:
RABBITMQ_URL=amqp://alt_user:alt_password@rabbitmq:5672
DATABASE_URL=postgresql://alt_user:alt_password@postgres:5432/alt_db
RESULTS_URL=http://results-service:3004
NEXT_PUBLIC_API_URL=http://localhost:3000
NEXT_PUBLIC_RESULTS_URL=http://localhost:3004

# Worker tuning (optional, have defaults):
WORKER_CONCURRENCY=1          # worker-backend (default 1)
# WORKER_CONCURRENCY=2        # worker-client  (default 2)
# WORKER_CONCURRENCY=3        # ai-service     (default 3)
K6_MAX_DURATION_MS=600000     # 10 minutes hard limit per k6 test
PUPPETEER_MAX_DURATION_MS=300000  # 5 minutes hard limit per Puppeteer test

# Stale cleanup (results-service):
STALE_RUNNING_MINUTES=15      # running tests older than this → failed
STALE_PENDING_MINUTES=30      # pending tests older than this → failed
```

## Common Commands

```bash
# Start all services
docker compose up --build

# Start with hot-reload (dev mode)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build

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

# Run unit + integration tests (191 tests)
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
**Total:** 191 tests passing across 13 test files

### Unit Tests
| File | Subject | Tests |
|------|---------|-------|
| `worker-backend/src/__tests__/parser.test.ts` | `parseK6Output`, `aggregateWindow`, `parseK6StatusCodes` | 15 |
| `results-service/src/__tests__/analyzer.test.ts` | `analyzeResult` thresholds + regression | 14 |
| `api-service/src/__tests__/options.test.ts` | `buildK6Options`, `replaceK6Options` | 12 |
| `api-service/src/__tests__/index.test.ts` | POST /tests, cancel, health (mocked queue) | 10 |
| `results-service/src/__tests__/scheduler.test.ts` | `startScheduler`, `triggerSchedule` (mocked cron) | 12 |

### Integration Tests (real PostgreSQL via Testcontainers)
| File | Subject | Tests |
|------|---------|-------|
| `results-service/src/__tests__/api.test.ts` | all REST endpoints | 38 |
| `results-service/src/__tests__/consumer.test.ts` | `handleResult`, webhook firing, baseline ordering | 11 |
| `results-service/src/__tests__/stale.test.ts` | `runStaleCleanup` | 10 |
| `api-service/src/__tests__/scripts.test.ts` | `findExistingScript` + script injection | 7 |

### UI Tests (RTL + jsdom via Vitest)
| File | Subject | Tests |
|------|---------|-------|
| `ui/__tests__/AnalysisPanel.test.tsx` | threshold violations, diff rows, badges | 9 |
| `ui/__tests__/ActiveTests.test.tsx` | count display, link, polling | 6 |
| `ui/__tests__/home.test.tsx` | form validation, template dropdown | 8 |
| `ui/__tests__/results.test.tsx` | compare bar, checkboxes, links | 6 |

### Playwright E2E (requires `docker compose up`)
| File | Flow |
|------|------|
| `e2e/happy-path.spec.ts` | fill URL → run → poll → completed status |
| `e2e/cancel.spec.ts` | soak test → cancel button → cancelled status |
| `e2e/compare.spec.ts` | create 2 tests via API → select both → compare view |

## Current Status

All phases complete:

### Phase 1 — Core Platform
- ✅ Microservices architecture with RabbitMQ message routing
- ✅ Gemini AI script generation (backend, client-side, flow prompts)
- ✅ k6 backend testing with full metrics parsing (avg, p50, p95, p99, rps, error rate, status codes)
- ✅ Puppeteer client-side testing with Web Vitals (LCP, FID, CLS, TTFB, FCP)
- ✅ Lighthouse integration (performance / accessibility / best-practices / SEO scores)
- ✅ Results storage in PostgreSQL with performance analyzer
- ✅ Script reuse: cached scripts injected with fresh k6 options per run
- ✅ Load profiles: load / spike / capacity / soak (UI selector + prompt engineering)
- ✅ Next.js UI: test form, results dashboard, charts, live metrics

### Phase 2 — Reliability & Features
- ✅ Dead-letter queues + 3-retry policy (`x-retry-count` header across all consumers)
- ✅ Test cancellation (cancel-fanout exchange, all worker replicas)
- ✅ Concurrent workers (`WORKER_CONCURRENCY` env var, default per service)
- ✅ Execution timeouts (k6: 10 min, Puppeteer: 5 min; SIGTERM + SIGKILL)
- ✅ Stale test cleanup (every 60s; configurable running/pending thresholds)
- ✅ Baseline management (regression vs baseline instead of previous run)
- ✅ Configurable SLO thresholds per test request
- ✅ p50 + status code breakdown in backend metrics
- ✅ Script dry-run validation (`k6 inspect` before execution)
- ✅ Manual run comparison (`/results/compare?a=&b=`)
- ✅ Trend chart per URL (p95 / LCP over time)
- ✅ Webhooks (fire on failed/degraded; optional HMAC secret)
- ✅ Deep health checks (503 when DB or RabbitMQ is down)
- ✅ Docker restart policy (`unless-stopped` on all services)
- ✅ PostgreSQL indexes (status, url+type+status, test_id on live_metrics)
- ✅ Structured Pino logging (JSON, testId in every line)
- ✅ Horizontal worker scaling + cancel fanout exchange
- ✅ Scheduled tests (node-cron, CRUD API + manual trigger)
- ✅ Test template library (save/load from home page)
- ✅ PDF report generation (pdfkit, Download PDF button)
- ✅ Dev hot-reload (docker-compose.dev.yml + tsx watch)
- ✅ Real-time charts during k6 execution (5s live metric windows)

### Phase 3 — Test Coverage (191 tests)
- ✅ Unit tests: parser, analyzer, options builder, api-service handler
- ✅ Integration tests: all REST endpoints, consumer pipeline, stale cleanup, scheduler
- ✅ UI tests: RTL component + page tests (home form, results list, analysis panel, active tests)
- ✅ Playwright E2E: happy path, cancel flow, compare flow

### Phase 4 — Multi-step Flow Testing
- ✅ `FlowStep` / `StepMetrics` types in `@alt/shared`; `'flow'` added to `TestType`
- ✅ `FLOW_PROMPT` in ai-service: k6 script with `group()` per step + variable chaining
- ✅ Flow cache key: SHA-256 hash of steps JSON (`flow:<hex16>`) in `test_scripts`
- ✅ `POST /tests` accepts `steps[]` + `envVars` (credentials passed as k6 `--env`, never stored)
- ✅ `parseK6GroupMetrics` in worker-backend: per-step avg/p95/requests from k6 JSON group tags
- ✅ `FlowBuilder` UI: add/remove/reorder steps, method+URL+body+extract editor, env vars panel
- ✅ HAR import: parse Chrome DevTools HAR → auto-generate `steps[]`, pre-fill builder
- ✅ Result detail page shows `StepMetricsTable` when step metrics are present

## Known Issues / Tech Debt
- Redis is running but not used (planned: caching, rate limiting, pub/sub)
- k6 threshold violations cause non-zero exit code — handled by catching the exec error and parsing output anyway
- Gemini rate limit: 5 RPM on free tier — 60s×attempt backoff retry implemented
- UI uses polling instead of WebSockets (planned improvement)
- `is_baseline` column added via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (safe migration, not in original CREATE TABLE)
- Flow `envVars` are stored in the RabbitMQ message while the test is in-flight — do not log them
