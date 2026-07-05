# Test Coverage Gaps — QA Audit (2026-07-05)

Full-repo audit of test coverage and test-type gaps across all 8 services, `packages/shared`,
the Playwright e2e suite, and the chaos-testing suite. Produced by reading actual source/test
files and cross-referencing them — every item below was verified, not guessed. Supersedes the
previous `docs/TEST-COVERAGE-TODO.md` (removed once its gaps were closed); this is a fresh pass
reflecting the codebase as of today, including features added this week (live-metrics
downsampling, 4xx/5xx breakdown, `HealthContext` centralization, worker SIGTERM draining,
log-line batching).

**Snapshot:** 1297+ unit/integration tests across 8 services + shared + chaos, plus 11 Playwright
e2e specs. No `TODO`/`FIXME`/`.skip`/`xit` markers were found anywhere in the repo — there is no
self-documented backlog to cross-check against; every gap here was found by direct comparison of
source files to test files.

## How to use this doc

Items are grouped by area, each with a file reference and what's actually missing (not "more
tests would be nice" — a specific behavior, branch, or file with zero or shallow coverage).
Ranked roughly by risk × likelihood within each group. This is a findings list, not a task
tracker — pull items into `TODO.md` if/when someone picks them up.

---

## 1. Structural gaps (highest impact — apply broadly)

### 1.1 ~~`ai-service/src/index.ts` has zero direct test coverage~~ — RESOLVED (2026-07-05)
`index.ts` now exports `app`/`startConsumer`/the queue-name constants and guards its
module-scope `start()` call with `if (!process.env.VITEST)`, matching `api-service`/
`analyser-service`/`recorder-service`'s `buildApp()` pattern. `index.test.ts` was rewritten to
drive the real module against an EventEmitter-based mocked `amqplib` connection/channel instead
of a hand-copied decision tree — the old 250-line reimplementation (which duplicated
`processor.test.ts`'s coverage of `processAiRequest` and could silently drift from the real file)
was deleted. New tests cover: queue/DLQ assertion + prefetch, reconnect-on-close,
reconnect-dedupe, `/health` reflecting connection state, the malformed-JSON→DLQ guard, and
delegation to `processAiRequest` with the right args. 9 tests, all real-module.

### 1.2 ~~Neither worker's (nor api-service's) AMQP reconnect wiring is tested~~ — RESOLVED (2026-07-05)
All three fixed the same way: export `app`/`start`, guard the module-scope `start()`/
`startHealthServer()` calls and the `SIGTERM`/`SIGINT` registration with
`if (!process.env.VITEST)`, and test the real connection/channel event handlers via
EventEmitter-based amqplib mocks (reconnect-on-close, reconnect-dedupe, `/health` reflecting
state).
- `worker-backend`: also replaced the confirmed-redundant `handleRetryFn`/`validateScriptFn`
  hand-copies (both already had real-module coverage in `runner.test.ts`) with real tests of the
  work-queue consumer's Stop-button cancel branch (zero-requests → cancelled, partial-requests →
  completed-with-partial-metrics) and the cancel-queue consumer (kill tracked process, no-op for
  unknown testId), driving the actual registered `channel.consume` callbacks. 21 tests, all
  real-module (was 13 hand-copied tests, net removed 139 lines of duplicate logic).
- `worker-client`: same fix. Also discovered `index.ts` had **no `VITEST` guard at all** — every
  test run was silently trying to bind a real port (3003) and connect real AMQP, which explains
  the recurring `EADDRINUSE` warnings seen throughout the session. `health.test.ts` (a
  hand-reimplemented parallel Fastify app testing a copy of the `/health` handler) was deleted and
  superseded by real `app.inject` tests in the new `index.test.ts`. 13 tests, all real-module.
- `api-service/src/queue.ts` was already well-tested (25 tests) but its connection/channel mocks
  were bare objects with a no-op `on: vi.fn()` spy, so `.on('close', cb)` calls were recorded but
  never actually triggered. Upgraded the mocks to real `EventEmitter`s and added 3 tests for
  reconnect-on-close, reconnect-dedupe, and disconnect-on-channel-error.
- Total: 4 services fixed, 405 tests passing across them (was ~35 fewer, several of which were
  dead-weight duplicates).

