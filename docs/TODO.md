# TODO.md — AI Load Testing Platform

Improvements, suggestions, and large future work items.

## Manual Testing

- [ ] Manually test log integration
- [ ] Manually test script recording
- [ ] Manually test correlation
- [ ] Manually test client-side testing

## AI Enhancement Roadmap

### 🔴 High impact — implement now
- [x] **AI-1: Smart threshold suggestions** — `✨ Suggest` button in SLO panel; calls `/results/suggest-thresholds`; fills p95/avg/errorRate from run history via Gemini
- [x] **AI-2: Auto-name flow steps** — Automatic after recording stops; Gemini renames `Step N: POST /path` → `Authenticate — get bearer token`
- [x] **AI-3: Ignore-list suggestions after recording** — Blue banner after recording stop with detected analytics/CDN domains + one-click "Add all to Ignore list"
- [x] **AI-4: Error root-cause classification** — `✨ Diagnose with AI` button in Error Breakdown card; shows likely cause + next step per error category

### 🟡 Medium impact — implement next
- [x] **AI-5: Cron natural-language assistant** — Text input + `✨ Convert` button under cron field in Schedules; `POST /ai/cron` → Gemini → fills cron expression + preview
- [x] **AI-6: Playwright → k6 translator** — `✨ Translate Playwright` file-upload button in Custom Script mode; `POST /translate` on ai-service → Gemini → drops k6 script into textarea
- [x] **AI-7: Regression narrative across runs** — `✨ Summarise trend` button on Trend chart card; `POST /ai/trend-narrative` → Gemini → 2-sentence summary shown below chart
- [x] **AI-8: PDF executive summary** — Auto-generated 3-sentence executive paragraph at top of every PDF report; non-fatal if Gemini unavailable
- [x] **AI-9: Optimal VU/duration recommendation** — `✨ Suggest settings` link below URL field; `GET /results/suggest-settings` → Gemini → fills VUs, duration, profile in Advanced settings
- [x] **AI-10: Parameterisation suggestions in FlowBuilder** — `✨ Suggest columns` button in Test data section; `POST /ai/param-suggestions` → Gemini → pre-fills column headers

### 🟢 Low impact — implement later
- [x] **AI-11: Alert noise prediction** — Noise check fires when toggling webhook events; `POST /ai/webhook-noise` → Gemini analyses run history → amber warning or confirmation shown inline
- [x] **AI-12: Think-time suggestion from recording** — `computeThinkTimes()` derives ms gaps from request timestamps; meaningful pauses (>500ms) shown as `⏱ 1.2s` hints next to each step in FlowBuilder
- [x] **AI-13: Step deduplication after recording** — `detectDuplicateSteps()` identifies same-endpoint steps with varying query params; yellow banner in FlowBuilder with merge suggestion
- [x] **AI-14: Preset name + tag auto-suggestion** — On "Save preset", `POST /ai/preset-name` → Gemini → auto-fills name + shows tag chips; non-fatal fallback to description/URL

### 🆕 New ideas — not yet prioritized
- [ ] **AI-15: Fallback to another provider (OpenAI/Claude API)** — solves the single-point-of-failure problem on Gemini and looks like a more mature architecture; needs a pluggable provider abstraction so script generation/insights/etc. can retry against OpenAI or Claude when Gemini is rate-limited or unreachable
- [ ] **AI-16: Better prompt engineering** — add more k6/Puppeteer pattern examples to the system prompts (BACKEND_PROMPT/CLIENT_PROMPT/FLOW_PROMPT) to improve generated-script quality and consistency

## High Priority (Tech Debt)

