# IMPLEMENTATION.md — AI Load Testing Platform

Current implementation state. Only change log for implementation decisions.

## Completed Phases (21 total)

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Core platform: microservices, RabbitMQ, Gemini AI, k6, Puppeteer, PostgreSQL, UI | ✅ Complete |
| 2 | Reliability: DLQ retries, cancellation, concurrent workers, timeouts, stale cleanup | ✅ Complete |
| 3 | Test coverage: 261 tests (unit, integration, UI, E2E) | ✅ Complete |
| 4 | Multi-step flow testing: FlowStep types, FLOW_PROMPT, per-step metrics | ✅ Complete |
| 5 | UX & Intelligence: countdown timer, auto-extraction, SLO thresholds, semantic reuse | ✅ Complete |
| 6 | UI redesign: Command Center aesthetic, GitHub palette, sidebar, bento grid | ✅ Complete |
| 7 | Security hardening: API key auth, CORS, envVar validation, input validation | ✅ Complete |
| 8 | Observability: status_message, worker health servers, system health aggregation | ✅ Complete |
| 9 | Production readiness: Caddy HTTPS, k6 exit codes, started_at timing fixes | ✅ Complete |
| 10 | Parameterization: ExtractRule types, inline data table, CSV upload, SharedArray | ✅ Complete |
| 11 | Re-run from results list: script_description join, ?rerun= param, pre-fill | ✅ Complete |
| 12 | Non-root containers: all 6 Dockerfiles use node user (UID 1000) | ✅ Complete |
| 13 | Sensitive field protection: Pino redact, safeTestResponse() | ✅ Complete |
| 14 | Flow recorder: CDP capture, noVNC viewer, AI correlation, FlowBuilder integration | ✅ Complete |
| 15 | Bugfixes & polish: re-run steps, p99, RealtimeChart height, status_message clear | ✅ Complete |
| 16 | Custom script upload/paste + Download generated script | ✅ Complete |
| 17 | WebSocket push replaces UI polling (test:status, test:live, tests:changed) | ✅ Complete |
| 18 | Dedicated analyser-service: deterministic analysis + Gemini AI insights | ✅ Complete |
| 19 | External log source links: log_sources table, URL template interpolation | ✅ Complete |
| 20 | Templates → Presets rename: DB migration, API routes, UI | ✅ Complete |
| 21 | Next.js → Vite + React Router migration | ✅ Complete |

## Current Architecture Files

- `api-service/src/index.ts` — 3-way routing + security + safeTestResponse()
- `results-service/src/ws.ts` — WebSocket server (ws noServer mode)
- `results-service/src/db.ts` — createSchema() with all tables + safe migrations
- `worker-backend/src/parser.ts` — parseK6Output, parseK6Errors, aggregateWindow, parseK6GroupMetrics
- `ai-service/src/generator.ts` — generateScript, compareDescriptions, FLOW_PROMPT

## Active Test Suite

- **Unit:** 25 (parser) + 34 (analyzer) + 16 (options) + 23 (api) + 12 (scheduler) + 12 (generator) = 122
- **Integration:** 64 (api) + 11 (consumer) + 10 (stale) + 9 (scripts) = 94
- **UI:** 9 + 6 + 11 + 9 = 35+ tests
- **E2E:** 3 Playwright suites (happy-path, cancel, compare)

## Known Tech Debt

- Redis running but unused (planned: caching, rate limiting)
- Gemini free tier: 20 req/day limit; each new-desc test costs 2 calls
- No rate limiting (planned: @fastify/rate-limit with Redis backend)
- recorder-service Docker image adds ~60 MB (xvfb + x11vnc + novnc)
- analyser-service AI prompt lacks typed payload (may cause inconsistent prompts for large flows)

## Code Analysis (2026-06-04)

Full analysis artifacts: `docs/code-analysis/` (9 module docs + summary.md)

**Real bugs confirmed:**
- B1: ai-service — both Gemini calls use non-existent model `gemini-3.1-flash-lite` (generator.ts:249,271)
- B4: results-service — webhook sends raw secret instead of HMAC (consumer.ts:45)
- B5: results-service — scheduled tests missing X-API-Key header (scheduler.ts)
- B7: worker-client — DLQ exhaustion never calls POST /results/:testId/fail
- B8: worker-client — flow steps[] silently ignored for browser-type tests
- B9: ui — recorder-service routes missing from Caddyfile (production blocker)

**Security gaps confirmed:**
- S1: recorder-service — no auth on any endpoint (port 3007)
- S2: recorder-service — targetUrl passed directly to page.goto() (SSRF)
- S3: api-service — new URL() accepts file://, data://, ftp:// schemes

**Architectural findings:**
- analyzer.ts duplicated verbatim between analyser-service and results-service (belongs in @alt/shared)
- UI re-declares all domain types locally; @alt/shared bypassed for its largest consumer
- AMQP single channel with no reconnect in all 4 queue-connected services
- results-service God Service (8 responsibilities); acceptable at current scale
