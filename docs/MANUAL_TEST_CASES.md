# Manual Test Cases — AI Load Testing Platform

**Scope:** End-to-end functional test cases for the platform's UI and supporting services, written for manual execution against a running `docker compose up` environment (`http://localhost:3006`).

**Conventions**
- **Pre:** preconditions that must be true before starting
- **Steps:** numbered actions to perform
- **Expected:** observable result that defines pass/fail
- Priority: **P1** (blocker/critical path), **P2** (important), **P3** (edge case / nice-to-have)

---

## 1. Authentication & Sessions

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| AUTH-01 | Login creates a new project | `SESSION_SECRET` set; project name not yet used | 1. Go to `/login` 2. Enter username + new project name 3. Submit | Redirected to home; `alt_session` HttpOnly cookie set; `GET /auth/me` returns the session payload | P1 |
| AUTH-02 | Login joins an existing project | A project with name X already exists | 1. Login with a different username, same project name X | Login succeeds; user is associated with the same `projectId` as the first user | P1 |
| AUTH-03 | Login validation — empty fields | — | 1. Submit login form with empty username and/or project name | Inline validation error shown; no POST sent / 400 returned | P2 |
| AUTH-04 | Login validation — whitespace-only fields | — | 1. Enter only spaces in username/project name, submit | Rejected as invalid (trimmed empty) | P3 |
| AUTH-05 | Logout clears session | Logged in | 1. Click logout | `alt_session` cookie cleared; subsequent `GET /auth/me` returns 401; redirected to `/login` | P1 |
| AUTH-06 | Unauthenticated access redirects to login | Not logged in, `SESSION_SECRET` set | 1. Navigate directly to `/results/compare` (or any protected route) | Redirected to `/login`; original destination not rendered | P1 |
| AUTH-07 | Session persists across reload | Logged in | 1. Refresh the browser | User remains authenticated; no redirect to login | P2 |
| AUTH-08 | Dev mode (no SESSION_SECRET) bypasses auth | `SESSION_SECRET=""` | 1. Navigate to any page without logging in | All pages accessible; `/auth/login` returns `{ dev: true }` with no cookie | P2 |
| AUTH-09 | Project data isolation | Two distinct projects/users created | 1. Log in as project A, create a test/preset/webhook 2. Log out, log in as project B | Project B does not see project A's resources (results, scripts, presets, schedules, webhooks, log sources) | P1 |
| AUTH-10 | Tampered session cookie is rejected | Logged in | 1. Edit the `alt_session` cookie value (flip a character) 2. Reload | Treated as unauthenticated; redirected to `/login` | P2 |

---

## 2. Test Creation — Backend (k6)

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| BE-01 | Create a basic backend test with valid URL | Logged in, on `/` | 1. Select "⚡ Backend" 2. Enter a valid `https://` URL 3. Click "▶ Run Test" | Test created; navigated to `/results/:testId`; status starts `pending` → `running` → `completed` | P1 |
| BE-02 | URL is required | — | 1. Leave Target URL empty 2. Click Run Test | Inline error "URL is required"; `createTest` not called | P1 |
| BE-03 | Invalid URL format rejected | — | 1. Enter `not-a-url` 2. Submit | Server/client validation error shown (e.g. "Invalid targetUrl — must use http or https") | P1 |
| BE-04 | Description auto-extracts VUs | — | 1. Type `load test with 50 VUs for 2 minutes` in description, blur | Advanced settings auto-opens; "Virtual users" = 50, Duration = 2m | P2 |
| BE-05 | Description auto-extracts duration (seconds & minutes) | — | 1. Try `run for 30 seconds` then `run for 5 minutes` | Duration dropdown selects `30s` then `5m` respectively | P2 |
| BE-06 | Description auto-extracts ramp-up | — | 1. Type `load test 10 VUs ramp up: 30s for 2 minutes` | Ramp-up field populates with `30s` | P3 |
| BE-07 | VU count is capped at 100 | — | 1. Type `load test with 500 VUs` | "Virtual users" input shows capped value `100`, not 500 | P2 |
| BE-08 | Description detects load profile keywords | — | 1. Try descriptions containing `spike`, `soak`, `capacity`, `load` | Matching profile button becomes active in Advanced settings | P2 |
| BE-09 | Manually choose a load profile | — | 1. Open Advanced settings 2. Select Spike / Soak / Capacity / Load | Profile-specific fields appear (e.g. Peak VUs for spike/capacity); selection persists into the submitted payload | P2 |
| BE-10 | Set custom SLO thresholds | — | 1. Open "SLO thresholds" 2. Set p95, avg, error rate 3. Run test | Thresholds sent in payload; result detail later evaluates pass/fail against these custom values, not defaults | P2 |
| BE-11 | Switch to Custom Script mode | — | 1. Toggle "📄 Custom Script" 2. Paste a valid k6 script 3. Run | Test bypasses AI generation, routes directly to worker; script not stored in DB (per spec) | P2 |
| BE-12 | Custom Script size limit | — | 1. Paste a script > 512 KB | Rejected with a clear size-limit error | P3 |
| BE-13 | Description length limit | — | 1. Enter a description > 500 characters | Rejected client-side and/or server-side with a clear message | P3 |
| BE-14 | AI script reuse — cache hit, no description | A script for the same URL+type already exists, description left blank | 1. Run a test against the same URL with empty description | Script reused directly (bypasses AI service); `reused_script: true`; `used_count` increments | P2 |
| BE-15 | AI semantic comparison — REUSE verdict | Existing script + description for URL exists; new description is semantically similar | 1. Submit a similarly-worded description for the same URL | Gemini returns REUSE; cached script used; status messages show progress | P3 |
| BE-16 | AI semantic comparison — REGENERATE verdict | Existing script + description; new description is materially different | 1. Submit a very different description for the same URL | Gemini returns REGENERATE; new script generated and saved | P3 |
| BE-17 | Save and load a preset | Filled-out backend form | 1. Click "Save preset", name it 2. Reload page, select it from "Load from preset…" | Preset saved (incl. URL, VUs, duration, profile, thresholds); selecting it repopulates the form; dropdown resets to placeholder after selection | P2 |
| BE-18 | Re-run a previous test | A completed backend result exists | 1. From results list, click "Re-run" | Navigated to `/?rerun=<id>`; form pre-filled with original URL + description; dismissible banner shown | P2 |
| BE-19 | Environment variables passed to k6 | — | 1. Provide `envVars` (if exposed in UI) with valid `KEY=VALUE` pairs | Variables passed to k6 as `--env`; not persisted to DB | P3 |
| BE-20 | Inline test data table / CSV upload | — | 1. Add rows to the inline data table OR upload a CSV | Data passed to the worker as `testData`/`csvData`, used for parameterization, not stored in DB | P3 |
| BE-21 | HTTP options — HTTP/2 and discard response bodies | — | 1. Open Advanced settings 2. Enable "HTTP/2" and/or "Discard response bodies" 3. Run | `httpOptions: { http2: true, discardResponseBodies: true }` included in the k6 options block of the generated/cached script (`buildK6Options`) | P3 |
| BE-22 | Custom headers — backend test | — | 1. Open Advanced settings 2. Under "Custom Headers" click "+ add", set `X-Api-Key` / `secret123` 3. Run | `options.headers: { "X-Api-Key": "secret123" }` sent in `POST /tests`; generated k6 script merges the header into `params.headers` for every `http.*` call (verify in saved script) | P3 |

