# results-service

## Source files (src/*.ts, excl. __tests__/logger/tracing)
- `app.ts` (93KB) — Fastify REST API, all endpoints, RBAC middleware, auth routes
- `db.ts` (14KB) — pool/readPool setup, migration registry (v1-8), createSchema, findOrCreateProject
- `consumer.ts` — RabbitMQ consumer, handleResult, webhook firing, external metrics fetch, analyser-service call
- `analyzer.ts` — thin re-export of `analyzeResult` from `@alt/shared`
- `cleanup.ts` — runStaleCleanup, startStaleCleanup
- `scheduler.ts` — startScheduler, registerSchedule, reloadSchedule, removeSchedule, triggerSchedule
- `session.ts` — createSession, getSession, revokeSession, switchSessionTeam, hashApiKey
- `quotas.ts` — getTeamQuota, upsertTeamQuota, checkScheduleQuota, checkGeminiQuota, incrementGeminiUsage, getTeamUsage
- `ws.ts` — setupWebSocketServer, broadcast
- `redis.ts` — redisClient (ioredis, conditional on REDIS_URL)
- `index.ts` — startup orchestration (initDb, startConsumer, startScheduler, startStaleCleanup, buildApp, shutdown)

## Existing test files & coverage summary
- `api.test.ts` (89 tests) — most REST endpoints: results CRUD, scripts, webhooks, schedules, presets, log-sources, baseline mgmt, compare, trend, pdf report, health, system/health, pending/live/message/fail/running, ai-status
- `auth.test.ts` (41) — register/login/logout/me/switch-team, RBAC session middleware
- `orgs.test.ts` (22) — org CRUD, member roles, last-owner protection
- `teams.test.ts` (27) — team member CRUD, role enforcement, last-admin protection
- `quotas.test.ts` (17) — getTeamQuota/upsertTeamQuota defaults+merge, checkScheduleQuota, checkGeminiQuota/incrementGeminiUsage rollover, getTeamUsage (concurrent/scheduled/gemini aggregation, cross-team isolation)
- `apiKeys.test.ts` (9) — generate/list/revoke team API keys
- `session.test.ts` (13) — createSession/getSession (hashing, expiry, revocation), revokeSession, switchSessionTeam
- `consumer.test.ts` (18) — handleResult: analyser-service integration (200/non-ok/network-error/timeout fallback), persistence (insert/upsert/diffs/baseline ordering), webhook firing (failed/degraded/passed, event filter, HMAC signature)
- `stale.test.ts` (18) — runStaleCleanup: running/pending stale marking, non-target statuses, live_metrics retention, startStaleCleanup interval behavior, error swallowing
- `analyzer.test.ts` (44, lives here but tests `@alt/shared` analyzeResult) — backend thresholds, regression, client-side thresholds, INP/TBT
- `scheduler.test.ts` (15) — startScheduler (enabled-only registration), removeSchedule, reloadSchedule, triggerSchedule (POST /tests, last_run_at update, error path, default description)
- `ws.test.ts` (18) — broadcast (no-op empty, JSON payload for all 3 event types, non-OPEN client skip/removal, throw-on-send removal, multi-client), setupWebSocketServer (upgrade handling for /ws vs other paths, client add/remove on close)
- `rateLimit.test.ts` (3) — global rate limit, /health exemption, auth endpoint rate limit
- `ai-endpoints.test.ts` — AI endpoint quota/rate-limit behavior (not fully enumerated here)

## Gaps

