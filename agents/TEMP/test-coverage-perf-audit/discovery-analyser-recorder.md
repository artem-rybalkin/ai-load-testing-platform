# Discovery: analyser-service & recorder-service — Coverage Gaps & Performance Candidates

## analyser-service

### Source files
- `src/index.ts` — Fastify app: `GET /health`, `POST /analyse` (orchestrates `analyzeResult` + `generateAiInsights`)
- `src/analyzer.ts` — thin re-export of `analyzeResult`/`AnalysisResult`/`MetricDiff`/`PerfStatus` from `@alt/shared`
- `src/aiInsights.ts` — `generateAiInsights`, `buildPayload`, `formatMetrics`, `buildPrompt` (internal, not exported)

### Existing tests
- `analyzer.test.ts` (44 tests) — exhaustively covers `analyzeResult` thresholds (backend/client/Lighthouse/error-breakdown), regression boundaries, custom SLOs. This is testing the re-exported `@alt/shared` function, not anything analyser-service-specific.
- `aiInsights.test.ts` (18 tests) — covers `generateAiInsights` happy path, missing API key, JSON parse errors, 429/rate-limit, retry-then-succeed, prompt content checks (targetUrl, threshold violations text). Internal helpers (`buildPayload`, `formatMetrics`, `buildPrompt`) are exercised only indirectly via prompt-content assertions, not unit-tested directly.

### Gaps
1. **`src/index.ts` `POST /analyse` endpoint has ZERO tests.** No file tests the Fastify app/route directly:
   - No test that `POST /analyse` wires `analyzeResult()` output + `generateAiInsights()` output into the combined `AnalysisResult` + `geminiRateLimited` response shape.
   - No test for the `aiInsights` field being omitted when `generateAiInsights` returns `null` (the `...(aiInsights ? { aiInsights } : {})` spread).
   - No test for `GET /health` (checks `gemini: 'configured'` vs `'missing_key'` based on `GEMINI_API_KEY`).
   - No test exercising `externalMetrics` passthrough from request body to `generateAiInsights`.
   - No integration test using Fastify's `.inject()` (pattern used elsewhere e.g. results-service `api.test.ts`).

2. **`buildPayload` (aiInsights.ts) client-type branch is under-tested.** Existing aiInsights tests appear to focus on backend-shaped metrics for prompt-content assertions; the `ClientPromptMetrics` branch (lcp/fcp/ttfb/fid/cls + lighthouse fields) and its `formatMetrics` client-side rendering path likely lack a dedicated assertion. Should verify with a targeted test that for `type: 'client'` metrics, `formatMetrics` produces the LCP/FCP/TTFB/FID/CLS lines and (when present) the Lighthouse line.

3. **`topStepsByP95` capping/sorting logic untested.** `buildPayload`'s backend branch sorts `stepMetrics` by `p95ResponseTime` descending and slices to top 5 — no test confirms (a) sorting order, (b) the 5-item cap, or (c) the rounding of `avgResponseTime`/`p95ResponseTime`. This is exactly the known tech-debt item (`AnalysisPromptPayload`, CLAUDE.md) — it was implemented but the capping/sorting behavior has no direct unit test.