- [x] **Rate limiting (Redis — priority #1)** — Wire up Redis; add `@fastify/rate-limit` to api-service and results-service to protect Gemini API and REST endpoints
- [x] **Recorder-service test coverage** — recorder.test.ts (262 lines), correlator.test.ts (302 lines), api.test.ts (385 lines)
- [ ] **Playwright → Puppeteer converter** — New converter-service or ai-service endpoint; UI file upload; AI translation from Playwright to Puppeteer syntax
- [ ] **noVNC auth in production** — Add VNC password (`x11vnc -passwd`) to recorder-service docker-entrypoint.sh; restrict port 6080 binding to localhost in docker-compose.prod.yml
- [x] **AMQP reconnect: replace bounded retry with unbounded backoff supervisor (G1 — chaos)** — `connectWithBackoff()` added to `@alt/shared` (capped exponential backoff, 1s → 2s → … → 30s cap, never gives up); all 5 queue-connected services (api-service, ai-service, worker-backend, worker-client, results-service) now use it for both the initial connect and reconnect-on-close, so the platform self-heals after a RabbitMQ outage of any length without operator intervention
- [x] **FlowBuilder: recording session lost on page reload/navigation** — `recording` state (session id/status) is now persisted to `localStorage` (`flowRecordingSession`) on every change; on mount, an in-progress (`active`/`stopping`) session is restored and `GET /recordings/:id` is called to resume polling, import steps if already completed, or clear stale state on 404/expiry
- [ ] **results-service consumer.ts: missing AMQP close handler + false-positive health (G2 — chaos)** — `consumer.ts` has no `connection.on('close')` handler; during RabbitMQ outage the health endpoint reports `queue:ok` (false positive) and the consumer never reconnects; add close handler with same backoff supervisor and make health check reflect actual channel state
- [ ] **e2e templates.spec.ts: preset dropdown not visible after save+reload** — `e2e/templates.spec.ts` ("saves a template and loads it back via the dropdown") fails on CI: `page.locator('select').first()` is not visible after `page.reload()` following "Save preset". The preset `<select>` only renders when `presets.length > 0` (`services/ui/app/page.tsx`); `handleSavePreset` awaits `suggestPresetName()` (Gemini `/ai/preset-name`) before `createPreset()`/`getPresets()` — likely not finished within the test's 1500ms wait before reload. Needs live debugging (docker compose up) to confirm root cause; fix is likely either waiting on the actual `createPreset` network response in the spec, or reordering/decoupling the AI name-suggestion call from the save flow.

## Medium Priority (Feature Gaps)

- [x] **Dark mode** — 🌙/☀ toggle in Sidebar; CSS vars override via `.dark` class; localStorage persistence; falls back to OS preference
- [x] **Multi-tenancy (full)** — org → teams → members hierarchy (`organizations`, `org_members`, `projects.org_id`); per-team API keys (`team_api_keys`, `/teams/:id/api-keys`); role-based access (admin/member/viewer) + org roles (owner/admin/member); team-scoped dashboards, results, scripts, schedules, webhooks, and presets; invite/remove members; team switcher in Sidebar; org admin panel (`/org` page)
- [x] **Quota management** — Per-team resource limits: max concurrent tests, max test duration, max VUs, max scheduled tests, Gemini API calls per day; quota tracking in PostgreSQL (`team_quotas` + `gemini_usage` tables); enforcement in api-service before queuing; quota usage dashboard in UI (`/team` page "Usage & Limits"); admin override via `PUT /teams/:id/quotas`
- [ ] **k6 script library** — Browse and reuse community k6 scripts from the UI
- [x] **Alerting integrations** — Format selector on webhooks: Generic JSON / Slack attachment / PagerDuty Events API v2 / OpsGenie Alert API; migration #4 adds `format` column
- [x] **HAR replay improvements** — Extended static-asset filter (adds mp4/mp3/pdf/map/xml/avif/cjs/mjs + MIME-type check); cap raised to 50; shows count of filtered entries
- [ ] **Worker auto-scaling** — Docker Swarm or Kubernetes HPA based on queue depth
- [ ] **Worker-offline signal on AI-routed path (G4 — chaos)** — When a test is queued via ai-service (new script needed), api-service does not check worker consumerCount after the ai-service forwards to the worker queue; the "no worker running" warning is only posted on the direct bypass path; extend the consumer-count check to cover the AI-routed path so users get the warning regardless of routing
- [ ] **parseDurationSeconds accepts numeric values (G5 — chaos)** — Passing a numeric `duration` (e.g. `10`) to `parseDurationSeconds` throws a 500; should coerce number to string before parsing or accept both types
- [x] **GET /results UI pagination** — Load more button using `nextBefore` cursor; appends to existing list; WebSocket updates still work on first page
- [ ] **Download/upload ignore-pattern lists** — Export the recorder-service "Ignore list" (domains/patterns) as JSON and re-import it before starting a new recording, so users can reuse a curated ignore list across recordings/projects

## Data Privacy Gaps

- [x] **PII detection/redaction before sending recorded traffic to Gemini** — `redactPII()`/`detectPII()` in `@alt/shared`; applied to `requestBody`/`responseBody` in `recorder-service/correlator.ts` before building the correlation prompt (emails, SSNs, phone numbers, Luhn-valid credit card numbers, IPv4 addresses)
- [ ] **Encryption at rest for PostgreSQL** — `test_results`, `test_scripts`, target URLs, and recorded flow steps are stored in plaintext; investigate column-level encryption (e.g. `pgcrypto`) or full-disk/volume encryption for production deployments
- [ ] **Data retention / right-to-erasure (GDPR)** — `test_results` and `live_metrics` accumulate indefinitely with no expiry; add a configurable retention period (auto-purge old rows) and an admin endpoint to delete all data for a team/user on request
- [ ] **Audit log for data access** — No record of who viewed/exported/deleted test results, scripts, or PDF reports; add an `audit_log` table capturing user, action, resource, and timestamp for compliance-sensitive deployments

## Low Priority (Polish)

- [ ] **recorder-service image size** — Reduce ~60 MB from xvfb + x11vnc + novnc APK packages
- [ ] **Gemini rate limit UI** — Show remaining daily quota in SystemHealth strip
- [ ] **Test result export** — CSV export of metrics in addition to PDF
- [ ] **Custom k6 threshold validation** — Preview threshold violations before running test
- [ ] **Flow step ordering drag-and-drop** — Replace up/down buttons in FlowBuilder

## Architecture Improvements

- [ ] **Redis pub/sub for WebSocket** — Replace in-process Set<WebSocket> to support horizontal scaling of results-service
- [x] **Database read replica** — `readPool` in db.ts (falls back to primary when `READ_DATABASE_URL` unset); all heavy GET endpoints use `rPool`; `docker-compose.replica.yml` overlay for PostgreSQL streaming replication
- [ ] **RabbitMQ persistence** — Enable durable queues and message persistence for production reliability
- [x] **OpenTelemetry tracing** — `tracing.ts` in all 7 services; auto-instruments Fastify/pg/amqplib/fetch/k6; `test.id` span attribute; exports to Tempo via `OTEL_EXPORTER_OTLP_ENDPOINT`; disabled with `OTEL_SDK_DISABLED=true`
- [x] **worker-client TTFB accuracy** — Now uses `performance.getEntriesByType('navigation')[0].responseStart - requestStart` via `page.evaluate()` — excludes DNS/TCP/TLS/settle time

## Future Features

- [ ] **RUM (Real User Monitoring)** — collect vitals from real end users via an injected script snippet; report LCP, INP, CLS, TTFB back to results-service for comparison with synthetic test results

## MEGA Features (requires deep investigation)

- [ ] **Mobile application performance testing** — investigate approaches: Appium/WebDriverIO for native apps, cloud device farms (AWS Device Farm, BrowserStack), network throttling profiles, mobile-specific metrics (frame rate, battery, memory on device), Android/iOS instrumentation
- [ ] **Natural language "one prompt" test creation** — user describes entire test scenario in a single prompt; AI infers type (backend/browser/flow/mobile), extracts URL, steps, load profile, SLOs, env vars, and submits the full test without the user touching the form
- [ ] **Enterprise version with local LLM model** — investigate self-hosted/on-prem LLM (e.g. Ollama, vLLM, local Llama/Mistral/Qwen) as a drop-in replacement for Gemini for enterprise customers who can't send code/data to external APIs; needs a pluggable model-provider abstraction (`GEMINI_MODEL` → generic `AI_PROVIDER`/`AI_MODEL`), evaluation of script-generation quality vs. Gemini, GPU/resource sizing guidance, and config docs for air-gapped deployments
