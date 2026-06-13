# Discovery: api-service & ai-service test coverage gaps + perf candidates

## api-service

Source files (`src/*.ts`, excl. `__tests__`, `logger.ts`, `tracing.ts`):
- `index.ts` (317 lines) — Fastify app, POST /tests (3-way routing), cancel, health
- `queue.ts` (101 lines) — RabbitMQ publisher
- `quotas.ts` (64 lines) — getTeamQuota, checkTestQuota
- `options.ts` (85 lines) — buildK6Options, replaceK6Options
- `scripts.ts` (64 lines) — findExistingScript, incrementUsedCount, stepsToKey, pool, checkDbHealth
- `session.ts` (40 lines) — hashApiKey, getApiSession
- `redis.ts` (8 lines) — redisClient export

Existing test files:
- `index.test.ts` — POST /tests routing branches (cache miss/hit/description compare/flow bypass), invalid type, UUID gen, thresholds passthrough; POST /tests/:id/cancel (success + error forward); GET /health (ok/db down/queue down); parameterization (testData/csvData/csvFilename passthrough); response sensitive-field stripping (envVars/testData/csvData/csvFilename); session+quota enforcement (401, projectId forwarding, 429 over quota)
- `options.test.ts` — replaceK6Options (simple/nested stages/no-op/deep thresholds/no dup semicolon); buildK6Options (spike/capacity/load profiles, peakVus default, valid JSON for every profile); httpOptions (http2, discardResponseBodies, combined with profile)
- `queue.test.ts` — isQueueConnected, connectQueue (env var check, durable queue/exchange asserts, retry w/ backoff, exhaustion after 20 retries), publishTest (routing for skipAI true/false, per test type, JSON serialization), publishCancel (fanout, testId payload), getWorkerConsumerCount (per type, 0 when disconnected/throws)
- `quotas.test.ts` — getTeamQuota (default + override), checkTestQuota (bypass when no teamId, within limits, VUs/duration/concurrent over-limit, sessions for client-side, isolation across teams)
- `rateLimit.test.ts` — /health exempt, 429 + Retry-After when RATE_LIMIT_MAX exceeded
- `scripts.test.ts` — findExistingScript (null/found/description/null description, options injection for backend, no-op for client-side), stepsToKey (format/determinism/uniqueness/empty array/hex), incrementUsedCount (SQL + void return)
- `security.test.ts` — API key auth (dev mode, /health exempt, 401 missing/wrong key, 200 correct key, comma-separated list); input validation (URL format, description length, steps count, valid http/https, invalid type, boundary 500 chars/20 steps); CORS headers (default wildcard, ALLOWED_ORIGIN); envVar injection (valid keys accepted); cancel endpoint (404 forward, testId forward)
- `session.test.ts` — getApiSession (undefined token, unknown token, valid session projectId/role, no current team, revoked, expired, role from team_members)
- `teamApiKey.test.ts` — per-team API key auth (scopes POST /tests, rejects revoked key, rejects unknown key)

### Gaps

1. **`session.ts` — `hashApiKey`**: no direct unit test exists for the hash function itself (only indirectly exercised via `teamApiKey.test.ts` which generates/looks up keys). A pure unit test (input → sha256 hex, deterministic, different inputs → different hashes) is missing but low-value given indirect coverage.

2. **`redis.ts` — `redisClient`**: NOT directly tested. `rateLimit.test.ts` tests the `@fastify/rate-limit` behavior (429/Retry-After/exempt routes) but does not appear to set `REDIS_URL`, so it only exercises the in-memory fallback path. **Gap**: no test verifies `redisClient` is `undefined` when `REDIS_URL` unset, nor that an ioredis instance is created when `REDIS_URL` is set (could be a thin unit test mocking `ioredis`).