---

## 3. Test Creation — Browser (Puppeteer)

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| BR-01 | Create a basic browser test | — | 1. Select "🌐 Browser" 2. Enter URL 3. Run | `type: 'client-side'` test created; runs via worker-client; produces Web Vitals metrics | P1 |
| BR-02 | Description auto-switches type to browser | On Backend tab | 1. Type a description containing `browser`/`puppeteer`/`web vitals`/`lighthouse`, blur | Form switches to Browser type automatically | P2 |
| BR-03 | Sessions & duration controls | — | 1. Open Advanced settings for browser type | Shows "sessions" and "duration" fields (not VUs/profile) | P2 |
| BR-04 | Set INP/TBT SLO thresholds | — | 1. Open SLO thresholds with Browser type selected | INP ms max / TBT ms max inputs appear; defaults of 200/200 included in payload when enabled | P1 |
| BR-05 | No INP/TBT inputs for backend type | Backend type selected | 1. Open SLO thresholds | INP/TBT inputs are NOT shown | P2 |
| BR-06 | Lighthouse scores rendered | Completed browser test | 1. Open result detail | Performance/Accessibility/Best Practices/SEO scores (0–100) displayed | P2 |
| BR-07 | Core Web Vitals displayed | Completed browser test | 1. Open result detail | LCP, FID/INP, CLS, TTFB, FCP, TBT, TTI shown with correct units | P1 |
| BR-08 | Resource breakdown chart | Completed browser test with resource data | 1. Open result detail | Resource Breakdown shows JS/CSS/image/font/XHR sizes; total adds up | P3 |
| BR-09 | Page Health metrics | Completed browser test | 1. Open result detail | JS errors, long task count, DOM node count displayed | P3 |
| BR-10 | Performance score below 50 fails the test | Site with poor Lighthouse performance score | 1. Run a browser test against a slow/heavy page | `perf_status = 'failed'`; threshold violation listed in Analysis panel | P2 |
| BR-11 | Worker-not-running warning | `worker-client` scaled to 0 | 1. Submit a browser test | Status message: "No browser (Puppeteer) worker is running — test will start when a worker comes online" | P3 |
| BR-12 | Custom headers — browser test | — | 1. Select "🌐 Browser" 2. Open Advanced settings 3. Under "Custom Headers" click "+ add", set `X-Api-Key` / `secret123` 3. Run | `options.headers: { "X-Api-Key": "secret123" }` sent in `POST /tests`; generated Puppeteer script calls `page.setExtraHTTPHeaders({...})` before navigation (verify in saved script) | P3 |

---