### db.ts
- **`readPool` fallback logic is completely untested.** No test exercises the branch where `READ_DATABASE_URL` is set (separate pool) vs unset (readPool === pool). This is a one-line conditional but it's load-bearing for read-replica routing — a regression here silently sends all reads to the wrong pool or crashes if `READ_DATABASE_URL` is malformed. Suggest a focused unit test that mocks `process.env.READ_DATABASE_URL` before module import (requires `vi.resetModules()` + dynamic import since `pool`/`readPool` are computed at module load).
- **Migration engine (`createSchema`) has no direct unit test** validating idempotency — i.e. running `createSchema(p)` twice doesn't re-apply migrations (relies on `schema_migrations` table). Integration tests indirectly exercise this via Testcontainers setup but there's no explicit assertion that `schema_migrations` rows match `MIGRATIONS.length` after two calls, or that a migration is skipped on second run.
- **`queryWithRetry`** (retry-on-transient-restart helper) has no test for its retry/backoff behavior — e.g. that it retries up to 5 times then throws, or succeeds on a later attempt. Currently only exercised implicitly during container startup.
- **`findOrCreateProject`** — only the "create new" path is likely exercised elsewhere; the `ON CONFLICT ... DO UPDATE` (existing project returns same id, case-insensitive/trim normalization) doesn't appear to have a dedicated test in this service's test files (may be covered in api-service `scripts.test.ts` instead — worth checking cross-service).

### cleanup.ts
- `runStaleCleanup` broadcast behavior IS tested in `stale.test.ts` indirectly? — checking: the grep shows tests for running/pending/retention/startStaleCleanup, but **no test asserts the `broadcast()` calls** (`test:status` per stale test + `tests:changed` once). Since `broadcast` is imported from `./ws`, a test mocking `./ws` and asserting `broadcast` was called with correct payloads (including the `tests:changed` dedup — only fired once even if both running AND pending have stale rows) is missing.
- Edge case: **`LIVE_METRICS_RETENTION_DAYS` invalid/non-positive env var fallback to 30** — the `Number.isFinite(...) && > 0` guard is untested for invalid values like `"abc"` or `"-5"` or `"0"`.
- **`startStaleCleanup` error path**: `stale.test.ts` line 177 "does not propagate errors when runStaleCleanup rejects" — covered. Good.

### ws.ts
- Coverage looks comprehensive (broadcast no-op, all 3 event types, client lifecycle, error handling, multi-client). One micro-gap: **no test for `broadcast` with a very large `clients` set** (perf-relevant, see below) and no test verifying `WSEvent` type discriminants beyond the 3 listed — minor.

### consumer.ts
- **`fetchExternalMetricsForTest`** — entirely untested. No coverage for:
  - empty `log_sources` (no `metrics_endpoint_template`) → returns `[]`
  - interpolation of all placeholders (`{startedAtMs}`, `{completedAtMs}`, `{startedAtS}`, `{completedAtS}`, `{startedAtISO}`, `{completedAtISO}`, `{targetUrl}`, `{targetUrlEncoded}`)
  - `auth_header` passthrough
  - non-ok response from a log source (skipped, not pushed)
  - fetch throwing (caught, non-fatal)
  - `Promise.allSettled` with mixed success/failure across multiple sources
  - response body truncation to 3000 chars
  - outer try/catch (DB query itself throwing → returns `[]`)
- **`callAnalyserService`** — `geminiRateLimited` branch (posting status_message to `/results/:testId/message`) is untested. `consumer.test.ts` covers 200/non-ok/network-error/timeout but not the `geminiRateLimited: true` response shape or the fire-and-forget message POST.
- **`buildWebhookPayload`** — only the 'generic' format is exercised via `consumer.test.ts` webhook tests (HMAC signature tests). The **'slack', 'pagerduty', and 'opsgenie' format branches are entirely untested** — no assertion on their JSON shape, `routing_key`/`severity`/`priority` mapping by `perfStatus`, or that `format` from the `webhooks` row is correctly passed through `fireWebhooks`.
- **`fireWebhooks`** — `Promise.allSettled` rejection logging path (`log.warn` on rejected delivery) is untested — only success-path deliveries are asserted in consumer.test.ts.
- **`handleResult` error path** — the `ROLLBACK` on `client.query` throwing inside the transaction (line 262-267) is untested; no test forces an INSERT failure to verify rollback + error propagation + DLQ retry in the consumer's `channel.consume` handler.
- **`startConsumer`** — RabbitMQ connection retry loop (`maxRetries=20`, `delay=10000`) and the full `channel.consume` message handling (ack/retry/DLQ via `x-retry-count` header) are untested at unit level. This is the main message-processing entrypoint and currently relies entirely on integration/E2E coverage (if any).

