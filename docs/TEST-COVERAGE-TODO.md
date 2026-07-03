# Test Coverage TODO

Gaps identified from audit on 2026-06-28. Items marked ✅ were already covered and removed.

This is a narrower, dated unit-test-coverage gap list — unrelated in scope to root [`TODO.md`](../TODO.md)'s AI feature roadmap. (Formerly `docs/TODO.md`; renamed to avoid confusion with the root file.)

---

## 🔴 High Priority

### H1 — `runK6Test` orchestration (worker-backend) — ✅ DONE (2026-07-03)
**File:** `services/worker-backend/src/index.ts`

Zero tests for the core k6 execution path:
- Spawning k6 via `child_process.spawn`
- Writing temp data files; cleanup on `validateScript` failure
- Live-metric polling loop (`readAndPost` + `aggregateWindow` integration)
- `MAX_TEST_DURATION_MS` SIGTERM → SIGKILL escalation timer
- Exit-code handling: 0 (success), 99 (threshold violation), other (failure)
- `cancelledTests` Set interplay with the running process

**Approach:** Mock `child_process.spawn` in Vitest; test cancel/timeout/retry paths as unit tests.

**Resolved:** `services/worker-backend/src/__tests__/runner.test.ts` (spawn mocking, temp file writing/cleanup, SIGTERM→SIGKILL escalation, exit-code handling, `handleRetry` DLQ routing) and `__tests__/index.test.ts` (`cancelledTests` interplay, notify* REST helpers) already covered every item except the live-metric polling loop — added 4 new tests for `readAndPost`/`aggregateWindow` (posts on new data, skips when no new bytes, final flush on close, interval cleared after close). 129/129 worker-backend tests passing.

---

### H3 — `runClientTest` orchestration (worker-client) — ✅ DONE (already resolved, commit `de2c12d`, 2026-06-29)
**File:** `services/worker-client/src/index.ts`

`avg()` / `avgNum()` / `avgResourceBreakdown()` helpers are tested in `metrics.test.ts`.
Still missing — the orchestration layer:
- `runClientTest()` — full Puppeteer session lifecycle
- Web Vitals collection pipeline
- Lighthouse integration via `wsEndpoint` reuse
- Cancel-detection logic after execution

**Approach:** Mock `puppeteer.launch()` and `newPage()` for lifecycle tests.

**Resolved:** this item was already closed in commit `de2c12d` (never reflected here) — `runClientTest` was extracted into `services/worker-client/src/runner.ts` with an injectable `ClientRunnerContext` (`launchBrowser`/`runLighthouse` overrides), and `services/worker-client/src/__tests__/runner.test.ts` adds 22 tests covering session flow, multi-session averaging, Lighthouse score/INP/TBT extraction, non-fatal Lighthouse failure, `runningBrowsers` lifecycle, `partialLog` on throw, custom headers, and execution log output. Verified still passing: 50/50 worker-client tests.

---

### H4 — ai-service consumer routing (ai-service) — ✅ DONE (already resolved, commit `828ce41`)
**File:** `services/ai-service/src/index.ts`

RabbitMQ consumer branching logic has no unit tests (only covered by Playwright E2E):
- `compareDescriptions()` → REUSE path (forwards cached script unchanged)
- `compareDescriptions()` → REGENERATE path (calls `generateScript`)
- DLQ routing after 3 retries
- `cachedScript` + `cachedScriptDescription` passthrough in the message

**Approach:** Extract routing into a pure function; add Vitest tests per branch.

**Resolved:** this item was already closed (never reflected here) — routing logic lives in `services/ai-service/src/processor.ts` (`processAiRequest`, pure function taking injectable `generateScript`/`compareDescriptions` deps), and `services/ai-service/src/__tests__/processor.test.ts` adds 20 tests covering REUSE, REGENERATE, generation fallthrough, DLQ after `MAX_RETRIES`, retry-count incrementing, `cachedScript` without description, backend/client/flow queue routing, and ack guarantees on every path. Verified still passing: 78/78 ai-service tests.

---

## 🟡 Medium Priority

### M3 — `callAnalyserService` — `geminiRateLimited` branch (results-service) — ✅ DONE (already resolved)
**File:** `services/results-service/src/consumer.ts`

- Fire-and-forget `POST /results/:testId/message` when `geminiRateLimited: true` is not asserted
- Scenario where `geminiRateLimited` is true but `aiInsights` is absent

**Resolved:** this item was already closed (never reflected here) — `services/results-service/src/__tests__/consumer.test.ts` → `describe('handleResult — geminiRateLimited branch (M3)')` (3 tests): posts the quota-exceeded status_message when `geminiRateLimited=true`, still saves the analysis when `aiInsights` is absent, and does NOT post a message when `geminiRateLimited` is false.

---

### M5 — `handleResult` transaction rollback (results-service) — ✅ DONE (2026-07-03)
**File:** `services/results-service/src/consumer.ts`

No test forces an INSERT failure to verify:
- `ROLLBACK` is called when `client.query` throws inside the transaction
- Error propagates correctly to the consumer's `channel.consume` handler
- Message gets retried / routed to DLQ

**Resolved:** the `ROLLBACK`-on-INSERT-failure half was already covered by `describe('handleResult — transaction rollback (M5)')` (2 tests, real Postgres via testcontainers: FK-violation INSERT → rollback → re-throw → no committed row, no webhook fired). The remaining half — retry/DLQ routing around the `channel.consume(QUEUE, ...)` wrapper in `startConsumer()` — had no coverage; added `describe('Queue consumer — retry/DLQ routing when handleResult throws (M5)')` (5 tests, mocked channel/msg, no DB/broker needed): republish with incremented `x-retry-count` below `MAX_RETRIES`, DLQ routing at/above `MAX_RETRIES`, missing-header treated as first attempt, ack-only on success. 53/53 tests passing across `consumer.test.ts` + `db.test.ts`.