## 4. Test Creation — Multi-step Flow

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| FL-01 | Build a flow manually | — | 1. Select "🔗 Multi-step Flow" 2. Add 2+ steps with name/URL/method/body/headers 3. Run | Flow test created with `steps[]`; `targetUrl` defaults to `steps[0].url` | P1 |
| FL-02 | Step limit enforced | — | 1. Try adding more than 20 steps | Rejected client-side/server-side with a clear message | P3 |
| FL-03 | Variable extraction rules | — | 1. Add an `extract` rule (jsonpath / header / cookie / regex) on a step | Rule saved; subsequent step can reference `{{variable_name}}`; AI-generated script renders correct extraction code | P2 |
| FL-04 | "Run as" toggle — k6 vs Browser | Flow with 2+ steps | 1. Toggle "Run as ⚡ k6 HTTP" then "🌐 Puppeteer Browser" | k6 mode sends `type: 'flow'`/k6 group script; Browser mode sends `type: 'client-side'` with sessions/duration | P1 |
| FL-05 | Per-step metrics displayed (k6 flow) | Completed k6 flow test | 1. Open result detail | `FlowStepChart` (avg + p95 per step) and `StepMetricsTable` rendered with per-step request counts/failures | P1 |
| FL-06 | Live per-step metrics during run | Running k6 flow test | 1. Watch `RealtimeChart` during execution | One colored line per step across response time / error rate / throughput panels; shared collapsible legend (first 4 + "+N more") | P2 |
| FL-07 | Flow recorder — start/stop recording | recorder-service running | 1. Click "🔴 Record" 2. Interact with the target site in the recorder window 3. Stop | Captured network requests converted to `FlowStep[]` via `toFlowSteps()`; steps populate the builder | P2 |
| FL-08 | Recorder ignore list | Recording in progress | 1. Add a URL pattern to the ignore list | Matching requests excluded from the captured flow | P3 |
| FL-09 | AI correlation suggests extract rules | Recorded flow with chained requests (e.g. login → use token) | 1. Stop recording | `correlator.ts` proposes `ExtractRule`s per step via Gemini; user can accept/edit them | P3 |
| FL-09a | Correlation restores stripped Authorization header | Recorded flow where a later request sends `Authorization: Bearer <token>` from an earlier response | 1. Stop recording | `toFlowSteps()` strips `Authorization` from `step.headers`, but `substituteValue()` re-adds it to the consuming step as `Authorization: Bearer {{access_token}}` (visible in FlowBuilder's "Request headers" section) | P3 |
| FL-14 | Per-step request headers editor | Flow with 1+ steps | 1. On a step, click "+ add" under "Request headers" 2. Set a header name/value (e.g. `X-Auth-Token` / `{{token}}`) | Header saved to `step.headers`; editable/removable; supports `{{varName}}` placeholders for chained values | P3 |
| FL-10 | HAR file import | — | 1. Use "Import HAR" 2. Upload a valid `.har` file | Steps populated from the HAR entries | P3 |
| FL-11 | "Clear all" steps | Flow with multiple steps | 1. Click "Clear all" | All steps removed; confirmation if implemented | P3 |
| FL-12 | Re-run a flow test restores steps | Completed flow result | 1. Click "Re-run" | Steps restored from `steps` JSONB column into the builder | P2 |
| FL-13 | Flow test target URL inference | Steps added without explicit top-level URL | 1. Submit | `targetUrl` defaults to `steps[0].url` per spec | P3 |

---

## 5. Test Execution, Live Monitoring & Cancellation

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| EX-01 | Status transitions visible in real time | New test submitted | 1. Watch the result detail page | Status flows `pending` → `running` → `completed`/`failed` via WebSocket push (no manual refresh needed) | P1 |
| EX-02 | Live metrics chart updates during run | Running backend test | 1. Watch `RealtimeChart` | Response time / error rate / throughput update every ~5s via `test:live` WS events | P1 |
| EX-03 | Countdown timer & progress bar | Running test with `duration_seconds` and `started_at` set | 1. Observe result header | Countdown ticks down; progress bar fills proportionally; elapsed-time X-axis on charts (`Xs`/`XmYYs`) | P2 |
| EX-04 | Status message progress updates | Test going through AI generation | 1. Watch status message area | Sequential messages: "Generating test script with AI…" → (retry messages on 429) → "Script ready — starting test…" → cleared on running | P2 |
| EX-05 | Stale `status_message` hidden on terminal states | A test reaches `failed`/`cancelled` | 1. Open its result detail | The lingering "Script ready — starting test…" message is NOT shown alongside the failure message | P1 |
| EX-06 | Cancel a running test | Soak/long-running test in progress | 1. Click "Cancel" | `cancel-fanout` broadcast received by all worker replicas; status becomes `cancelled`; k6 process SIGTERM → SIGKILL after grace period / browser closed | P1 |
| EX-07 | Cancel a no-op when test already completed | Test just completed | 1. Attempt to cancel | No-op; status remains `completed`; no error surfaced to user | P3 |
| EX-08 | Self-healing poll recovers from missed WS event | Simulate a worker bypassing the broadcast (or disconnect WS mid-run) | 1. Leave the result detail page open | Within ~20s the page re-fetches and displays the correct terminal status even without a WS push | P2 |
| EX-09 | WebSocket reconnect re-syncs state | Network blip / results-service restart | 1. Disconnect/reconnect network while viewing a running test | Client exponential-backoff reconnects (1s→30s cap); emits synthetic `reconnected` event; re-fetches result + live points | P2 |
| EX-10 | Active Tests strip shows running tests | One or more tests running | 1. View any page in the app | `ActiveTests` inline strip lists running tests; updates live via `tests:changed`/`test:status` | P2 |
| EX-11 | Hard execution timeout | Script that runs longer than `K6_MAX_DURATION_MS` / `PUPPETEER_MAX_DURATION_MS` | 1. Submit such a test and wait | Process is SIGTERM'd, then SIGKILL'd after grace period; test marked `failed` | P3 |
| EX-12 | Stale cleanup marks abandoned tests as failed | A test stuck in `running` > `STALE_RUNNING_MINUTES` or `pending` > `STALE_PENDING_MINUTES` | 1. Wait for the cleanup interval (60s) to run | Status flips to `failed`; UI updates via broadcast | P3 |
| EX-13 | Script validation failure surfaces a useful error | AI-generated script has a syntax error | 1. Trigger a generation that yields a broken script | `k6 inspect` exit ≠ 0; captured stderr included in logs/error; test marked failed with diagnosable detail (not opaque exit code) | P2 |
| EX-14 | DLQ retry & exhaustion | Transient failure during script generation/execution | 1. Force 3 consecutive failures | Message retried with incremented `x-retry-count` up to 3, then routed to `<queue>.dlq`; test marked failed with explanatory status message | P3 |
| EX-15 | Live metrics retention cleanup | `live_metrics` rows older than `LIVE_METRICS_RETENTION_DAYS` exist | 1. Wait for / trigger the stale-cleanup interval | Old `live_metrics` rows are purged; recent rows for active/recent tests remain intact; `GET /results/:testId/live` for an old test returns fewer/no points | P3 |

---

## 6. Results — List, Detail, Compare, Trend, Baseline

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| RES-01 | Results list renders correctly | ≥1 completed test | 1. Go to `/results` | Desktop: 2-line table rows (URL+badges, date·rps·p95); Mobile: stacked cards; clicking row navigates to detail | P1 |
| RES-02 | Results list updates live | New test starts/completes while list open | 1. Watch the list | Refetches via `tests:changed`/`test:status` WS events (no manual refresh) | P2 |
| RES-03 | Result detail — bento grid metrics | Completed backend test | 1. Open detail | Metric cells (requests, p50/p95/p99, RPS, error rate) render correctly in the 12-col bento grid | P1 |
| RES-04 | Result detail — Analysis panel | Completed test with threshold violations or regressions | 1. Open detail | `AnalysisPanel` shows perf status badge, listed violations, and diff vs. baseline/previous run | P1 |
| RES-05 | Result detail — script viewer | Completed test with a saved script | 1. Open detail, expand script block | Generated/custom k6 or Puppeteer script displayed; description shown if present | P2 |
| RES-06 | Trend chart across runs | ≥2 completed tests for the same URL | 1. Open detail for the latest | `TrendChart` plots p95 (backend) or LCP (browser) chronologically | P2 |
| RES-07 | Compare two results | ≥2 completed results | 1. Select two from the results list 2. Open compare view | Side-by-side metric diff table (`/results/compare?a=&b=`) renders correctly with deltas | P1 |
| RES-08 | Set / clear baseline | Completed result | 1. Click "Set baseline" 2. Run a new test for the same URL 3. Click "Clear baseline" | Amber "baseline" badge shown; subsequent regression diffs compare against the baseline (not previous run); clearing reverts to previous-run comparison | P2 |
| RES-09 | Regression detection | Baseline exists; new run is >20% worse on a metric | 1. Run a degraded test | `perf_status = 'degraded'`; diff highlighted in Analysis panel | P2 |
| RES-10 | Threshold violation marks test failed | Run violates a configured/default SLO | 1. Open detail | `perf_status = 'failed'`; violated threshold(s) listed explicitly | P1 |
| RES-11 | PDF report download | Completed result | 1. Click "Download report" | A `pdfkit`-generated PDF downloads with correct test metadata and metrics | P2 |
| RES-12 | "View Logs" deep link | A log source configured and matching the result's time window | 1. Click "View Logs" on a result | Opens the external platform (Grafana/Datadog/Kibana/etc.) with `{startedAtMs}`, `{targetUrl}`, `{testId}` etc. correctly interpolated | P3 |
| RES-13 | AI Insights narrative | Completed test, analyser-service reachable | 1. Open detail | Gemini-generated narrative, anomalies, root causes, and recommendations displayed | P3 |
| RES-14 | AI Insights fallback | analyser-service unreachable (12s timeout) | 1. Run a test while analyser-service is down | Falls back to local deterministic analysis; no broken UI state | P3 |
| RES-15 | Empty states | No results / no active tests | 1. View results list / active tests strip on a fresh project | Sensible empty-state messaging, no errors | P3 |
| RES-16 | Failed test shows "no metrics collected" | A test fails before producing metrics | 1. Open its detail | "Test failed — no metrics collected." message shown in place of metric cells; no stale status message lingers (see EX-05) | P1 |
| RES-17 | Cancelled test detail view | A cancelled test | 1. Open its detail | "Test cancelled — no metrics collected." shown; status badge correct | P2 |

---

## 7. Scripts Management

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| SCR-01 | View saved scripts list | ≥1 generated/reused script | 1. Navigate to scripts view (if exposed) / `GET /scripts` | Listed by `used_count DESC` with target URL, type, description | P2 |
| SCR-02 | Delete a saved script | Existing script | 1. Delete it | Removed from DB; next test for that URL/type triggers fresh AI regeneration | P2 |
| SCR-03 | Script reuse increments used_count | Cache-hit path triggered repeatedly | 1. Run the same URL+type+description combo multiple times | `used_count` increments correctly without duplicate inserts (per the documented increment ownership: api-service on bypass, worker-backend on confirmed REUSE) | P3 |

---

## 8. Presets

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| PRE-01 | Create a preset | Filled test form | 1. Click "Save preset", provide a name | Preset stored with type/URL/options/thresholds; appears in dropdown sorted by `used_count DESC` | P1 |
| PRE-02 | Load a preset into the form | ≥1 preset exists | 1. Select from "Load from preset…" | Form fully repopulated; dropdown resets to placeholder afterward | P1 |
| PRE-03 | Preset increments used_count on load | Existing preset | 1. Load it via `GET /presets/:id` (selection) | `used_count` increments; order in dropdown may shift | P3 |
| PRE-04 | Delete a preset | Existing preset | 1. Delete from presets management page | Removed from list and dropdown | P2 |
| PRE-05 | Preset CRUD page | — | 1. Go to `/presets` | List, create, delete all function correctly; validation errors surfaced for bad input | P2 |

---

## 9. Schedules

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| SCH-01 | Create a schedule | — | 1. Go to `/schedules` 2. Create with name, valid cron expression, type, URL, options | Schedule saved; `next_run_at` computed; cron job registered | P1 |
| SCH-02 | Invalid cron expression rejected | — | 1. Submit a malformed cron string | Validation error; schedule not saved | P2 |
| SCH-03 | Manual trigger ("Run now") | Existing schedule | 1. Click manual trigger | POSTs to api-service immediately; `last_run_at` updates; new test appears in active/results list | P1 |
| SCH-04 | Enable / disable a schedule | Existing schedule | 1. Toggle enabled off, then on | Cron job de-registered/re-registered (`removeSchedule`/`reloadSchedule`); `enabled` flag persists | P2 |
| SCH-05 | Edit a schedule | Existing schedule | 1. Change cron expression or options, save | `next_run_at` recalculated; cron registry updated to new schedule | P2 |
| SCH-06 | Delete a schedule | Existing schedule | 1. Delete it | Cron job stopped; removed from list; no further auto-triggers | P2 |
| SCH-07 | Scheduled run appears as auto-triggered | Active schedule fires | 1. Wait for/trigger a scheduled run | New test created via `POST /tests` from results-service; visible in active tests and results | P3 |

---

## 10. Webhooks

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| WH-01 | Create a webhook | — | 1. Go to `/webhooks` 2. Add URL, select events (failed/degraded), optional secret | Webhook saved and listed | P1 |
| WH-02 | Webhook fires on matching perf_status | Webhook configured for `failed` | 1. Run a test that ends with `perf_status = 'failed'` | POST received at the target URL with `{ testId, targetUrl, perfStatus, metrics }`; fire-and-forget (does not block result save) | P1 |
| WH-03 | Webhook does NOT fire on non-matching status | Webhook configured only for `degraded` | 1. Run a `passed` test | No webhook call made | P2 |
| WH-04 | HMAC signature header present when secret set | Webhook with `secret` configured | 1. Trigger a matching event | `X-Webhook-Signature: sha256=<hmac>` header present and verifiable against the payload + secret | P2 |
| WH-05 | Delete a webhook | Existing webhook | 1. Delete it | Removed; no further deliveries | P2 |
| WH-06 | Webhook delivery failure doesn't block result save | Target URL unreachable | 1. Run a matching test | Result still saves successfully; webhook error swallowed (`.catch(() => {})`) | P3 |

---

## 11. Log Sources

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| LOG-01 | Create a log source | — | 1. Add name, platform, URL template with placeholders | Saved; appears as "View Logs" button on relevant results | P2 |
| LOG-02 | Placeholder interpolation correctness | Log source with all placeholder types | 1. Click "View Logs" on a completed result | `{startedAtMs}`, `{completedAtMs}`, `{startedAtISO}`, `{completedAtISO}`, `{targetUrl}`, `{targetUrlEncoded}`, `{testId}` all substituted correctly (encoding applied where specified) | P3 |
| LOG-03 | Delete a log source | Existing log source | 1. Delete it | Removed; "View Logs" button disappears from result detail | P3 |

---

## 12. System Health & Worker Monitoring

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| SYS-01 | System health banner appears on degradation | Stop one dependent service (e.g. ai-service) | 1. Wait up to 15s | Amber dismissible warning strip appears with correct per-service impact text (e.g. "AI (Gemini) unreachable — New tests cannot be started") | P1 |
| SYS-02 | System health banner clears on recovery | Service restarted | 1. Wait for next poll | Banner auto-clears once `/system/health` reports all healthy | P2 |
| SYS-03 | Worker health bars | At least one worker running | 1. View `WorkerHealth` component | CPU/memory/active-test bars render and update via 15s polling | P3 |
| SYS-04 | `/health` deep check (api-service) | — | 1. `GET /health` while DB or RabbitMQ is down | Returns 503 with details on which dependency failed | P2 |
| SYS-05 | `/system/health` aggregation status codes | All services healthy / one degraded | 1. `GET /system/health` in both states | 200 when all OK; 207 when partially degraded; correct per-service breakdown | P3 |
| SYS-06 | AI status indicator | — | 1. Observe `AIStatus` component (60s poll) | Reflects current Gemini reachability/quota status | P3 |

---

## 13. Navigation, Layout & Responsiveness

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| NAV-01 | Sidebar collapse/expand persists | Desktop viewport | 1. Toggle sidebar 2. Reload | State persists via `localStorage`; width animates between 220px ↔ 48px | P3 |
| NAV-02 | Active nav item highlighted | — | 1. Navigate between pages | Current page highlighted with `bg-[#ddf4ff] text-[#0969da]` in sidebar | P3 |
| NAV-03 | Mobile bottom nav & top bar | Mobile viewport (< lg breakpoint) | 1. Resize to mobile width | `BottomNav` (5 tabs, fixed bottom) and `TopBar` (h-10 sticky) shown; sidebar hidden | P2 |
| NAV-04 | Results list responsive layouts | Both desktop and mobile widths | 1. Resize browser | Table view on desktop, card list on mobile; both fully functional | P2 |
| NAV-05 | Quick-stats panel on home page | Desktop, ≥1 result exists | 1. Load `/` | Panel shows today's count, avg p95, pass rate, active tests, recent runs, preset shortcuts | P3 |
| NAV-06 | Charts render consistently | Any result with charts | 1. Inspect chart styling | Horizontal-only gridlines, monospace axis ticks, consistent tooltip style/colors per design tokens | P3 |

---

## 14. Cross-Cutting / Non-Functional

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| XF-01 | API key auth enforcement | `API_KEYS` set (prod-like config) | 1. Call a protected endpoint without `X-API-Key` | 401 returned; `/health` and `/results/pending` remain exempt | P2 |
| XF-02 | CORS restricted to allowed origin | `ALLOWED_ORIGIN` set | 1. Attempt a cross-origin request from a non-allowed origin | Blocked by CORS policy | P3 |
| XF-03 | envVar injection safety | — | 1. Submit `envVars` with invalid keys (e.g. lowercase-with-symbols) or oversized values | Rejected/sanitized per `/^[A-Z_][A-Z0-9_]*$/i`, length caps (key ≤ 64, value ≤ 1024), newline/null stripped | P3 |
| XF-04 | Gemini quota exhaustion handled gracefully | Free-tier quota (20 req/day) exhausted | 1. Trigger AI generation after quota exhausted | Backoff retries (60/120/180s) on 429; clear status message; eventual graceful failure, not a crash | P3 |
| XF-05 | Horizontal worker scaling | `docker compose up --scale worker-backend=3` | 1. Submit several concurrent tests | Load distributed across replicas; cancel-fanout reaches all replicas | P3 |
| XF-06 | HTTPS / TLS in production mode | `docker-compose.prod.yml`, valid `DOMAIN` + DNS | 1. Access via `https://yourdomain.com` | Caddy auto-provisions TLS; subdomain routing correct (`api.`, `data.`); internal ports not exposed | P3 |
| XF-07 | Concurrent multi-user usage | Two browsers logged into different projects | 1. Run tests simultaneously from each | No cross-talk; each sees only their own data and live updates | P2 |

---

## 15. Boundary, Negative & Security Input Validation

Pulled into its own pass because the same handful of input-handling rules (length caps, type coercion, encoding, injection safety) recur across many forms — testing them once per field, systematically, finds more than re-deriving them per feature.

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| SEC-01 | Description — exactly at the 500-char limit | — | 1. Enter a description of exactly 500 characters 2. Submit | Accepted (boundary is inclusive per spec: "≤ 500 chars") | P2 |
| SEC-02 | Description — one over the limit (501 chars) | — | 1. Enter 501 characters 2. Submit | Rejected client-side and/or with a clear 400 from `api-service`; no test created | P2 |
| SEC-03 | targetUrl — disallowed scheme | — | 1. Submit `javascript:alert(1)` or `file:///etc/passwd` as the URL | Rejected by `new URL()` validation — "must use http or https"; no request reaches a worker | P1 |
| SEC-04 | targetUrl — XSS payload in URL | — | 1. Submit `https://example.com/<script>alert(1)</script>` | Stored/rendered safely (React auto-escapes); no script execution anywhere it's later displayed (results list, detail page, compare view, PDF) | P1 |
| SEC-05 | Description — script injection payload | — | 1. Enter `<img src=x onerror=alert(1)>` as the description 2. View it on the result detail page and in the AI Insights narrative | Rendered as inert text everywhere (React JSX escaping); no alert fires; value passed to Gemini prompt as plain text only | P1 |
| SEC-06 | Flow step — header/body injection | — | 1. In a flow step, enter a header value containing `\r\nX-Injected: true` or a body with a NoSQL/SQL-style payload (`' OR '1'='1`) | Treated as literal data passed to k6/Puppeteer; no header-splitting, no unexpected query execution; values appear verbatim in the generated script | P2 |
| SEC-07 | Steps array — exactly 20 steps | — | 1. Build a flow with exactly 20 steps 2. Submit | Accepted (boundary inclusive: "steps ≤ 20") | P3 |
| SEC-08 | Steps array — 21 steps rejected | — | 1. Build a flow with 21 steps 2. Submit | Rejected with a clear validation message; no test created | P2 |
| SEC-09 | Custom script — exactly at 512 KB | — | 1. Paste/upload a script of exactly 512 KB | Accepted | P3 |
| SEC-10 | Custom script — over 512 KB | — | 1. Paste a script slightly larger than 512 KB | Rejected with a clear size-limit message before it reaches RabbitMQ | P2 |
| SEC-11 | envVar key — invalid characters rejected | — | 1. Provide `envVars` with a key like `my-key!` or `123KEY` | Rejected/stripped per `/^[A-Z_][A-Z0-9_]*$/i`; not passed to the k6 `spawn` call | P2 |
| SEC-12 | envVar value — control characters stripped | — | 1. Provide a value containing `\n` or `\0` | Stripped before being passed as a `--env` flag; no shell/argument injection | P2 |
| SEC-13 | envVar — oversized key/value | — | 1. Provide a key > 64 chars or a value > 1024 chars | Truncated or rejected per the documented caps; no crash in worker-backend | P3 |
| SEC-14 | Webhook URL — SSRF probe | — | 1. Create a webhook pointing at an internal address (e.g. `http://169.254.169.254/`, `http://localhost:5432`, `http://rabbitmq:15672`) | Either rejected at creation or fails safely at delivery time without exposing internal data; document actual behavior if no SSRF guard exists (compare with the documented SSRF protection on recorder-service — confirm whether webhooks/log-sources have equivalent protection) | P1 |
| SEC-15 | Log source URL template — placeholder injection | — | 1. Create a log source whose `urlTemplate` embeds a placeholder inside another URL component unexpectedly (e.g. `https://logs.test/{targetUrl}"><script>`) | `{targetUrl}` / `{targetUrlEncoded}` substitution does not allow breaking out of the URL or injecting markup when rendered as a link | P3 |
| SEC-16 | Numeric fields reject non-numeric input | — | 1. Try entering letters/symbols into VUs, duration, sessions, peak VUs, threshold fields | Input rejected or coerced safely; no `NaN`/`undefined` reaches the submitted payload | P2 |
| SEC-17 | Negative / zero numeric values | — | 1. Enter `0` or a negative number into VUs, duration, sessions | Rejected or clamped to a sane minimum; no test submitted with nonsensical load parameters | P2 |
| SEC-18 | Unicode / emoji in free-text fields | — | 1. Enter emoji and multi-byte Unicode (e.g. `🚀 测试 — load test`) into description, preset name, schedule name, webhook secret | Stored and displayed correctly everywhere (no mojibake); DB round-trip preserves the exact string (UTF-8) | P3 |
| SEC-19 | API key auth — wrong/missing key in prod-like config | `API_KEYS` set | 1. Call `POST /tests` with a missing or incorrect `X-API-Key` | 401 returned; no test created; `/health` remains accessible without a key | P1 |
| SEC-20 | Session cookie absent on protected internal routes | `SESSION_SECRET` set | 1. Call `POST /results/pending`, `/results/:id/running`, `/results/:id/fail`, `/results/:id/message` without a session cookie | These remain accessible (documented as exempt from session middleware for internal worker→results-service calls); other routes still require a session | P2 |
| SEC-21 | Schedule cron — injection-style strings | — | 1. Enter a cron field containing shell metacharacters (e.g. `* * * * * ; rm -rf /`) | Rejected as an invalid cron expression by `node-cron` validation; never reaches a shell | P2 |
| SEC-22 | File upload — non-HAR / non-CSV content | — | 1. Upload a `.exe` or arbitrary binary renamed to `.har`/`.csv` | Rejected with a parse error; no crash, no attempt to execute the file | P3 |

---

## 16. AI-Assist & Productivity Features

These are Gemini-backed "✨" helper actions layered on top of the core flows — found by diffing this suite against `ai-endpoints.test.ts`, `translate.test.ts`, and the recorder `correlator.test.ts` automated coverage, which exercise the service-level logic in isolation. The cases below verify the **UI wiring, empty/error states, and end-to-end behavior** that those unit/integration tests can't see.

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| AIX-01 | Suggest settings from URL + type | On home page, URL filled in | 1. Click "✨ Suggest settings" | Button shows "⏳ Analysing…"; on success, VUs/duration/profile (or sessions/duration for browser) are populated and a reasoning note is shown below the button | P2 |
| AIX-02 | Suggest settings — error surfaced inline | Gemini unreachable / quota exhausted | 1. Click "✨ Suggest settings" | Error message rendered in place of the reasoning note (not a silent failure or crash) | P3 |
| AIX-03 | Suggest SLO thresholds from run history | ≥2 completed runs exist for the current URL+type | 1. Open SLO thresholds 2. Click "✨ Suggest" | Threshold fields populated; note reads "Based on N runs — <reasoning>" | P2 |
| AIX-04 | Suggest thresholds — insufficient history | <2 completed runs for this URL+type | 1. Click "✨ Suggest" | `GET /results/suggest-thresholds` returns 422; UI shows a clear "not enough history" style message, not a generic error | P2 |
| AIX-05 | AI-suggested preset name on save | Form filled out | 1. Click "Save preset" | `suggestPresetName` is called; on success the preset is saved with the AI-suggested name and the UI shows "✓ Saved as: <name>" with tag chips | P3 |
| AIX-06 | Translate a Playwright script to k6 | Backend type, Custom Script mode | 1. Click "✨ Translate Playwright" 2. Upload a valid `.js`/`.ts` Playwright script | Button shows "⏳ Translating…"; on success the translated k6 script populates the Custom Script textarea (markdown fences stripped) | P2 |
| AIX-07 | Translate — oversized script rejected | — | 1. Upload a Playwright script > 256 KB | `POST /translate` returns 400; UI shows "Translation failed: …" inline, custom script box left untouched | P3 |
| AIX-08 | Translate — Gemini unavailable | `GEMINI_API_KEY` unset or Gemini errors | 1. Attempt a translation | 503 (key unset) or 500 (Gemini error) surfaced as "Translation failed: …"; `translating` state resets so the control is usable again | P3 |
| AIX-09 | Diagnose errors with AI | Completed test with failed/erroring requests | 1. Open result detail 2. Click "✨ Diagnose with AI" | Shows "⏳ Diagnosing…", then a list of error diagnoses (likely cause + suggestion per diagnosis group) | P2 |
| AIX-10 | Diagnose — no errors present | Completed test with zero failed requests | 1. Click "✨ Diagnose with AI" | Returns an empty diagnoses list; UI shows "No actionable diagnoses found." (not an error) | P3 |
| AIX-11 | Diagnose — unknown test id | — | 1. Hit the diagnose endpoint for a non-existent testId (e.g. via direct API call) | `GET /results/:testId/diagnose` returns 404 | P3 |
| AIX-12 | Summarise trend with AI narrative | ≥3 completed runs exist for the URL (trend has ≥3 points) | 1. Open result detail 2. Click "✨ Summarise trend" | Shows "⏳ Analysing trend…", then renders a narrative paragraph describing the trend direction and notable points | P3 |
| AIX-13 | Trend narrative — insufficient data points | <3 trend points for this URL | 1. Click "✨ Summarise trend" | `POST /ai/trend-narrative` returns 422; button/section communicates that more runs are needed rather than failing silently | P3 |
| AIX-14 | Natural-language → cron expression | On `/schedules`, creating/editing a schedule | 1. Type a phrase like `every weekday at 9am` into the cron-phrase input 2. Press Enter or click convert | Shows converting state; on success the cron field is populated and a "✓ <human-readable preview>" line is shown; phrase input clears | P2 |
| AIX-15 | Cron conversion — invalid/empty phrase | — | 1. Submit an empty phrase, or one Gemini can't parse (e.g. `asdf qwer`) | `POST /ai/cron` returns 400 for missing phrase; for unparseable phrases the preview area shows "Error: …" without crashing the form | P3 |
| AIX-16 | Cron conversion — Gemini unavailable | `GEMINI_API_KEY` unset | 1. Attempt conversion | 503 surfaced as an inline error; existing cron field value (if any) is left untouched | P3 |
| AIX-17 | Webhook noise prediction on create | On `/webhooks`, creating a new webhook | 1. Fill in URL and select events 2. Observe below the form | Shows "✨ Checking noise level…" then either an amber "⚠ <noisy message>" or an informational "ℹ <ok message>"; warning only shown when `warning` is truthy | P2 |
| AIX-18 | Webhook noise — healthy distribution | Target URL/project has a healthy pass/fail run distribution | 1. Configure a webhook for `failed`/`degraded` events on that URL | Returns `level: 'ok'`; no amber warning shown (or an informational note only) | P3 |
| AIX-19 | Webhook noise — missing events | — | 1. Trigger the noise check with no events selected | `POST /ai/webhook-noise` returns 400 when `events` is missing; UI does not display a stale/incorrect warning | P3 |
| AIX-20 | Suggest parameterization columns (FlowBuilder) | Multi-step flow with ≥1 step built | 1. In the inline data table area, click "✨ Suggest columns" | On success, suggested column names are added to the data table (existing rows preserved) and an alert/summary shows the columns + reasoning; no-op when Gemini suggests zero columns | P2 |
| AIX-21 | Suggest columns — missing steps | — | 1. Trigger the suggestion with an empty steps array (e.g. directly via API) | `POST /ai/param-suggestions` returns 400 when `steps` is missing | P3 |
| AIX-22 | AI suggests step names after recording | A flow has just been recorded/stopped with generic "Step N: METHOD /path" names | 1. Stop the recording | Correlator's `suggestStepNames` proposes more descriptive names per step; original steps retained if Gemini returns the wrong array length, non-JSON, or throws | P3 |
| AIX-23 | AI suggests ignore patterns post-recording | A recording just completed, with some noisy third-party domains captured | 1. Review the post-recording panel | "✨ Suggested ignore patterns for next recording" lists candidate domain strings the user can adopt for the next session; section absent when Gemini returns an empty/unparseable list | P3 |
| AIX-24 | Duplicate step detection in FlowBuilder | A recorded/imported flow contains repeated hits to the same endpoint with varying query params | 1. Open the FlowBuilder with such a flow loaded | "✨ Duplicate steps detected" banner appears, naming the common path and the varying query parameter key, grouping all duplicates together; steps with different HTTP methods on the same path are NOT flagged as duplicates | P3 |

---

## Test Data & Fixtures (for fast, repeatable execution)

Use these ready-made values to avoid improvising data mid-run (and to make failures reproducible):

**Target URLs**
- ⚠️ **`https://httpbin.org/get` is NOT a reliable backend/load-test target** — confirmed during execution (2026-06-08) that it returns `503` on essentially 100% of requests as soon as more than ~2 connections hit it concurrently (verified independently with 8 parallel `curl`s outside the platform: all 8 returned 503, while sequential single requests returned 200). Any backend/flow test run against it with `vus ≥ 2` will show `errorBreakdown.serverError ≈ 100%` and `perf_status: failed` — this is the *target* misbehaving, not the platform (the analyzer/AI-insights pipeline correctly classifies it as "100% error rate / total service outage"). Prefer an internal test app (e.g. a tiny local Express/Fastify echo service in `docker-compose`) or a load-test-friendly public target (e.g. `https://test-api.k6.io`) for BE/FL smoke and regression cases — reserve `httpbin.org` only for single-VU/serial smoke checks (`vus: 1`) where its 200 response can be observed.
- Slow/heavy page for Lighthouse degradation cases (BR-10, RES-10): a known image-heavy public page or a locally-hosted "slow" fixture page
- Multi-step flow target: an app with a login → authenticated-action chain (needed for FL-03/FL-09 extract-rule scenarios)

**Descriptions (for `applyDescriptionParams` extraction cases BE-04…BE-08)**
- `load test with 50 VUs for 2 minutes`
- `run for 30 seconds`
- `spike test with 10 users, ramp up: 15s`
- `soak test for 1 hour`
- `browser test measuring web vitals on the homepage`

**Boundary strings**
- Exactly 500 chars: `'A'.repeat(500)` — generate via browser devtools console: `'A'.repeat(500)`
- Exactly 501 chars: `'A'.repeat(501)`
- 512 KB script: any valid minimal k6 script padded with a trailing comment block to exactly 524288 bytes

**Cron expressions**
- Valid: `*/5 * * * *` (every 5 minutes — useful for SCH-03 manual-trigger-then-wait verification)
- Invalid: `* * * *` (4 fields), `99 * * * *` (out-of-range minute)

**Webhook test receivers**
- Use a request-bin style endpoint (e.g. a locally-run HTTP echo server) so WH-02/WH-04 payload and signature can be inspected without depending on third-party uptime

---

## Execution Log — Bugs Found & Fixed (2026-06-08 live run)

Ran BE-01 / BR-01 / FL-01 against the live `docker compose up` stack. Two real issues surfaced (both fixed in this pass):

1. **`FLOW_PROMPT` generated unguarded chained-extraction code, silently erasing later steps from `stepMetrics`** — `services/ai-service/src/generator.ts`
   - Repro: created FL-01 with two plain steps (`Get homepage` → `Get headers`, **no** `extract` rules defined by the user). Gemini still wrote `vars.origin = res.json().origin;` inside Step 1's group (per the unconditional "Chain variables between steps" instruction in `FLOW_PROMPT`'s Requirements list — this fires regardless of whether `hasExtractions` is true). The MANDATORY defensive-extraction guardrail (`exec.vu.abort` + null-check) is only injected when the *user* explicitly defines `extract` rules, so this Gemini-initiated chaining had zero protection.
   - When the target (`httpbin.org`) returned `503` with a non-JSON body, `res.json()` threw, the iteration aborted before reaching `group('Step 2: Get headers', ...)`, and the result's `stepMetrics` silently contained **only Step 1** (485/485 reqs) — Step 2 never appears anywhere, with no error surfaced to the user. `FlowStepChart`/`StepMetricsTable` would render an incomplete, misleading per-step breakdown with no indication that a step was skipped.
   - **Fix**: added an unconditional Requirements line to `FLOW_PROMPT` instructing Gemini that chained extraction must be defensive — guard with a status check or `try/catch`, fall back to a default value, and never let a parse failure abort the rest of the iteration. See `services/ai-service/src/generator.ts` (Requirements section, after "Chain variables between steps…").
   - Re-test FL-05/FL-06 after this fix by running a flow against a target that returns non-2xx/non-JSON mid-flow (e.g. point step 2 at a 404 URL) and confirm **all** steps still appear in `stepMetrics`/`FlowStepChart`.