### scheduler.ts
- Coverage looks solid for the public API. Minor gap: **`registerSchedule`'s `activeTasks.has(schedule.id)` branch** (stopping and replacing an existing task) is tested via `reloadSchedule` "stops the old cron task when re-registering" — appears covered.
- `triggerSchedule`'s `apiKey` header conditional (`X-API-Key` only when `API_KEY` env set) — not explicitly tested for the "no API_KEY" case.

### quotas.ts
- Coverage looks comprehensive based on test titles.

### session.ts
- Coverage looks comprehensive. `hashApiKey` itself has no direct unit test (only indirectly via apiKeys.test.ts integration).

### app.ts (93KB — largest file, ~30+ endpoints)
- Given file size vs. 89 tests in api.test.ts + auth/orgs/teams/quotas/apiKeys/rateLimit/ai-endpoints, coverage is broad but likely has gaps in:
  - Error-path / validation edge cases for less-traveled endpoints (not enumerated individually here due to scope, but `app.test.ts` for `/results/:testId/diagnose`, `/results/suggest-settings`, `/results/suggest-thresholds`, `/ai/trend-narrative`, `/ai/webhook-noise`, `/ai/preset-name`, `/ai/param-suggestions`, `/ai/cron` are only covered in `ai-endpoints.test.ts` — verify quota-exceeded (429) + Gemini-unreachable fallback paths are tested for ALL of these, not just one or two representative ones).
  - `/system/health` — "saturated" and "unreachable" worker statuses are tested per api.test.ts titles; verify all 5 service health-check branches (timeout, malformed JSON response, non-200) are covered.

## Performance Candidates

1. **`consumer.ts: handleResult` pipeline** — CPU/IO-heavy: runs a previous-metrics query, an external HTTP call to analyser-service (12s timeout) + N parallel calls to log_sources (`fetchExternalMetricsForTest`, 5s timeout each via `Promise.allSettled`), a transactional INSERT/UPSERT, then webhook fan-out + WS broadcast. A micro-benchmark exercising `handleResult` with a large `metrics.stepMetrics[]` array (flow test with many steps) and many configured `log_sources`/`webhooks` rows would surface latency under realistic team configurations. Also worth benchmarking JSON.stringify cost on large `metrics`/`analysis` objects.

2. **`@alt/shared` `analyzeResult` (analyzer.ts re-export)** — regression diffing logic runs on every completed test. A micro-benchmark feeding large `stepMetrics[]` arrays (e.g. 20-step flow tests, the max allowed per CLAUDE.md `steps ≤ 20`) for both current and previous metrics would validate the diffing/threshold-checking scales linearly and stays under a budget (e.g. <5ms) — important since this runs synchronously in the consumer's hot path before the DB write.

3. **`GET /results/:testId/live` endpoint** — returns all `live_metrics` rows for a test, potentially thousands of rows for long-running soak tests (k6 max duration 10 min → 5s windows → ~120 rows per test, but for flow tests each row also carries a `step_metrics JSONB` array up to 20 steps). A response-time assertion test seeding e.g. 500-1000 live_metric rows with `stepMetrics` and asserting the endpoint responds within a budget (e.g. <500ms) would catch missing indexes or N+1 JSON parsing issues. Note: `live_metrics_test_id_idx` exists but query shape (ORDER BY timestamp) should be verified as index-covered.

4. (Bonus) **`GET /results` and `GET /results/trend`** — `GET /results` is capped at "last 50" per CLAUDE.md but joins `test_scripts`; `GET /results/trend?url=` has no row-count cap visible and could return unbounded rows for a URL tested frequently over a long history — a perf test seeding hundreds of completed results for one URL and asserting response time/row count behavior would be valuable, and may also reveal a missing pagination/limit that should be added.

5. (Bonus) **`runStaleCleanup`** — the `live_metrics` retention DELETE (`WHERE timestamp < NOW() - retentionDays`) on a table that could grow very large (continuous 5s-window writes across many tests) — a perf test seeding a large `live_metrics` table and timing the DELETE + checking it doesn't block the cleanup interval excessively.