### 1.3 No contract/schema validation between services
RabbitMQ messages are consumed via raw `JSON.parse` with no schema validation (e.g.
`results-service/src/consumer.ts:286`, `ai-service/src/index.ts:82`) and no zod/ajv contract tests
assert producer/consumer message-shape compatibility across `api-service` → `ai-service` →
`worker-backend`/`worker-client` → `results-service`. A field rename or type change on one side of
a queue would only surface as a runtime `undefined` deep in a handler, not a test failure.

### 1.4 No coverage threshold enforced anywhere
`vitest.config.ts`'s `coverage` block has no `thresholds`, and the CI step uploads to Codecov with
`fail_ci_if_error: false` — coverage can regress indefinitely without failing a build.

### 1.5 Background/scheduled logic is a recurring blind spot
No interval- or event-driven background path has a fake-timer-based test anywhere in the repo:
- `recorder-service/src/index.ts:216-233` — the auto-stop sweep (60s interval, auto-stops sessions
  past `RECORDER_MAX_DURATION_MS`/`RECORDER_IDLE_TIMEOUT_MS`) has **no test at all**, and no test
  covers the race between an auto-stop and a concurrent manual `/stop` on the same session.
- `api-service/src/queue.ts` / both workers' `index.ts` — reconnect-on-drop handlers (see 1.2).
- `results-service/src/scheduler.ts` — covered against a real Testcontainers Postgres, but no test
  of the cron callback itself throwing, or of duplicate schedule registration on restart.

---

## 2. Per-service findings

### api-service (9 source / 10 test files — best-tested backend service)
- `src/index.ts:276-283` (`tryPublish`) — the catch branch (broker unavailable → user-facing
  message) is never exercised; the mocked `publishTest` is never made to throw.
- `src/queue.ts` — connection error/close/reconnect and the `reconnecting`-flag dedupe for
  concurrent `scheduleReconnect()` calls are untested (see 1.2).
- `src/scripts.ts` — no test for `findExistingScript` DB-error path, or for `/health`'s DB check
  failing independently of the queue check.
- No test for a race on `usedCount` increment from two concurrent requests sharing a cache key.

### ai-service (5 source / 3 test files)
- See 1.1 (`index.ts` untested via real module).
- `generator.ts` — no test of a multi-provider fallback chain where the **primary fails and a
  fallback also fails** (existing tests cover single-provider 429 retry, not chained failures).

### analyser-service (4 source / 3 test files — thorough)
- `aiInsights.ts`'s retry-on-transient-error test does not use fake timers — it sleeps a real 3
  real seconds rather than verifying timer behavior (`setTimeout(...,3000)` at line ~315-317).
- `isAnyProviderConfigured` with a multi-entry `fallbacks` array (primary unconfigured → first
  fallback unconfigured → second fallback configured) is untested.
- No test for a non-`Error` thrown value, or a `SyntaxError` on the *second* attempt specifically.

### recorder-service (5 source / 7 test files — thorough)
- See 1.5 (auto-stop sweep untested).
- `finishSession` is covered only through the manual `/stop` route — its use by the auto-stop
  sweep, and the manual/auto-stop race, are untested.
- `correlator.ts` — no test of a Gemini-provider fallback chain (analogous to the ai-service gap).

### results-service (24 source / 19 test files — largest, mostly well-covered)
- Migrations #15/#16 are included in the aggregate idempotency/sequential-count check
  (`db.test.ts`), but neither has a test asserting its *specific* SQL effect (that the new
  indexes actually exist and are used, or that the error-breakdown columns behave correctly under
  a real query) — only generic idempotency is verified, not migration-by-migration correctness.
- `externalMetrics.ts` has no dedicated test file — only indirect coverage via `consumer.test.ts`'s
  mocked `fetch`. Not tested in isolation: `AbortSignal.timeout(5000)` actually firing, a malformed
  `metrics_endpoint_template`, or the `projectId=null` ("all sources") branch.
- `routes/system.ts` — `/system/live-metric-window` and `/system/health` (distinct from the
  top-level `/health`) have no direct test assertions found.