2. **Pre-existing typo in `generator.test.ts`: asserted `exec.test.abort` instead of `exec.vu.abort`** — `services/ai-service/src/__tests__/generator.test.ts:70-77`
   - The test "includes exec.test.abort instructions when any step has extractions" asserted on `exec.test.abort`, but the actual (and correct — per the surrounding code comment "stops only the failing VU, not the entire test") generated instruction is `exec.vu.abort`. This test was failing on `main` before any of today's changes — confirmed via `git stash` + re-run. `exec.test.abort()` would abort the *entire* k6 test run, which is the opposite of the documented/intended per-VU-only abort behavior.
   - **Fix**: corrected the test name and assertion to `exec.vu.abort`. All 30 generator tests pass now (`npx vitest run services/ai-service/src/__tests__/generator.test.ts`).

3. **RES-16: stale `worker-backend` Docker image producing `status='failed'` rows with `completed_at IS NULL` and a stale `status_message`** — deployment issue, not a source-code bug
   - Repro: created a backend test against an unresolvable domain whose AI-generated script failed `k6 inspect` validation (exit 255 — syntax/runtime error in the script's init scope, an AI-output-dependent failure mode). The resulting row showed `status='failed'`, `completed_at=NULL`, and `status_message="Script ready — starting test…"` (the last progress message ai-service posted before handing off) — i.e. exactly the "no metrics collected, but looks like it never properly finished" anomaly RES-16 describes. Found 4 such rows accumulated in the live DB across two days, all with this identical signature.
   - Root cause (confirmed via live `log_statement='all'` SQL capture + `docker compose exec worker-backend grep ... dist/index.js`): the **running `worker-backend` container was executing a stale compiled build** — `dist/index.js` contained an old `updateStatus(testId, status)` helper that wrote `UPDATE test_results SET status = $1 WHERE test_id = $2` directly via raw SQL on the `catch` path (`await updateStatus(test.id, 'failed').catch(() => {})`), bypassing `completed_at`/`status_message` entirely and never broadcasting a `test:status` WebSocket event. The **current source** (`services/worker-backend/src/index.ts`) had *already* been refactored (as an uncommitted working-tree change) to call `notifyFailed`/`notifyRunning`/`notifyCancelled`, which go through results-service's REST endpoints (`POST /results/:id/fail|running|cancel`) — those endpoints correctly set `completed_at = NOW()`, clear `status_message = NULL`, and broadcast the WebSocket event. The Docker image had simply never been rebuilt after that refactor landed in source, so the container ran the old direct-SQL code path. Confirmed via `docker inspect` that the image (`LastTagTime: 2026-06-07T09:02:51Z`, created `2026-06-06T22:49:00Z`) predated the relevant source changes.
   - **Fix**: `docker compose build worker-backend && docker compose up -d --no-deps worker-backend` — rebuilt and redeployed from current source. Verified via `grep` on the new container's compiled `dist/index.js` that it now calls `notifyRunning`/`notifyFailed`/`notifyCancelled` (no `updateStatus`/`setStartedAt` raw-SQL helpers remain). Re-ran the exact repro (junk domain → `k6 inspect` validation failure) post-redeploy: the new row correctly shows `status='failed'`, `completed_at` **populated**, `status_message` **NULL** — anomaly does not reproduce. The 4 pre-existing anomalous rows remain in the DB as historical evidence (all `created_at` predate the redeploy at 2026-06-08 ~13:54 UTC).
   - **Lesson for future deploys**: after any `worker-backend`/`worker-client` source refactor, always `docker compose up --build <service>` (not just edit source) — a stale image silently runs old logic with no build-time signal that source has diverged. Consider adding a startup log line that prints a build hash/timestamp to make this divergence detectable from `docker compose logs` alone.
   - **Companion fix — `/results/:testId/message` race guard** (`services/results-service/src/app.ts`): independently of the stale-image issue, the endpoint had no status guard — `UPDATE test_results SET status_message = $1 WHERE test_id = $2` would happily overwrite `status_message` on a test that had *already* reached a terminal state, e.g. if a delayed ai-service progress POST (`"Script ready — starting test…"`) arrived after `/fail`/`/running`/`/cancel` had already cleared it to `NULL`. This is a second, narrower path to the exact same "stale `status_message` on a finished test" symptom RES-16 describes (though it would never produce the `completed_at IS NULL` half of the signature). **Fix**: added `AND status NOT IN ('failed', 'completed', 'cancelled')` to the `UPDATE` (the endpoint still returns `{success:true}` to preserve ai-service's fire-and-forget contract — the write is just a silent no-op once the test is done). Added regression test `'does NOT overwrite status_message once the test has reached a terminal state (RES-16 race guard)'` to `services/results-service/src/__tests__/api.test.ts` (all 9 `/message` tests pass). **Deployed and verified live**: rebuilt + redeployed `results-service`, confirmed the guard string is present in the running container's compiled `dist/app.js:220`, and confirmed functionally — `POST /results/<failed-test-id>/message` returns `{"success":true}` but leaves the existing `status_message` ("Script ready — starting test…" on row `6582c0b3…`) untouched rather than overwriting it with the new payload.

**Non-bug finding** — `https://httpbin.org/get`, the doc's previously-recommended demo target (line ~310), returns `503` on ~100% of requests under even light concurrency (verified independently: 8 parallel `curl`s outside the platform → all 8 got 503, sequential single requests got 200). BE-01/FL-01 both correctly reported `perf_status: failed` with accurate `errorBreakdown`/AI-insights ("100% error rate / total service outage") — the analyzer pipeline handled this correctly; the *target* is simply unsuitable for concurrent load testing. Test-data appendix above updated with a safer recommendation.

---

## Execution Log — SEC checks (2026-06-08, continued live run)

Ran SEC-03 / SEC-04 / SEC-19 against the live stack (post worker-backend redeploy). All pass / correctly scoped:

- **SEC-03 (disallowed URL scheme) — PASS.** `POST /tests` with `targetUrl: "javascript:alert(1)"` and `targetUrl: "file:///etc/passwd"` both returned `{"error":"Invalid targetUrl — must use http or https"}` (no test row created, no queue message published); a control `https://example.com` request succeeded normally. `new URL()` validation in `api-service/src/index.ts` works as documented.
- **SEC-04 (XSS payload in URL) — PASS.** Submitted `targetUrl: "https://example.com/<script>alert(1)</script>"` — accepted (valid `https://` URL with a literal `<script>` path segment, correctly NOT scheme-rejected), stored verbatim in `target_url`, and returned as-is via `GET /results/:testId`. Confirmed via `grep -rn "dangerouslySetInnerHTML|innerHTML|document.write"` across `services/ui/app`, `services/ui/lib`, `services/ui/src` — **zero matches**. Every place `targetUrl` is rendered (results list, detail page, compare view) goes through JSX `{}` interpolation, which React auto-escapes to text; no raw-HTML sink exists anywhere in the UI codebase, so stored XSS via `targetUrl` is not exploitable.
- **SEC-19 (API key auth enforcement) — NOT APPLICABLE in this environment.** Confirmed `API_KEYS` is empty in both `api-service` and `results-service` containers (`docker compose exec <svc> printenv API_KEYS` → empty), which by design disables the `X-API-Key` check entirely (`CLAUDE.md`: "Empty `API_KEYS` disables auth entirely — safe for local dev"). Proved the check is fully bypassed: a request with a valid session cookie *and* a deliberately wrong header (`X-API-Key: clearly-bogus-wrong-key-xyz`) succeeded (`200`, test created) — the key is never even inspected. The 401-on-bad-key path this case describes can only be exercised by running with `docker-compose.prod.yml` (or otherwise setting `API_KEYS`); this dev compose stack intentionally never sets it. Re-run SEC-19 against a prod-like config (`API_KEYS=somekey docker compose -f docker-compose.yml -f docker-compose.prod.yml up`) to actually exercise the 401 path.

---

## Suggested Execution Order (smoke pass before full regression)

1. AUTH-01, AUTH-05, AUTH-06 (can you get in/out and is it gated?)
2. BE-01, BR-01, FL-01 (one happy path per test type)
3. EX-01, EX-02, EX-05, EX-06 (lifecycle + the two bugs fixed this session)
4. RES-01, RES-03, RES-07, RES-16 (can you see and compare results?)
5. SYS-01 (does the platform tell you when something's wrong?)
6. SEC-03, SEC-04, SEC-19 (the security checks most likely to catch a real hole fast)
7. AIX-01, AIX-09, AIX-14 (one "✨" AI-assist control per major surface — settings, diagnosis, scheduling)

Then proceed through the remaining sections by priority (P1 → P2 → P3) for full regression coverage.
