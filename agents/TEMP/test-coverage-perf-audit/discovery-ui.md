## ui

### Inventory
- Components (`services/ui/app/components/*.tsx`): AIStatus, ActiveTests, AnalysisPanel, BackendChart, BottomNav, ClientChart, FlowBuilder, FlowStepChart, RealtimeChart, Sidebar, SystemHealth, TopBar, TrendChart, WorkerHealth
- Pages (`app/**/page.tsx`): login, org, page (home), presets, results/compare, results/testId (note: actual dir name is `results/testId`, not `[testId]`), results, schedules, team, webhooks
- lib: api.ts (691 lines), AuthContext.tsx, HealthContext.tsx, ResultsSocketContext.tsx, useResultsSocket.ts, useDarkMode.ts
- src/App.tsx exists (route definitions)

### Existing tests (`__tests__/*.test.tsx`) — CLAUDE.md list is STALE
Actual files present: ActiveTests, AnalysisPanel, AuthContext, FlowBuilder, LoginPage, OrgPage, RealtimeChart, ResultDetail, ResultsSocketContext, Sidebar, SystemHealth, TeamPage, WorkerHealth, home, interpolateLogSourceUrl, results.
(CLAUDE.md's list omits RealtimeChart, ResultDetail, Sidebar, SystemHealth, WorkerHealth, ResultsSocketContext, interpolateLogSourceUrl, FlowBuilder — all of which exist already.)

### Gaps

No test file at all for:
- `app/components/BackendChart.tsx` (109 lines) — pure presentational chart from `BackendMetrics`; moderate value (verify status code grouping / error breakdown rendering, axis config). Medium priority.
- `app/components/ClientChart.tsx` (239 lines) — contains non-trivial pure helpers `getVitalStatus()`, `lhColor()`, `lhCls()` (threshold-classification logic for Core Web Vitals / Lighthouse scores) plus `ScoreGauge`/`InfoRow` subcomponents. HIGH value — these threshold functions are easy to unit test in isolation and are business-logic-bearing (good/needs-improvement/poor classification feeds UI badges).
- `app/components/FlowStepChart.tsx` (68 lines) — bar chart for per-step flow metrics; presentational, low-medium value.
- `app/components/TrendChart.tsx` (64 lines) — trend line chart (p95/LCP across runs); presentational, low-medium value.
- `app/components/BottomNav.tsx` (33 lines) — pure nav, presentational, low value.
- `app/components/TopBar.tsx` (31 lines) — pure nav, presentational, low value.
- `app/components/AIStatus.tsx` (65 lines) — polls `/system/ai-status`; not in CLAUDE.md's listed components but exists. Medium value (status display logic + polling behavior similar to SystemHealth which IS tested).
- `app/schedules/page.tsx` (262 lines) — schedule CRUD + manual trigger; significant form/state logic, NO test. HIGH value.
- `app/webhooks/page.tsx` (425 lines) — webhook CRUD; significant form/state logic, NO test. HIGH value.
- `app/presets/page.tsx` (221 lines) — preset CRUD + load-into-form; NO test. Medium-high value.
- `app/results/compare/page.tsx` (125 lines) — side-by-side diff view; NO test. Medium value.
- `app/results/testId/page.tsx` (714 lines, the result detail page) — PARTIALLY covered by `ResultDetail.test.tsx` (only covers status_message visibility + self-healing poll, ~5 tests). The bulk of this 714-line page (bento grid metric cells, baseline set/clear, PDF download link, log-source "View Logs" buttons, statusCodes table rendering, AI diagnose/insights panels) is untested. HIGH value gap — large surface area with low coverage ratio.
- `src/App.tsx` — route definitions; no dedicated test (routes likely exercised indirectly via Playwright E2E only). Low-medium value for a smoke test (renders without crashing per route).
- `lib/api.ts` (691 lines) — large set of fetch wrappers; no dedicated unit test file. Most are thin fetch wrappers (low value to unit test individually), but any pure transform/parsing helpers inside it (if present) would be good candidates — none found beyond fetch wrappers and type defs.

Components/pages WITH adequate existing coverage (do not duplicate): ActiveTests, AnalysisPanel, AuthContext, FlowBuilder, LoginPage, OrgPage, RealtimeChart, ResultDetail (partial), ResultsSocketContext, Sidebar, SystemHealth, TeamPage, WorkerHealth, home, results (list page), interpolateLogSourceUrl.

### Performance Candidates

(a) Render-performance / large-dataset candidates:
- `RealtimeChart` — `aggregateWindow`-derived live metric points can accumulate over a long-running test (many `LiveMetricPoint`s with `stepMetrics[]`). A render-perf test feeding e.g. 500+ points + 7 steps and asserting render completes within a time budget / doesn't throw would validate the `toKey()`/`labelFor()` per-step line generation doesn't degrade. Existing `RealtimeChart.test.tsx` only tests chart-title logic with small fixtures — no large-dataset case.
- `app/results/page.tsx` — results list renders up to 50 results (per `GET /results` cap) as both a `<table>` (desktop) and stacked cards (mobile); a render test with 50 rows would validate no excessive re-renders, though the API cap limits real-world risk. Lower priority since the cap bounds the dataset size.
- `app/results/testId/page.tsx` — `statusCodes` table (`Object.entries(...).sort()`) and `stepMetrics` rendering (FlowStepChart) could be tested with a large number of status codes / steps (e.g. 20-step flow) for render correctness under larger inputs.

(b) Pure utility/transform function micro-benchmark or unit-test candidates:
- `RealtimeChart.tsx`: `toKey(name)` (line 35, regex sanitization `name.replace(/[^a-zA-Z0-9_]/g, '_')`) and `labelFor(stepNames, prefix, rawName)` (line 37) and `fmtElapsed(iso, startedAt)` (line 15) — all pure, currently untested directly (only indirectly via title-logic tests). Good candidates for fast unit tests; `toKey` especially is called per-step per-render so a micro-benchmark with many step names could be useful but is unlikely to be a bottleneck at realistic step counts (<20).
- `ClientChart.tsx`: `getVitalStatus(key, value)` (line 37), `lhColor(score)` (line 80), `lhCls(score)` (line 83) — pure threshold-classification functions, zero existing coverage, ideal for fast targeted unit tests (not really perf-sensitive but high logic value).
- `FlowBuilder.tsx`: `emptyStep()` (line 35) and `parseHar(raw)` (line 47, HAR import parsing) — `parseHar` is the most perf-relevant pure function in the UI: it parses a HAR JSON blob (potentially large, from browser DevTools exports) into `FlowStep[]`. A micro-benchmark feeding a large HAR (hundreds of entries) to `parseHar` would be the most meaningful "UI performance" test candidate in this codebase. Check existing `FlowBuilder.test.tsx` coverage of `parseHar` — likely covers correctness with small fixtures only, not large-input timing.
- Note: `computeThinkTimes` and `detectDuplicateSteps` mentioned in the task prompt do NOT exist anywhere in the codebase (grep returned no matches) — these were either renamed/removed or never implemented; do not plan tests around them without further verification.