3. **`index.ts` — `GET /health` `checks.redis`**: CLAUDE.md describes `/health` returning `checks.redis: 'ok'|'disconnected'|'disabled'`, but this field is not referenced in `services/api-service/src/__tests__` greps for health tests (`index.test.ts` only covers DB/queue branches). **Gap**: no test asserts the `redis` key in the `/health` response body for any of the three states. (Need to confirm whether api-service `/health` actually includes this field — it's documented for results-service primarily; verify before adding test.)

4. **`index.ts` — worker consumer-count warning message**: CLAUDE.md documents that `POST /tests` calls `getWorkerConsumerCount` after publish and posts a warning status message (`"No browser (Puppeteer) worker is running…"`) when `consumerCount === 0`. `index.test.ts` does not appear to test this status-message side effect (it tests `getWorkerConsumerCount` itself in `queue.test.ts`, but not the integration where api-service calls `/results/:testId/message` with the warning text).

5. **`quotas.ts` — `checkTestQuota` for `'flow'` test type**: existing tests cover `'backend'` (VUs/duration) and `'client-side'` (sessions), but flow-type quota checks (which option field is used — likely `options.vus` from the underlying k6 run) aren't explicitly tested. Worth confirming flow tests are quota-checked correctly.

6. **`scripts.ts` — `findExistingScript` for flow type / `stepsToKey` lookup combination**: `scripts.test.ts` tests `stepsToKey` independently and `findExistingScript` for backend/client-side by URL, but doesn't test `findExistingScript` being called with a `'flow:<hash>'` key (the actual integration path used for flow tests). Edge case: collision-safety / lookup-by-hash-key path untested.

7. **`index.ts` — `customScript` bypass path**: CLAUDE.md documents `customScript` (≤512KB) bypassing AI and script cache entirely, routing direct to worker, not stored in DB. No test for this path found in `index.test.ts` greps — worth confirming size-limit enforcement (512KB) and that it skips `findExistingScript`/AI queue.

8. **`index.ts` — error handling for results-service unreachable** during `POST /results/pending` call (network error, not just 4xx/5xx from results-service) — likely untested edge case (only "error from results-service when cancel fails" is covered for cancel, not for the pending-record creation call in POST /tests).

## ai-service

Source files (`src/*.ts`, excl. `__tests__`, `logger.ts`, `tracing.ts`):
- `index.ts` (202 lines) — RabbitMQ consumer (comparison branch + generation) + `POST /translate` endpoint (Fastify)
- `generator.ts` (316 lines) — `generateScript`, `compareDescriptions`, `BACKEND_PROMPT`, `CLIENT_PROMPT`, `FLOW_PROMPT`, `profileInstructions`, `renderExtractLine`

Existing test files:
- `generator.test.ts` — FLOW_PROMPT extract rules (jsonpath/header/cookie/regex rendering, exec.vu.abort inclusion/exclusion), `{{varName}}` placeholder substitution (header/body/none), parameterization (SharedArray for testData/csvData, absence when neither provided), `compareDescriptions` (REUSE/REGENERATE verdicts, unexpected response, generic error, 429 retry), BACKEND_PROMPT (targetUrl, description, "only k6 JS" instruction, httpOptions http2/discardResponseBodies), profileInstructions (spike/capacity/soak/load default, rampUp), CLIENT_PROMPT (targetUrl, description, sessions, Web Vitals instructions), generateScript 429 retry (success after retry, throws on non-429 no retry)
- `index.test.ts` — consumer routing: REUSE path (sends to backend/client queue + acks, identical-description short-circuit), REGENERATE path (calls generateScript, clears scriptId), null cachedScriptDescription (always regenerate), no cachedScript (direct generateScript), DLQ exhaustion (retry republish, route to DLQ at MAX_RETRIES, posts failure/retry status messages)
- `translate.test.ts` — POST /translate (success, markdown fence stripping, targetUrl passthrough, 400 missing script, 400 >256KB, 503 no GEMINI_API_KEY, 500 on Gemini error). Note: includes a stray Playwright `test('login', ...)` at line 66 — looks like an accidentally-included E2E test mixed into this file (worth flagging, possibly leftover/misplaced).

### Gaps

1. **`generateScript` — full 3-attempt retry/backoff exhaustion**: `generator.test.ts` tests "retries once after 429" (success on 2nd attempt) and "throws on non-429 (no retry)", but does NOT test the full exhaustion case — all 3 attempts fail with 429 → final error thrown after 60/120/180s backoffs. (CLAUDE.md documents 3-attempt retry with this backoff schedule.) This is the path that leads to DLQ in `index.ts`'s consumer — partially covered there (`index.test.ts` "routes to DLQ when retryCount equals MAX_RETRIES") but that test likely mocks `generateScript` to reject directly rather than exercising the real retry loop.

2. **`compareDescriptions` — full retry exhaustion**: similarly, only "retries once after a 429" is tested; exhausting all retries and falling back to default `'REGENERATE'` after repeated 429s is not explicitly tested (though "returns REGENERATE on generic error" partially covers the safe-fallback behavior for non-429).

3. **FLOW_PROMPT — combined extract + placeholder + parameterization scenario**: each feature (extract rules, `{{varName}}`, SharedArray) is tested independently, but no test exercises a flow with ALL THREE simultaneously (a step with both an extract rule AND a `{{varName}}` placeholder AND `testData`/`csvData` present) — a realistic combined scenario that could reveal prompt-section-ordering or duplication bugs.

4. **`generator.ts` — `renderExtractLine`**: not exported; only tested indirectly via FLOW_PROMPT rendering for all 4 `ExtractSource` types (jsonpath/header/cookie/regex). Coverage looks adequate via FLOW_PROMPT tests, but no test for an UNKNOWN/invalid `source` value (defensive fallback) — minor edge case.

5. **`index.ts` — `POST /translate` rate limiting / size validation edge boundary**: tests cover "exceeds 256 KB" (`>` case) but not the exact boundary (exactly 256KB, should be accepted) — minor edge case per CLAUDE.md "Input validation" patterns elsewhere in the codebase that test exact boundaries (e.g. api-service tests 500-char description boundary, 20-step boundary).

6. **`index.ts` — consumer message ack/nack on malformed JSON / unparseable message body**: not found in `index.test.ts` greps — what happens if a message on `ai-requests` has invalid JSON? Likely an uncaught exception → message stuck/redelivered. Worth a defensive test + possibly a fix (catch + nack to DLQ).

7. **Stray Playwright test in `translate.test.ts`**: line 66 has `test('login', async ({ page }) => {...})` — this looks misplaced (an E2E-style test inside a Vitest unit test file for ai-service). Flag for cleanup/relocation, not a coverage gap per se, but indicates the file may not be cleanly organized.

### Performance Candidates

**api-service:**
1. `POST /tests` (3-way routing endpoint) — under realistic load (many concurrent requests with varying cache-hit/miss combinations), assert p95 response time stays low; this endpoint does DB lookups (`findExistingScript`), quota checks (`checkTestQuota` — queries `gemini_usage`/concurrent test counts), and RabbitMQ publish + `getWorkerConsumerCount` (a `channel.checkQueue` RPC) — multiple I/O hops in series, good candidate for response-time SLO assertions.
2. `options.ts` — `buildK6Options` / `replaceK6Options`: string/regex-based JSON manipulation on k6 script text. `replaceK6Options` uses regex to find and replace an `options` block in potentially large generated scripts (FLOW_PROMPT scripts can be large with many steps) — good micro-benchmark candidate for regex performance on large script strings (e.g. 20-step flow scripts).
3. `scripts.ts` — `stepsToKey`: SHA-256 hashing of serialized `FlowStep[]` — cheap individually, but called on every flow-test request; micro-benchmark for serialization+hash cost at max 20 steps with large bodies/headers.

**ai-service:**
1. `FLOW_PROMPT` (generator.ts, 114 lines, largest prompt builder) — string template building over up to 20 `FlowStep`s, each with `extract` rules, `{{varName}}` substitution detection (likely regex scan over step bodies/headers), and SharedArray/parameterization sections. Good candidate for a micro-benchmark: build FLOW_PROMPT for a 20-step flow with extract rules + placeholders + testData, measure prompt construction time and resulting prompt size (token budget concern noted in CLAUDE.md tech debt re: prompt payload sizing).
2. `compareDescriptions` / `generateScript` — Gemini API round-trip latency; not a pure-CPU benchmark but a good candidate for response-time assertions with mocked Gemini client (assert the retry/backoff doesn't introduce unexpected delay in the non-retry happy path).
3. `POST /translate` — accepts up to 256KB script body, builds a prompt embedding the full script text, then strips markdown fences from response via regex. Good candidate for a response-time/throughput assertion at the 256KB boundary (large input string handling + regex fence-stripping on a large response).
