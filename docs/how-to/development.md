# Development Guide

This guide covers hot-reload development, the test suite, repo structure, and how to add new services.

---

## Hot-reload dev mode

The dev overlay mounts all source files into containers and uses `tsx watch` for instant TypeScript restarts:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

After startup, editing any `.ts` file in a service restarts that service in ~1–2 seconds. Changes to `packages/shared/src/index.ts` are picked up by a `shared-watcher` container that rebuilds `@alt/shared`, triggering all dependent services to restart.

**Platform notes:**
- The UI (Vite + React Router) runs its own dev server rather than `tsx watch`. Vite's file watcher uses polling (`server.watch.usePolling: true`, 1s interval, configured in `services/ui/vite.config.ts`) because WSL2/Docker Desktop bind mounts don't reliably deliver native filesystem events — this is what makes HMR trigger reliably on Windows, at the cost of up to a 1s detection delay
- The dev compose adds an 8s startup delay (`sleep 8 && npm run dev`) before launching Vite, to let the WSL2 bind mount warm up before the initial file scan; `restart: on-failure` recovers automatically if Vite still crashes on startup
- Vite listens on port 3006 and proxies `/api`, `/data`, `/viewer`, and `/recordings` to api-service, results-service, and recorder-service respectively (by Docker service name), so the browser talks to a single origin and cookies stay same-origin
- A custom `resilient-watcher` Vite plugin catches `EIO`/`ENOENT` errors that WSL2 bind mounts intermittently raise mid-scan (both synchronously on the `FSWatcher` and asynchronously via `uncaughtException`), preventing the dev server from crashing on transient scan errors
- The `recorder-service` dev entrypoint (`docker-entrypoint-dev.sh`) starts Xvfb before `tsx watch` — do **not** add a `command:` override for it in your local dev file

---

## Repository structure

```
ai-load-testing-platform/
├── package.json          # npm workspaces root
├── tsconfig.json         # base TypeScript config (all services extend this)
├── vitest.config.ts      # Vitest root config
├── playwright.config.ts  # Playwright E2E config
├── docker-compose.yml    # production-ready base config
├── docker-compose.dev.yml# dev hot-reload overlay
├── docker-compose.prod.yml # production overlay (Caddy, no internal ports)
├── Caddyfile             # Caddy reverse proxy config
├── .env                  # local env vars (never commit)
├── docs/                 # this documentation
├── e2e/                  # Playwright E2E specs
├── packages/
│   └── shared/           # @alt/shared — shared TypeScript types
│       └── src/index.ts  # single source of truth for all interfaces
└── services/
    ├── api-service/      # @alt/api-service
    ├── ai-service/       # @alt/ai-service
    ├── worker-backend/   # @alt/worker-backend
    ├── worker-client/    # @alt/worker-client
    ├── results-service/  # @alt/results-service
    ├── recorder-service/ # @alt/recorder-service
    └── ui/               # @alt/ui (Vite + React Router)
```

Each service has the same structure:
```
services/<name>/
├── src/
│   ├── index.ts          # entry point
│   └── __tests__/        # test files
├── Dockerfile            # production image
├── Dockerfile.dev        # dev image (tsx, no build step)
├── package.json
└── tsconfig.json         # extends ../../tsconfig.json
```

---

## Shared types

`packages/shared/src/index.ts` defines all interfaces shared between services. After any edit:

```bash
npm run build:shared
```

Or let `shared-watcher` do it automatically in dev mode.

All services import from `@alt/shared`:
```typescript
import { TestRequest, TestResult, FlowStep } from '@alt/shared';
```

---

## Running the test suite

### All tests (unit + integration)

```bash
npm test
```

~1359 tests across 64 files. Unit tests run in ~30–60 seconds; integration tests (Testcontainers) take 3–5 minutes.

### Watch mode

```bash
npm run test:watch
```

### Coverage report

```bash
npm run test:coverage
```

### Run a specific file

```bash
npx vitest run services/results-service/src/__tests__/analyzer.test.ts
```

### Test categories

| Category | Files | What's tested |
|----------|-------|---------------|
| Unit | `parser.test.ts`, `analyzer.test.ts`, `options.test.ts`, `generator.test.ts` | Pure functions — no external deps |
| Integration | `api.test.ts`, `consumer.test.ts`, `scripts.test.ts`, `stale.test.ts`, `scheduler.test.ts` | Real PostgreSQL via Testcontainers |
| UI | `home.test.tsx`, `results.test.tsx`, `AnalysisPanel.test.tsx`, `ActiveTests.test.tsx` | React components with RTL + jsdom |
| E2E | `e2e/happy-path.spec.ts`, `cancel.spec.ts`, `compare.spec.ts` | Full stack via Playwright |

### Playwright E2E tests

