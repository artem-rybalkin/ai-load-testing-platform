# MEMORY.md — AI Load Testing Platform

Root causes of errors, actions tried, and generalized preventive rules.

## Preventive Rules

### P1: Next.js → Vite Migration (Phase 21)
**Root cause:** Docker Desktop Windows filesystem latency (~574ms/op) caused Next.js Turbopack lazy chunk compilation to exceed browser connection timeout on first load.
**Rule:** On Windows + Docker Desktop: prefer Vite over Next.js. Next.js lazy compilation is incompatible with Windows filesystem FUSE latency at dev speeds.

### P2: Fastify Version Compatibility
**Root cause:** @fastify/websocket requires Fastify ^4.x; project uses Fastify v5. Installing it breaks startup.
**Rule:** Use `ws` package with `noServer: true` attached to `fastify.server` for WebSocket on Fastify v5. Never install @fastify/websocket.

### P3: Docker Compose Bake on Windows
**Root cause:** COMPOSE_BAKE=true has a Windows path bug — prepends project root to `dockerfile:` field twice, producing an invalid doubled absolute path.
**Rule:** Never enable COMPOSE_BAKE on Windows. Comment it out in .env. Parallel builds work without it.

### P4: snake_case vs camelCase in API endpoints
**Root cause:** results-service POST /schedules and POST /presets expected snake_case `target_url` in body but UI sent camelCase `targetUrl` — silently dropped, causing 400 errors.
**Rule:** All results-service body fields must use snake_case (matching DB column names). Verify with explicit integration tests that test full round-trip.

### P5: Worker DLQ and failed status
**Root cause:** Before Phase 8, ai-service DLQ exhaustion didn't mark the test as failed — tests hung as 'pending' for 30 minutes until stale cleanup.
**Rule:** Always mark test as failed immediately on DLQ exhaustion (POST /results/:testId/fail). Don't rely on stale cleanup for user-visible failures.

### P6: @testcontainers/postgresql startup
**Root cause:** Testcontainers requires Docker running and DOCKER_HOST properly set. Tests silently hang if Docker is unavailable.
**Rule:** Integration tests using Testcontainers require Docker Desktop running. Document this in test commands.

### P7: Pino redact paths
**Root cause:** Without Pino redact, accidental `log.info(test, 'msg')` logs the full test object including envVars (credentials) and csvData.
**Rule:** All service loggers MUST configure `redact: { paths: ['envVars', 'testData', 'csvData'], censor: '[REDACTED]' }` as defense-in-depth.

### P8: started_at timing
**Root cause:** Originally started_at was set when worker received the message, not when k6 actually started executing. Script validation (~2s) was included in countdown, making the timer inaccurate.
**Rule:** Set started_at only when the subprocess (k6/puppeteer) actually spawns, not on message receipt.

## What Worked Well

- **Testcontainers for integration tests** — Real PostgreSQL vs mocks caught the snake_case bug (P4) and many migration issues
- **Pino structured logging** — Made debugging cross-service issues much faster (testId in every log line)
- **WebSocket push vs polling** — Eliminated choppy 2-5s refresh cycles; test:live events make charts smooth
- **analyser-service 12s timeout with local fallback** — Ensures results are never blocked waiting for AI
