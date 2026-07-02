# Test Coverage TODO

Gaps identified from audit on 2026-06-28. Items marked ✅ were already covered and removed.

This is a narrower, dated unit-test-coverage gap list — unrelated in scope to root [`TODO.md`](../TODO.md)'s AI feature roadmap. (Formerly `docs/TODO.md`; renamed to avoid confusion with the root file.)

---

## 🔴 High Priority

### H1 — `runK6Test` orchestration (worker-backend)
**File:** `services/worker-backend/src/index.ts`

Zero tests for the core k6 execution path:
- Spawning k6 via `child_process.spawn`
- Writing temp data files; cleanup on `validateScript` failure
- Live-metric polling loop (`readAndPost` + `aggregateWindow` integration)
- `MAX_TEST_DURATION_MS` SIGTERM → SIGKILL escalation timer
- Exit-code handling: 0 (success), 99 (threshold violation), other (failure)
- `cancelledTests` Set interplay with the running process

**Approach:** Mock `child_process.spawn` in Vitest; test cancel/timeout/retry paths as unit tests.

---

### H3 — `runClientTest` orchestration (worker-client)
**File:** `services/worker-client/src/index.ts`

`avg()` / `avgNum()` / `avgResourceBreakdown()` helpers are tested in `metrics.test.ts`.
Still missing — the orchestration layer:
- `runClientTest()` — full Puppeteer session lifecycle
- Web Vitals collection pipeline
- Lighthouse integration via `wsEndpoint` reuse
- Cancel-detection logic after execution

**Approach:** Mock `puppeteer.launch()` and `newPage()` for lifecycle tests.

---

### H4 — ai-service consumer routing (ai-service)
**File:** `services/ai-service/src/index.ts`

RabbitMQ consumer branching logic has no unit tests (only covered by Playwright E2E):
- `compareDescriptions()` → REUSE path (forwards cached script unchanged)
- `compareDescriptions()` → REGENERATE path (calls `generateScript`)
- DLQ routing after 3 retries
- `cachedScript` + `cachedScriptDescription` passthrough in the message

**Approach:** Extract routing into a pure function; add Vitest tests per branch.

---

## 🟡 Medium Priority

### M3 — `callAnalyserService` — `geminiRateLimited` branch (results-service)
**File:** `services/results-service/src/consumer.ts`

- Fire-and-forget `POST /results/:testId/message` when `geminiRateLimited: true` is not asserted
- Scenario where `geminiRateLimited` is true but `aiInsights` is absent

---

### M5 — `handleResult` transaction rollback (results-service)
**File:** `services/results-service/src/consumer.ts`

No test forces an INSERT failure to verify:
- `ROLLBACK` is called when `client.query` throws inside the transaction
- Error propagates correctly to the consumer's `channel.consume` handler
- Message gets retried / routed to DLQ

---

### M7 — `queryWithRetry` retry/backoff (results-service)
**File:** `services/results-service/src/db.ts`

`db.test.ts` only covers `readPool` fallback (2 tests). Still missing:
- Retries up to 5 times on transient errors
- Succeeds on a later attempt after N failures
- Throws after exhausting all retries

---

### M8 — `createSchema` idempotency (results-service)
**File:** `services/results-service/src/db.ts`

No assertion that running `createSchema(pool)` twice does not re-apply migrations.
The `schema_migrations` row count should equal `MIGRATIONS.length` after both calls.

---

### M11 — Result detail page (UI)
**File:** `services/ui/app/results/[testId]/page.tsx` (714 lines)

`ResultDetail.test.tsx` only has 5 tests (status_message + self-healing poll).
Still missing:
- Tab switching (Overview / Execution Log / Steps)
- Baseline set/clear interactions
- Re-run button behavior
- PDF report download link rendering
- Analysis panel for failed tests

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