E2E tests require all services running:

```bash
# Terminal 1 — start platform
docker compose up --build

# Terminal 2 — run E2E
npm run test:e2e

# With interactive UI
npm run test:e2e:ui
```

---

## Writing tests

### Unit test example (Vitest)

```typescript
import { describe, it, expect } from 'vitest';
import { analyzeResult } from '../analyzer';

describe('analyzeResult', () => {
  it('marks as failed when p95 exceeds threshold', () => {
    const metrics = { type: 'backend', p95ResponseTime: 1500, /* ... */ };
    const result = analyzeResult(metrics, null, { p95: 1000 });
    expect(result.perfStatus).toBe('failed');
    expect(result.thresholdViolations).toContain('p95 1500ms > 1000ms');
  });
});
```

### Integration test example (Testcontainers)

```typescript
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { createSchema } from '../db';

let pool: Pool;

beforeAll(async () => {
  const container = await new PostgreSqlContainer().start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await createSchema(pool);
});
```

### UI test example (RTL)

```typescript
import { render, screen } from '@testing-library/react';
import { AnalysisPanel } from '../AnalysisPanel';

it('shows threshold violations', () => {
  const analysis = {
    perfStatus: 'failed',
    thresholdViolations: ['p95 1200ms > 1000ms'],
    diffs: [], summary: 'Test failed'
  };
  render(<AnalysisPanel analysis={analysis} />);
  expect(screen.getByText('p95 1200ms > 1000ms')).toBeInTheDocument();
});
```

---

## Database migrations

The schema is managed in `services/results-service/src/db.ts` in the `createSchema()` function. It uses `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for safe idempotent migrations.

After adding a column:
1. Add it to `createSchema()` with `IF NOT EXISTS`
2. Update the relevant SQL queries in `consumer.ts` or `app.ts`
3. Update the corresponding TypeScript interfaces in `@alt/shared`

The schema is applied on results-service startup, so changes deploy automatically.

---

## Adding a new service

1. **Create the service directory:**
   ```bash
   mkdir -p services/my-service/src/__tests__
   ```

2. **`package.json`** — follow the pattern from an existing service:
   ```json
   {
     "name": "@alt/my-service",
     "version": "1.0.0",
     "main": "dist/index.js",
     "scripts": {
       "dev": "tsx watch src/index.ts",
       "build": "tsc",
       "start": "node dist/index.js"
     },
     "dependencies": {
       "fastify": "^4",
       "@fastify/cors": "^8",
       "@alt/shared": "*"
     }
   }
   ```

3. **`tsconfig.json`:**
   ```json
   { "extends": "../../tsconfig.json", "compilerOptions": { "outDir": "dist" } }
   ```

4. **`src/logger.ts`** — copy from any existing service (Pino, redact sensitive fields):
   ```typescript
   import pino from 'pino';
   export const log = pino({
     name: 'my-service',
     level: process.env.LOG_LEVEL || 'info',
     redact: { paths: ['envVars', 'testData', 'csvData'], censor: '[REDACTED]' },
   });
   ```

5. **`src/index.ts`** — Fastify server with `/health` endpoint

6. **`Dockerfile`** — follow the non-root pattern:
   ```dockerfile
   FROM node:20-alpine
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci --ignore-scripts && npm rebuild
   COPY . .
   RUN npm run build
   RUN chown -R node:node /app
   USER node
   EXPOSE 3008
   CMD ["node", "dist/index.js"]
   ```

7. **`Dockerfile.dev`** — simpler, no build step

8. **`docker-compose.yml`** — add the service block

9. **Register in npm workspaces** — add to root `package.json`:
   ```json
   { "workspaces": ["packages/*", "services/*"] }
   ```

10. **Add to `GET /system/health`** in `results-service/src/app.ts`

11. Run `npm install` at the root to link the workspace

---

## Linting

```bash
npm run lint
```

ESLint with TypeScript rules. Fix automatically:

```bash
npm run lint -- --fix
```

---

## Useful commands

```bash
# Start a single service (with all deps)
docker compose up --build results-service

# Tail logs for a service
docker compose logs -f worker-backend

# Open a shell in a container
docker compose exec api-service sh

# psql into the database
docker compose exec postgres psql -U alt_user -d alt_db

# Reset the database (WARNING: destroys all data)
docker compose down -v && docker compose up --build

# Rebuild only the shared package
npm run build:shared

# Install a new dependency in a service
npm install --workspace=services/api-service some-package
```

---

## Environment variables in tests

Vitest is configured with placeholder env vars so tests don't fail on missing `DATABASE_URL` or `RABBITMQ_URL`:

```typescript
// vitest.config.ts
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost/test';
process.env.RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost';
```

Integration tests using Testcontainers override these with the real container URLs.
