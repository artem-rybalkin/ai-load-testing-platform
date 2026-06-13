# IMPLEMENTATION.md — AI Load Testing Platform

Current implementation state. Only change log for implementation decisions.

## Completed Phases (26 total)

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
| 22 | Code-analysis hardening: all confirmed bugs fixed; analyzeResult in @alt/shared; schema_migrations table; AMQP reconnect; HealthContext; SSRF+auth on recorder-service; AnalysisPromptPayload; GEMINI_MODEL env var | ✅ Complete |
| 23 | AI features (AI-1 → AI-14): 9 new Gemini endpoints + 5 pure helpers; 51 new tests; exec.vu.abort fix; CRLF fix; recorder viewport 1280×800 | ✅ Complete |
| 24 | Org/Team/RBAC foundation: migration #6 (`users`, `team_members`, `sessions`); password-based register/login (bcryptjs); DB-backed revocable opaque-token sessions; admin/member/viewer roles; `/auth/register`, `/auth/switch-team`, `/teams`, `/teams/:id/members*` endpoints; RBAC middleware; UI register/login forms, team-switcher, team management page, viewer-role action gating; 73 new results-service tests + 14 new/updated UI tests | ✅ Complete |
| 25 | Quota management + Org layer / per-team API keys (25a+25b): fixed api-service session bug (`getApiSession` replaces stale HMAC `verifySession`); migration #7 (`team_quotas`, `gemini_usage`) + migration #8 (`organizations`, `org_members`, `projects.org_id`, `team_api_keys`); `TeamQuota`/`TeamUsage`/`OrgRole`/`OrgMembership` shared types; quota enforcement (429s) on `POST /tests`, `POST /schedules`, `/ai/*` endpoints; `GET/PUT /teams/:id/quotas`; `/orgs*` endpoints (CRUD, members, teams-in-org) with owner/admin RBAC + last-owner protection; `/teams/:id/api-keys*` (generate/list/revoke, sha256-hashed); both services' auth middleware accept per-team API keys (try/catch-guarded DB lookup); scheduler passes `projectId` to scoped `POST /tests`; UI: Usage & Limits + API Keys sections on Team page, new Org page, Sidebar "Org" nav item; ~85 new tests | ✅ Complete |
| 26 | Redis-backed rate limiting: `redis.ts` (ioredis client, `REDIS_URL`-gated) in api-service + results-service; `@fastify/rate-limit` registered globally (`RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS`, default 600/min/IP, `skipOnError: true` fail-open, `redis: redisClient` shared store); `allowList` exempts `/health` + internal worker→results-service callbacks; per-route overrides on `/auth/login`+`/auth/register` (`AUTH_RATE_LIMIT_MAX`, default 10/min) and 8 explicit AI/suggest/diagnose endpoints (`AI_RATE_LIMIT_MAX`, default 20/min); `checks.redis` added to both `/health` endpoints; 2 new rate-limit test files | ✅ Complete |

## Current Architecture Files

- `api-service/src/index.ts` — 3-way routing + security + safeTestResponse() + quota enforcement
- `api-service/src/session.ts` — getApiSession (DB-backed session lookup) + hashApiKey
- `api-service/src/quotas.ts` — getTeamQuota/checkTestQuota
- `results-service/src/ws.ts` — WebSocket server (ws noServer mode)
- `results-service/src/db.ts` — createSchema() with all tables + safe migrations (8 migrations)
- `results-service/src/session.ts` — DB-backed sessions: createSession/getSession/revokeSession/switchSessionTeam + hashApiKey
- `results-service/src/quotas.ts` — getTeamQuota/upsertTeamQuota/checkScheduleQuota/checkGeminiQuota/incrementGeminiUsage/getTeamUsage
- `results-service/src/app.ts` — REST API incl. /auth/*, /teams/*, /orgs/* + RBAC onRequest hook (projectId/role/orgId/orgRole + team API key auth)
- `worker-backend/src/parser.ts` — parseK6Output, parseK6Errors, aggregateWindow, parseK6GroupMetrics
- `ai-service/src/generator.ts` — generateScript, compareDescriptions, FLOW_PROMPT
- `api-service/src/redis.ts` — ioredis client (`REDIS_URL`-gated), shared @fastify/rate-limit store
- `results-service/src/redis.ts` — same, for results-service

## Active Test Suite

- **Unit:** 25 (parser) + 44 (analyzer) + 16 (options) + 22 (api index) + 12 (scheduler) + 12 (generator) = ~131
- **Integration:** 89 (api) + 41 (auth) + 27 (teams) + 22 (orgs) + 14 (results quotas) + 11 (session) + 11 (consumer) + 10 (stale) + 9 (apiKeys) + 9 (scripts) + 9 (api quotas) + 7 (api session) + 3 (teamApiKey) + 2 (api rateLimit) + 3 (results rateLimit) = ~267
- **UI:** 9 (AnalysisPanel) + 6 (ActiveTests) + 6 (AuthContext) + 14 (home) + 11 (LoginPage) + 16 (TeamPage) + 9 (OrgPage) + 9 (results) = ~80
- **E2E:** 3 Playwright suites (happy-path, cancel, compare)
- **Total: ~902 tests** (897 + 5 new rate-limit tests; some Testcontainers suites are skipped under heavy parallel contention but pass individually)

## Known Tech Debt

- Gemini free tier: 20 req/day limit; each new-desc test costs 2 calls
- recorder-service Docker image adds ~60 MB (xvfb + x11vnc + novnc)
- analyser-service AI prompt lacks typed payload (may cause inconsistent prompts for large flows)

## Code Analysis (2026-06-04) — All items resolved in Phase 22

Full analysis artifacts: `docs/code-analysis/` (9 module docs + summary.md)

All confirmed bugs (B1, B4, B5, B7, B8, B9) and security gaps (S1 SSRF+auth on recorder, S2 SSRF guard, S3 scheme check) resolved. Architectural fixes: analyzeResult moved to @alt/shared, AMQP reconnect added to all services, AnalysisPromptPayload typed.