---

### M7 — `queryWithRetry` retry/backoff (results-service) — ✅ DONE (already resolved)
**File:** `services/results-service/src/db.ts`

`db.test.ts` only covers `readPool` fallback (2 tests). Still missing:
- Retries up to 5 times on transient errors
- Succeeds on a later attempt after N failures
- Throws after exhausting all retries

**Resolved:** this item was already closed (never reflected here) — `services/results-service/src/__tests__/db.test.ts` → `describe('queryWithRetry (M7)')` (5 tests): resolves immediately on first success, retries and succeeds on the second attempt, retries N-1 times then throws after exhausting all retries, defaults to `retries=5`, throws immediately when `retries=1`.

---

### M8 — `createSchema` idempotency (results-service) — ✅ DONE (already resolved)
**File:** `services/results-service/src/db.ts`

No assertion that running `createSchema(pool)` twice does not re-apply migrations.
The `schema_migrations` row count should equal `MIGRATIONS.length` after both calls.

**Resolved:** this item was already closed (never reflected here) — `services/results-service/src/__tests__/db.test.ts` → `describe('createSchema — idempotency (M8)')` (3 tests): no migration re-applied on a second `createSchema(pool)` call, `schema_migrations` row count equals `MIGRATIONS.length` (14), and versions are sequential 1..14.

---

### M11 — Result detail page (UI) — ✅ DONE (already resolved, commit `de2c12d`, 2026-06-29)
**File:** `services/ui/app/results/[testId]/page.tsx` (714 lines)

`ResultDetail.test.tsx` only has 5 tests (status_message + self-healing poll).
Still missing:
- ~~Tab switching (Overview / Execution Log / Steps)~~ — stale: the page has no tabs, it's a single scrolling layout with an inline `StepMetricsTable` and a collapsible `ExecutionLogPanel`, not a tabbed view
- Baseline set/clear interactions
- Re-run button behavior
- PDF report download link rendering
- Analysis panel for failed tests

**Resolved:** this item was already closed in commit `de2c12d` (never reflected here) — `services/ui/__tests__/ResultDetailPage.test.tsx` adds 29 tests covering loading state, completed backend metric cells, status badge, baseline set/clear toggle, Re-run link, PDF/CSV links, Stop button (running/pending), client-side LCP/FCP/TTFB/CLS cells, analysis panel presence, and the execution log panel (collapsed by default, fetch on expand, empty-log message). Verified still passing alongside the original `ResultDetail.test.tsx`: 34/34 tests across both files.

---

## 🟢 Low Priority

### L1 — `startSession` / CDP event pipeline (recorder-service)
**File:** `services/recorder-service/src/recorder.ts`

`startSession`, `stopSession`, and CDP event handlers (`Network.requestWillBeSent`,
`Network.responseReceived`, `Network.loadingFinished`) are entirely untested.

**Verified still open (2026-07-02):** root `TODO.md`'s completed "Recorder-service test coverage" item
(`recorder.test.ts`, `correlator.test.ts`, `api.test.ts`) does **not** close this gap —
`recorder.test.ts` mocks `puppeteer-core` entirely and only exercises pure helpers
(`compileIgnorePatterns`, `toFlowSteps`, `computeThinkTimes`); `api.test.ts` mocks
`../recorder` (`startSession`/`stopSession`) wholesale to test the Fastify route layer.
Neither touches the real session/CDP pipeline.

**Note:** Puppeteer dependency makes CI-safe testing hard without a real browser.

---

### L2 — `shouldSkip` (recorder-service)
**File:** `services/recorder-service/src/recorder.ts`

No unit test for skip conditions (`SKIP_SCHEMES`, `SKIP_EXTENSIONS`, `SKIP_CONTENT_TYPES`,
user `ignorePatterns`) and their regex edge cases.

**Partially covered (2026-07-02):** the `ignorePatterns`/`compileIgnorePatterns` half of this
gap now has solid coverage — both `recorder.test.ts` and the dedicated
`services/recorder-service/src/__tests__/shouldSkip.test.ts` exercise plain-string, regex-literal,
flag, and invalid-pattern edge cases. **Still open:** the static `SKIP_SCHEMES` /
`SKIP_EXTENSIONS` / `SKIP_CONTENT_TYPES` branches inside `shouldSkip()` itself (e.g. `data:` URLs,
`.png`/`.jpg` asset extensions, `image/*` content-type filtering) remain untested — `shouldSkip`
isn't exported, and no existing test imports/exercises it directly for those branches.

---

### L3 — Presentational UI components
- `app/components/BackendChart.tsx` — status code grouping, error breakdown rendering
- `app/components/FlowStepChart.tsx` — per-step bar chart
- `app/components/TrendChart.tsx` — p95/LCP trend line
- `app/components/AIStatus.tsx` — AI status polling

---

## Out of Scope (intentionally not tested)

| Area | Reason |
|------|--------|
| k6 script generation quality | Non-deterministic AI output; covered by manual review and E2E |
| Lighthouse score accuracy | Third-party library; test the integration, not the scores |
| RabbitMQ reconnect chaos | Needs Docker-level fault injection; marked for future chaos suite |
| Playwright → k6 translation correctness | AI output; covered by E2E smoke only |
