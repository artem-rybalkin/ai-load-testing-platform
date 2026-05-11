# AI Load Testing Platform — Claude Code Context

## Project Overview
Distributed AI-powered load testing platform. Users describe what they want to test,
Gemini AI generates k6 or Puppeteer scripts automatically, workers execute them,
and results are stored with performance analysis and regression detection.

## Architecture

```
POST /tests → api-service → checks DB for existing script
                    ↓ (new URL)              ↓ (script exists)
              RabbitMQ: ai-requests    skip AI, go directly
                    ↓
              ai-service (Gemini generates k6 or Puppeteer script)
                    ↓
         RabbitMQ: backend-tests OR client-tests
                    ↓                        ↓
          worker-backend (k6)      worker-client (Puppeteer)
                    ↓                        ↓
              RabbitMQ: test-results
                    ↓
          results-service → PostgreSQL
          (saves result + runs performance analysis)
```

## Services & Ports

| Service          | Port | Description                              |
|------------------|------|------------------------------------------|
| api-service      | 3000 | Fastify REST API, test routing, CORS     |
| ai-service       | 3001 | Gemini API integration, script generation|
| worker-backend   | 3002 | k6 load testing, metrics parsing         |
| worker-client    | 3003 | Puppeteer, headless Chrome, Web Vitals   |
| results-service  | 3004 | PostgreSQL storage, REST API, analyzer   |
| ui               | 3006 | Next.js frontend                         |
| postgres         | 5432 | Main database                            |
| rabbitmq         | 5672 | Message queue (management UI: 15672)     |
| redis            | 6379 | Installed but not yet used               |

## Tech Stack

- **Runtime:** Node.js 20 + TypeScript
- **API Framework:** Fastify + @fastify/cors
- **Message Queue:** RabbitMQ (amqplib)
- **Database:** PostgreSQL (pg)
- **AI:** Google Gemini API (@google/generative-ai), model: gemini-2.5-flash
- **Load Testing:** k6 (installed in worker-backend Docker image)
- **Browser Testing:** Puppeteer 22 (headless Chromium in Alpine)
- **Frontend:** Next.js 15 + Tailwind CSS + Recharts
- **Containerization:** Docker + docker-compose
- **Monorepo:** npm workspaces

## Repository Structure

```
ai-load-testing-platform/
├── package.json              # root — npm workspaces config
├── tsconfig.json             # base TypeScript config
├── docker-compose.yml        # all services + infrastructure
├── .env                      # GEMINI_API_KEY (never commit)
├── CLAUDE.md                 # this file
├── packages/
│   └── shared/               # @alt/shared — shared types
│       └── src/index.ts
└── services/
    ├── api-service/          # @alt/api-service
    │   └── src/
    │       ├── index.ts      # Fastify app, POST /tests
    │       ├── queue.ts      # RabbitMQ publisher
    │       └── scripts.ts    # script reuse logic (PostgreSQL)
    ├── ai-service/           # @alt/ai-service
    │   └── src/
    │       ├── index.ts      # RabbitMQ consumer + Fastify health
    │       └── generator.ts  # Gemini API, prompt engineering
    ├── worker-backend/       # @alt/worker-backend
    │   └── src/
    │       └── index.ts      # k6 runner, metrics parser, result publisher
    ├── worker-client/        # @alt/worker-client
    │   └── src/
    │       └── index.ts      # Puppeteer, Web Vitals collector
    ├── results-service/      # @alt/results-service
    │   └── src/
    │       ├── index.ts      # Fastify REST API
    │       ├── consumer.ts   # RabbitMQ consumer, saves results
    │       ├── analyzer.ts   # performance analysis, regression detection
    │       └── db.ts         # PostgreSQL pool, schema init
    └── ui/                   # @alt/ui — Next.js app
        ├── app/
        │   ├── layout.tsx    # nav + ActiveTests component
        │   ├── page.tsx      # test creation form
        │   └── results/
        │       ├── page.tsx              # all results table
        │       └── [testId]/page.tsx     # single result + charts
        ├── app/components/
        │   ├── ActiveTests.tsx    # polling header bar
        │   ├── BackendChart.tsx   # Recharts for k6 metrics
        │   ├── ClientChart.tsx    # Radar chart for Web Vitals
        │   └── AnalysisPanel.tsx  # regression analysis display
        └── lib/
            └── api.ts             # fetch wrappers for all endpoints
```

## Database Schema

```sql
-- Generated k6/Puppeteer scripts (reused across tests)
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
  type          VARCHAR(20) NOT NULL,
  target_url    TEXT,
  status        VARCHAR(20) NOT NULL,  -- 'pending' | 'running' | 'completed' | 'failed'
  metrics       JSONB,
  script_id     UUID REFERENCES test_scripts(id),
  reused_script BOOLEAN DEFAULT FALSE,
  perf_status   VARCHAR(20),           -- 'passed' | 'degraded' | 'failed'
  analysis      JSONB,                 -- diffs, threshold violations, summary
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

## Shared Types (@alt/shared)

```typescript
type TestType = 'backend' | 'client-side'
type TestStatus = 'pending' | 'running' | 'completed' | 'failed'

interface TestRequest { id, type, targetUrl, description, options, createdAt }
interface EnrichedTestRequest extends TestRequest {
  generatedScript?, scriptId?, reusedScript?
}
interface BackendTestOptions { vus, duration, rampUp? }
interface ClientTestOptions  { sessions, duration, collectWebVitals }
interface BackendMetrics { type:'backend', requestsTotal, requestsFailed,
                           avgResponseTime, p95ResponseTime, p99ResponseTime, rps }