- `routes/resources.ts` (log-sources, presets, scripts, schedules, webhooks) has no dedicated test
  file — only indirect coverage via `api.test.ts` URLs.
- `helpers.ts` (591 lines, 24 exports) has no dedicated test file — edge cases in individual
  helpers (malformed pagination params, boundary date ranges) aren't independently verified.
- No WebSocket **client**-side reconnect test (server-side broadcast/Redis pub-sub in `ws.test.ts`
  is excellent — one of the most thorough files in the suite — but nothing drives a simulated
  client through a reconnect).
- No DB-pool-under-concurrent-load test.

### worker-backend (5 source / 4 test files)
- `runner.ts` is strong — exit-code matrix, log batching, and SIGTERM→SIGKILL escalation timing
  (fake-timer-based) are all covered.
- `index.ts` — reconnect/backoff loop untested (see 1.2).

### worker-client (5 source / 4 test files)
- `runner.ts` is strong — multi-session averaging, Lighthouse fallback chain, navigation-error/
  page-crash simulation are covered.
- `index.ts` — same AMQP reconnect gap as worker-backend (see 1.2); this is the one gap common to
  both worker services verbatim.

### packages/shared (3 source / 3 test files)
- `aiValidation.ts` (51 lines) has **no test file referencing it at all** — completely untested.
- `createBatcher`/`drainInFlight` (this week's additions) are both well covered.

### UI (51 source files: 15 components + 13 pages + 23 lib / 30 test files, ~57% with a dedicated test)
- ~~`app/settings/page.tsx` — no test file at all~~ — RESOLVED (2026-07-05): `SettingsPage.test.tsx`
  added, 15 tests covering both the non-admin branch (access-required message, setting never
  fetched) and the admin branch (loading/error states, all three window options render, Save
  disabled until a different option is picked, save success/in-flight/error states, error clearing
  on a subsequent successful save). Still not covered at e2e level (see below).
- `lib/api/*.ts` submodules (13 files: `ai.ts`, `apiKeys.ts`, `auth.ts`, `core.ts`, `logSources.ts`,
  `orgs.ts`, `presets.ts`, `recording.ts`, `schedules.ts`, `system.ts`, `teams.ts`, `tests.ts`,
  `webhooks.ts`) have no dedicated unit tests — every consumer test mocks `@/lib/api` wholesale, so
  the real fetch/serialization logic in these files never actually executes under test.
- `app/components/TopBar.tsx` and `lib/useMediaQuery.ts`/`lib/useFetch.ts` are dead code (not
  imported anywhere) — flag for removal rather than writing tests for them.
- `FlowBuilder.tsx` (932-line test file, ~55 `it` blocks, otherwise excellent) — the "extract
  variables from response" feature (add/edit/remove extraction rule, jsonpath vs regex source,
  Gemini-suggested correlation) is never exercised; `ExtractRule`/`ExtractSource` only appear in
  mock stubs.
- `RealtimeChart.tsx` — the per-step `StepLegend` expand/collapse ("show more"/`hiddenCount`) has
  no test; only the aggregate-view legend is checked.
- `Sidebar.tsx` — `member`/`viewer` role-label rendering is untested (only `admin` is exercised).
- No test of `useDarkMode.ts` itself, or that toggling it actually flips
  `document.documentElement`'s class/CSS variables (existing test only clicks the button and
  checks the callback fired).

---

## 3. E2E coverage (11 Playwright specs)

Covered: auth, cancel, compare, flow-builder (client-side), happy-path (backend test + progress),
navigation smoke, recorder session lifecycle, result-detail (baseline/PDF/script/re-run),
schedules+webhooks CRUD, templates/presets.

**Not covered by any e2e spec**, despite the page existing:
- **Chat-based test creation** (`app/chat/page.tsx`) — the entire AI prompt→preview→run flow,
  attachments, and flow-preview mode has zero e2e coverage.
- **Settings page** (admin-only live-metric-window setting) — zero e2e coverage; no spec exercises
  any admin-only UI path.
- **Org management** (`app/org/page.tsx`) — add/remove member, change role, create org.
- **Workspaces** (`app/workspaces/page.tsx`) — create/edit/delete, switch active workspace.
- **Library / script-templates page** (`app/library/page.tsx`) — "use template" → prefilled form.
- **Team page's audit log and quota panel** — schedules-webhooks.spec.ts covers schedules/webhooks
  CRUD but not the rest of `/team`.
