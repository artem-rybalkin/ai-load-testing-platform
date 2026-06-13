# Discovery: worker-backend & worker-client — Coverage Gaps & Performance Candidates

## worker-backend

Source files (excluding `__tests__`, `logger.ts`, `tracing.ts`):
- `services/worker-backend/src/index.ts`
- `services/worker-backend/src/parser.ts`

Existing tests:
- `parser.test.ts` — `parseK6Output` (full output, unit conversions µs/s, threshold-violation output, empty output, no-http output, missing fail line, large counts); `aggregateWindow` (empty, metric-only, vus/duration/error aggregation, malformed lines, rps calc, zero error/rps, vus-only); `parseK6Errors` (status code counting, timeout/network categorization, empty input, malformed lines, no-status points, multi-status, unknown error_code catch-all); `parseK6GroupMetrics` (empty, no-group, single group, name stripping, root group skip, multi-group, p95 calc, requestsFailed avg calc, durations-length fallback, malformed lines, single-item p95).
- `index.test.ts` — `saveScript` (REUSE path increments used_count/no INSERT; new-script path INSERT with description/projectId, COALESCE on conflict, null defaults); `handleRetry` (retry increments, missing header, DLQ routing at/over MAX_RETRIES); `validateScript` (exit 0 resolve, non-zero reject with stderr, no-stderr message, 2000-char truncation, spawn error); `notifyRunning/notifyFailed/notifyCancelled` (correct POST URLs, fetch error swallowing).

### Gaps

1. **`parser.ts` — `parseK6JsonOutput` / `parseK6All` not directly tested as a unit returning all three fields together.** Existing tests call `parseK6Errors` and `parseK6GroupMetrics` separately (both wrap `parseK6All`), but no test asserts the combined `{ statusCodes, errorBreakdown, stepMetrics }` shape from a single call, nor that a single pass correctly produces non-overlapping data for status codes AND step metrics from the same input set (mixed grouped + ungrouped points in one payload).

2. **`parser.ts` — `parseK6Output` percentile fallback (`p(50)` → `med=`) only tested for p50.** No test covers a malformed/missing `http_req_duration` line entirely (function should return 0 for avg/p50/p95/p99 — only "no http_ metrics" case is tested, not "http_req_duration line present but malformed/no avg=").

3. **`parser.ts` — `aggregateWindow` per-step (`stepMetrics`) branch is UNTESTED.** All existing `aggregateWindow` tests use ungrouped points. No test exercises `durationsByGroup`/`countByGroup`/`failedByGroup` → `stepMetrics: LiveStepMetric[]` output (lines 191-198), including the `errorRate` per-step calc and `rps` per-step calc with `LIVE_WINDOW_SEC`.

4. **`index.ts` — `runK6Test` is entirely untested** (the core orchestration: spawning k6, writing data files, `validateScript` failure → `rm` cleanup, live-metric polling via `readAndPost`/`aggregateWindow` integration, `MAX_TEST_DURATION_MS` SIGTERM/SIGKILL timer, exit-code handling for 0/99/other, `cancelledTests` interplay). This is the largest untested surface — currently only sub-pieces (`saveScript`, `handleRetry`, `validateScript`, notify helpers) are tested via re-implemented inline copies, not the real exported function.

5. **`index.ts` — main `channel.consume(QUEUE, ...)` handler untested**: cancelled-before-execution skip (DB status check), cancelled-during-execution path, `scriptSaveKey` derivation (`scriptCacheKey` vs `targetUrl`), result payload composition (`reusedScript`, `thresholds`, `projectId` passthrough), and the catch/`notifyFailed`/`handleRetry` error path.

6. **`index.ts` — `/health` endpoint untested** (DB check failure → `degraded`, queue disconnected, `saturated` when `activeTests >= WORKER_CONCURRENCY`, metrics block shape). worker-client has a dedicated `health.test.ts`; worker-backend has none.

7. **`index.ts` — envVar sanitization regex (`SAFE_KEY` filter for `--env` args) is untested.** No test verifies invalid keys/values (newlines, `\0`, length > 64/1024, non-matching key pattern) are stripped before being passed to k6.

8. **`index.ts` — RabbitMQ reconnect logic (`connection.on('close')` → `reconnectTimer` → `start()` retry) is untested**, though this mirrors similar patterns elsewhere in the codebase that may already have coverage conventions to follow.

### Performance Candidates

`parser.ts` functions process k6 JSON output line-by-line and are prime micro-benchmark candidates — k6 with high VU counts / long durations can emit tens of thousands of JSON lines:

- **`parseK6JsonOutput` / `parseK6All`** (single-pass parser, lines 58-126): benchmark with synthetic k6 JSON output at **1,000 / 10,000 / 100,000 lines**, mixing `http_reqs`, `http_req_duration`, `http_req_failed` points across multiple groups (e.g. 5-10 step groups) to exercise `durationsByGroup`/`countByGroup`/`failedByGroup` accumulation + the final `Object.entries(...).map()` + per-group `sort()` for p95. The `sorted = [...durations].sort(...)` per group (line 114) is O(n log n) per group and repeats for every group — worth profiling with large per-group duration arrays (e.g. a single long-running step accumulating 50k+ duration points).
- **`parseK6Errors`** and **`parseK6GroupMetrics`** — both thin wrappers over `parseK6All`; same input-size benchmarks apply (they internally re-run the full parse, so a benchmark could also confirm whether calling both back-to-back on the same content — as some flows might — duplicates work, vs. the single `parseK6JsonOutput` entry point already used in `index.ts`).
- **`aggregateWindow`** (lines 151-207): called every `LIVE_INTERVAL_MS` (2s) on the *incremental* new lines since last read — typically small (one 2-second window of points), so less critical, but worth a benchmark at **500-2,000 lines** (high-VU test producing many points per 2s window) to ensure the per-window `sort`-free aggregation (uses `avg`/`max`, no sort) stays cheap. Also exercise the `stepMetrics` branch (lines 191-198) with 5-10 groups.
- **`getAvg`/`getPercentile`/`getCount`/`getRate`/`getFailRate` regex matching in `parseK6Output`** (lines 10-39): each compiles a `new RegExp(...)` per call against the full text summary output. Text summary output is small/bounded (k6 CLI summary, not per-line JSON), so this is lower priority — but worth confirming output size stays bounded regardless of test duration/VUs (k6 summary format doesn't grow with request volume).

---

## worker-client

Source files (excluding `__tests__`, `logger.ts`, `tracing.ts`):
- `services/worker-client/src/index.ts`
- `services/worker-client/src/retry.ts`

Existing tests:
- `retry.test.ts` — `handleRetry`: republish with incremented retry count (0→1, existing→+1, missing header→0), header preservation, DLQ routing at MAX_RETRIES (3), always-acks behavior, queue/dlq name passthrough, content preservation.
- `health.test.ts` — health endpoint built in isolation (not the real exported handler): 200/ok when connected+not saturated, 503/degraded when queue disconnected, 503/saturated when `activeTests >= workerConcurrency`, 200 when below concurrency, metrics block shape (memoryMb/memoryPercent/activeTests/maxTests/cpuPercent).

### Gaps

1. **`index.ts` — `runClientTest` is entirely untested.** This is the core function: Puppeteer launch, multi-session loop, CDP `Performance.enable`, `page.goto` with `NAV_TIMEOUT_MS`, TTFB calc via Navigation Timing, Web Vitals collection (`PerformanceObserver` for LCP/FID/CLS/FCP/INP/longtask — the in-browser `page.evaluate` callback itself is unreachable from Node-side unit tests but the surrounding orchestration is), resource breakdown collection, Lighthouse integration (score extraction, TBT/TTI/INP/dom-size audit parsing, non-fatal try/catch), final metrics composition (`avgNum`, `avgResourceBreakdown`, INP fallback logic `lhInp ?? avgNum('inp')`), and `killTimer`/`runningBrowsers` cleanup in `finally`.

2. **`index.ts` — `avgResourceBreakdown()` (lines 240-250) is the per-session metric aggregation function requested for review.** It is a pure-ish function (closes over `snapshots`) but completely untested: no test for empty `snapshots`, all-undefined `resourceBreakdown`, single session, multi-session averaging with rounding to 1 decimal (`Math.round(... * 10) / 10`), or partial sessions (some with `resourceBreakdown`, some without — `valid` filter).

3. **`index.ts` — `avgNum()` (lines 235-238) untested.** Rounding to 2 decimals (`Math.round(... * 100) / 100`), behavior with `snapshots.length === 0` (division by zero → `NaN`), and the INP fallback chain (`avgNum('inp') > 0 ? avgNum('inp') : undefined`) combined with `lhInp ?? ...` (line 253) — no test confirms Lighthouse INP takes precedence or that PerformanceObserver INP of exactly 0 yields `undefined` not `0`.

4. **`index.ts` — health endpoint is tested only via a re-implemented isolated copy** (`health.test.ts` rebuilds `buildHealthApp` rather than importing the real `startHealthServer`/handler) — same pattern gap as worker-backend but at least a test exists here; worker-backend has none at all.

5. **`index.ts` — main `channel.consume(QUEUE, ...)` handler untested**: `postMessage`-driven status updates, cancelled-during-execution skip, result payload (`thresholds`, `projectId` passthrough), and the catch path that calls `/results/:id/fail` only when `retryCount >= MAX_RETRIES` before `handleRetry`.

6. **`index.ts` — cancel consumer (`channel.consume(cancelQueue, ...)`) untested**: `runningBrowsers.get(testId)` → `browser.close()` + `cancelledTests.add()`.

7. **`index.ts` — `killTimer` hard-timeout (`MAX_TEST_DURATION_MS`) behavior untested**: browser.close() called after timeout, `runningBrowsers` cleanup in `finally` even on error paths.

8. **`retry.ts` — coverage is solid** (mirrors worker-backend's pattern); no significant gaps found here.

### Performance Candidates

worker-client has no k6-style line-by-line JSON parsing (that's worker-backend's domain). The per-session aggregation functions are lightweight (operate on `sessions` array, typically 1-10 entries — bounded by `options.sessions`), so they are NOT good candidates for large-input micro-benchmarks in the same sense as `parser.ts`. However:

- **`avgResourceBreakdown()` / `avgNum()`** — could still get a small benchmark/regression test at **sessions = 1, 10, 50** (even though `sessions` is realistically small, a test confirms O(n) behavior and correct rounding doesn't degrade) — but this is more of a correctness/edge-case gap (see Gaps #2-3) than a true performance concern.
- No other CPU-heavy candidates identified; the heavy lifting (page rendering, Lighthouse) happens inside the browser/Lighthouse process, not in worker-client's own Node code.