4. **`errorRatePct` zero-division guard (`total = m.requestsTotal || 1`)** — not directly asserted in aiInsights tests (analyzer.test.ts covers this for `analyzeResult` itself but not for `buildPayload`'s independent calculation).

5. **`externalMetrics` section of the prompt** (`buildPrompt`'s `externalSection`) — check whether a test asserts the external-observability text block is included/excluded correctly when `externalMetrics` is empty vs populated.

### Performance Candidates
1. **`analyzeResult` (re-exported, lives in `@alt/shared`)** — threshold + regression computation runs on every `/analyse` call. With `stepMetrics` arrays for flow tests (up to dozens of steps), this is a candidate for a micro-benchmark measuring throughput at varying `stepMetrics.length` (e.g. 1, 10, 50, 200 steps) to ensure linear (not worse) scaling.
2. **`buildPayload` + `buildPrompt` (aiInsights.ts)** — directly named in CLAUDE.md tech debt as the "AnalysisPromptPayload" item. Benchmark candidate: measure prompt-string construction time and resulting prompt length for large `stepMetrics[]` (the sort+slice to top-5 by p95) and large `diffs[]`/`thresholdViolations[]` arrays, to validate token-bound behavior holds under worst-case input sizes (e.g. 500-step flow test).
3. **`formatMetrics`** — string-building loop over `topStepsByP95` and `diffs`; cheap individually but worth including in the same benchmark as #2 since it runs on every `/analyse` call regardless of AI availability.

---

## recorder-service

### Source files
- `src/index.ts` — Fastify app (`buildApp`): `GET /health`, `POST /recordings/start`, `GET /recordings/:id`, `POST /recordings/:id/stop`, `GET /viewer/:id`, `DELETE /recordings/:id`; also SSRF URL validation (`validateRecorderUrl`, not exported) and `completedResults` TTL cache
- `src/recorder.ts` — `compileIgnorePatterns`, `computeThinkTimes`, `toFlowSteps`, `startSession`, `stopSession`, `shouldSkip` (internal), CDP event wiring
- `src/correlator.ts` — `detectCorrelations`, `suggestStepNames`, `suggestIgnorePatterns`, `detectDuplicateSteps`, `correlatorRateLimited`, plus internal helpers `buildSummary`, `getByPath`, `extractValue`, `substituteValue`, `applyCorrelations`

### Existing tests
- `recorder.test.ts` — `compileIgnorePatterns` (12 tests), `toFlowSteps` (13 tests incl. cap/filter/header-stripping), `computeThinkTimes` (6 tests incl. 10s cap), `detectDuplicateSteps` (7 tests). `startSession`/`stopSession`/CDP event handlers (`shouldSkip`, `Network.requestWillBeSent`, `Network.responseReceived`, `Network.loadingFinished`) are NOT covered here.
- `correlator.test.ts` — `detectCorrelations` (early returns, happy path, response parsing, applyCorrelations edge cases, `{{varName}}` substitution — ~20 tests), `suggestStepNames` (5 tests), `suggestIgnorePatterns` (6 tests). Internal helpers `getByPath`/`extractValue`/`substituteValue` are exercised only indirectly through `detectCorrelations`'s substitution tests.
- `api.test.ts` — full Fastify route coverage via `buildApp()` with mocked `startSession`/`stopSession`/`detectCorrelations` etc: `/recordings/start` (4), `/recordings/:id` GET (5), `/recordings/:id/stop` (5), `/recordings/:id` DELETE (3), `/viewer/:id` (6), `/health` (1), completedResults cache (2).

### Gaps
1. **`validateRecorderUrl` (index.ts, SSRF blocklist) has NO direct unit test.** It's only reachable via `POST /recordings/start` with a `targetUrl`, and `api.test.ts`'s "navigates to targetUrl" test likely uses a benign URL — no test appears to assert the 400 rejection for blocked hostnames (`localhost`, `*.internal`, `metadata.google.internal`) or private IPv4 ranges (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x). This is a security-relevant gap: `BLOCKED_HOSTNAME_RE` and `PRIVATE_IPV4_RE` regex correctness (e.g. boundary `172.32.x.x` should NOT match, `172.16.x.x`/`172.31.x.x` SHOULD) is untested.

2. **`shouldSkip` (recorder.ts) is not unit-tested directly.** Only reachable via CDP event handlers inside `startSession`, which itself isn't tested (Puppeteer-dependent, likely intentionally skipped/mocked at a higher level). The three skip conditions (`SKIP_SCHEMES`, `SKIP_EXTENSIONS`, `SKIP_CONTENT_TYPES`, user `ignorePatterns`) and their regex edge cases (e.g. URL with query string after extension, case sensitivity) have no isolated tests.

3. **`startSession`/`stopSession` and the CDP event pipeline (`Network.requestWillBeSent`, `Network.responseReceived`, `Network.loadingFinished`) are entirely untested** — no mocked-CDPSession test exercises the request/response correlation logic (`pending` Map, `responseHeaders` Map, JSON body capture via `Network.getResponseBody`). This is the core data-capture path and currently has zero coverage; `api.test.ts` mocks `startSession` away entirely.

4. **`getByPath`/`extractValue`/`substituteValue` (correlator.ts internals)** — covered only via `detectCorrelations` integration tests with mocked Gemini responses. Edge cases like `getByPath` with array-index paths (`data.items[0].id`), nested objects returning non-primitive (returns `undefined` per code), or malformed paths could use direct unit tests, though integration coverage is reasonably thorough already.

5. **`/recordings/:id/stop` error/partial-failure interplay** — `api.test.ts` has "still returns steps when stopSession throws", but does it cover the case where `detectCorrelations` AND `suggestIgnorePatterns` BOTH run concurrently via `Promise.all` and one rejects? `suggestStepNames`/`suggestIgnorePatterns` internally catch their own errors and return safe defaults, so likely fine — but worth confirming `Promise.all` doesn't short-circuit on a real throw from either.

6. **`GET /health` `gemini: correlatorRateLimited ? 'rate_limited' : 'ok'`** — `api.test.ts` "returns ok with active session count" — check whether the `rate_limited` branch (when `correlatorRateLimited` module-level flag is `true`) is tested; this flag is mutated as a side effect by `detectCorrelations`/`detectCorrelations` error path, making test isolation tricky (shared module state across tests).

### Performance Candidates
1. **`toFlowSteps` (recorder.ts)** — runs on every captured request set, capped at `FLOW_STEPS_CAP = 50`, with per-step header filtering (`SKIP_HEADERS` Set lookup) and URL parsing. Benchmark candidate: measure time to process 50/100/500 `RecordedRequest[]` (pre-cap) to confirm the `.slice(50)` happens early enough that header-stripping/URL-parsing cost doesn't scale with input size beyond the cap.
2. **`computeThinkTimes`** — similar shape to `toFlowSteps`, same cap; cheap but pairs naturally with #1 in a combined benchmark of the "stop recording" pipeline.
3. **`detectDuplicateSteps`** — O(n) grouping by `(method, origin, pathname)` plus per-group `URLSearchParams` parsing and `Set` construction for varying-key detection. With up to 50 steps this is small, but worth a benchmark if larger flows (manually-built, not just recorded) are anticipated — grouping is `O(n)`, varying-key detection is `O(n × paramKeys)`.
4. **`buildSummary` (correlator.ts)** — slices to 20 requests, does header filtering via regex + `responseBody.slice(0, 2000)` per request before JSON.stringify. Not Gemini-bound itself; could be benchmarked as the "non-AI bottleneck" before each `detectCorrelations` call, though at 20 items it's unlikely to be significant — low priority compared to #1.
5. **`applyCorrelations`** — per-correlation `extractValue` + `substituteValue` (string `.split().join()` over body/headers). Could be benchmarked with many correlations × large response bodies (e.g. JWT-sized strings) to check substitution cost doesn't blow up with step count × body size.

**Overall priority ranking for perf work**: `analyzeResult`/`buildPayload` (analyser-service, stepMetrics scaling — directly tied to CLAUDE.md tech debt) > `toFlowSteps`/`computeThinkTimes` (recorder-service, capped at 50 but worth confirming cap-then-process ordering) > others (lower priority, small N in practice).