interface ClientMetrics  { type:'client', lcp, fid, cls, ttfb, fcp }
interface TestResult     { testId, targetUrl, status, metrics, startedAt,
                           completedAt?, perfStatus?, analysis? }
interface TestScript     { id, targetUrl, testType, script, usedCount, ... }
```

## API Endpoints

### api-service (port 3000)
- `GET  /health` — health check
- `POST /tests`  — create test, body: `{ type, targetUrl, description, options }`

### results-service (port 3004)
- `GET  /health`
- `POST /results/pending`     — create pending record `{ testId, type, targetUrl }`
- `GET  /results/active`      — tests with status pending/running
- `GET  /results`             — all results (last 50, with script)
- `GET  /results/:testId`     — single result
- `GET  /scripts`             — all saved scripts (by used_count DESC)
- `GET  /scripts/:id`         — single script
- `DELETE /scripts/:id`       — delete script (force regeneration)

## RabbitMQ Queues

| Queue          | Producer       | Consumer         | Purpose                    |
|----------------|----------------|------------------|----------------------------|
| ai-requests    | api-service    | ai-service       | new tests needing AI script|
| backend-tests  | ai-service     | worker-backend   | k6 tests to run            |
| client-tests   | ai-service     | worker-client    | Puppeteer tests to run     |
| test-results   | worker-backend | results-service  | completed test results     |
|                | worker-client  |                  |                            |

## Key Implementation Details

### Script Reuse Flow
api-service checks PostgreSQL for existing script with same `(target_url, test_type)`.
If found → increments `used_count`, sends directly to worker queue (skips ai-service).
If not found → sends to `ai-requests` queue.

### k6 Metrics Parsing (worker-backend)
k6 outputs text format. Key regex patterns:
- `http_reqs[^:]*:\s*(\d+)\s+[\d.]+\/s` → requestsTotal
- `http_req_failed[^:]*:\s*([\d.]+)%` → error rate
- `http_req_duration[^\n]*\bavg=([\d.]+)(ms|s|µs)?` → avgResponseTime
- `http_req_duration[^\n]*\bp\(95\)=([\d.]+)(ms|s|µs)?` → p95

### Performance Analyzer (results-service/analyzer.ts)
Thresholds: p95 < 1000ms, avg < 500ms, error rate < 1%, LCP < 2500ms, CLS < 0.1
Compares current vs previous test for same URL.
Status: `passed` | `degraded` (>20% worse) | `failed` (threshold violation)

### Puppeteer (worker-client)
Uses system Chromium from Alpine (PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true).
Collects Web Vitals via PerformanceObserver API in page context.
Runs N parallel sessions, averages metrics.

### UI Polling Strategy
- ActiveTests component: polls `/results/active` every 3s
- Result page: polls `/results/:testId` every 2s until status = completed/failed
- Results list: polls every 5s

## Environment Variables

```bash
# .env (root)
GEMINI_API_KEY=your_key_here

# docker-compose sets these automatically:
RABBITMQ_URL=amqp://alt_user:alt_password@rabbitmq:5672
DATABASE_URL=postgresql://alt_user:alt_password@postgres:5432/alt_db
RESULTS_URL=http://results-service:3004
NEXT_PUBLIC_API_URL=http://localhost:3000
NEXT_PUBLIC_RESULTS_URL=http://localhost:3004
```

## Common Commands

```bash
# Start everything
docker compose up --build

# Start specific service
docker compose up --build api-service

# Rebuild without cache
docker compose build --no-cache api-service

# View logs
docker compose logs -f worker-backend

# Reset DB (WARNING: deletes all data)
docker compose down -v

# Build shared types (required after changes to packages/shared)
npm run build:shared

# Drop and recreate table
docker compose exec postgres psql -U alt_user -d alt_db -c "DROP TABLE test_results;"

# Run lint
npm run lint
```

## Current Status & Next Tasks

### Completed (Phase 1 + 1б partial)
- ✅ Full microservices architecture with RabbitMQ
- ✅ Gemini AI script generation + script reuse
- ✅ Real k6 backend testing with metrics parsing
- ✅ Puppeteer client-side testing with Web Vitals
- ✅ Results storage in PostgreSQL
- ✅ Performance analyzer (thresholds + regression detection)
- ✅ Next.js UI with test form, results dashboard, charts
- ✅ Active tests tracking in header

### Next Up (Phase 1б)
- `u7` — Real-time charts during backend test (VUs, response time, errors)
  → Need: k6 streaming metrics output + polling endpoint in results-service
- `u8` — Lighthouse integration for client tests
  → Need: add lighthouse npm package to worker-client, run after Puppeteer
- `r1/r2` — PDF report generation and storage
- Phase 2 — Cloud deployment (compare AWS vs GCP vs Azure first)

## Known Issues / Tech Debt
- Redis is running but not used (planned for future: caching, rate limiting, pub/sub)
- k6 threshold violations cause non-zero exit code — handled by catching exec error
- Gemini rate limit: 5 RPM on free tier — retry logic with 60s backoff implemented
- UI uses polling instead of WebSockets (planned improvement)
- `perf_status` column added via ALTER TABLE (not in original CREATE TABLE)