- **CSV export** — only the PDF report link is checked anywhere in e2e.

---

## 4. Chaos / fault-injection suite

All 8 claimed fault categories in `chaos/chaos.test.ts` are genuinely implemented as real
assertions (verified line-by-line, not just asserted in the README). Gaps:
- **Redis** has zero fault-injection coverage (not mentioned anywhere in the chaos suite).
- **Disk-full during a k6 run** (worker-backend) — absent.
- **Recorder-service crash mid-recording** — absent (only the happy-path lifecycle is e2e-tested).
- **AI succeeding with a syntactically-broken or unsafe script** — the fallback-chain category
  tests provider *failures*, not a "successful" call that returns garbage.
- **Results-service DB pool exhaustion under concurrent load** — only a single query failure is
  chaos-tested, not pool saturation/timeout.
- **RabbitMQ connection loss itself** — the chaos README explicitly flags this as "not re-tested"
  (G1/G2); only the retry/DLQ decision logic is covered, not actual reconnection behavior.

---

## 5. CI pipeline gaps

- **E2E only runs on `main` branch pushes** (`if: github.ref == 'refs/heads/main'`) — PRs merge
  without any e2e validation.
- **Chaos tests have no dedicated CI step** — they only run because `chaos/**/*.test.ts` matches
  the root `vitest.config.ts` include glob; a chaos failure is indistinguishable from a unit-test
  failure in the CI log, and there's no separate reporting.
- **No coverage threshold** (see 1.4).
- **No scheduled/nightly job** — e2e and chaos only run on push/PR triggers; no cron for drift
  detection between releases.

---

## 6. Test types entirely absent from the repo

- **Visual regression / screenshot testing** — no Percy, Chromatic, Storybook, or
  `toMatchSnapshot` image comparison anywhere.
- **Automated accessibility auditing** — no axe-core/pa11y/jest-axe dependency or usage found.
- **Keyboard-navigation testing** — no `userEvent.tab`/focus-order assertions anywhere in the UI
  test suite.
- **Responsive/mobile breakpoint testing** — no viewport-resize test anywhere.
- **Bundle-size regression testing.**
- **The platform load-testing its own APIs** — no k6 script or CI step targets api-service/
  results-service/worker-backend under load; a notable gap for a load-testing product to have.
- **Mutation testing** — no Stryker or equivalent.
- **Cross-service security test suite** — SSRF checks exist as solid per-service unit tests
  (recorder-service, results-service), but there's no auth-bypass or injection-attempt suite that
  spans multiple services.
- **Snapshot/golden-file testing of AI-generated k6/Puppeteer scripts** — no regression guard
  against the script generator silently changing its output shape.

## 7. Test infrastructure gaps

- `test-support/globalSetup.ts`/`sharedPostgres.ts` provide a shared Postgres-only Testcontainers
  setup. **No shared RabbitMQ container** — the chaos suite explicitly avoids a real broker via a
  `FakeChannel`, so actual AMQP behavior (connection handling, exchange/queue bindings, prefetch)
  is only ever exercised through full docker-compose e2e runs, never in the fast unit/integration
  suite.
- **No shared Redis container** for integration tests.
- Each test file rolls its own `vi.doMock` setup for AI SDKs — no shared AI-provider-mocking
  harness, risking drift/duplication across ~10+ files that each mock Gemini/OpenAI/Anthropic
  slightly differently.

---

## Suggested priority (if picking this up)

1. ~~**1.1**/**1.2** (real-module + AMQP reconnect coverage)~~ — done (2026-07-05).
2. ~~**UI: Settings page**~~ — done (2026-07-05); e2e coverage for it is still open (see below).
3. **CI: e2e-on-every-PR** — cheap process fix, closes a real "shipped a UI regression" risk.
4. **1.3** (contract validation between services) — larger effort, but the AMQP message shape is
   the one thing every service silently depends on.
5. Everything else — pull into `TODO.md` opportunistically; none of it is currently causing
   incidents, all of it was found by inspection, not by a failure.
