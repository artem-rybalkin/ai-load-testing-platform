# AI Features — AI Load Testing Platform

All AI functionality in one place. Structured for presentation use.

---

## Overview

The platform uses **Google Gemini AI** (`gemini-3.1-flash-lite` by default, configurable via `GEMINI_MODEL` env var) as its default AI provider across **4 services** for **18 distinct AI-powered capabilities**, with a pluggable provider abstraction that supports OpenAI and Anthropic as an admin-configured primary or fallback (see [Model configuration & multi-provider fallback](#model-configuration--multi-provider-fallback) below). Every AI call is lazy (user-triggered or event-triggered), non-fatal (graceful fallback when quota is exceeded), and surfaced to the user with a clear indicator.

---

## 1. Test Script Generation

**Service:** `ai-service`  
**When it runs:** When a new test is created and no cached script exists  
**Quota cost:** 1 Gemini call per new test description

### What it does

Converts a plain-English description into a complete, executable load test script — no coding required.

| Test type | Input | Output |
|-----------|-------|--------|
| **Backend (k6)** | Description + URL + load profile | k6 JS script with VUs, stages, thresholds, checks |
| **Browser (Puppeteer)** | Description + URL + session count | Puppeteer script with Web Vitals collection |
| **Multi-step Flow (k6)** | Description + ordered steps with URLs/methods | k6 script with `group()` per step, variable chaining, correlation |

### Smart script reuse

Before generating, the platform checks if a cached script exists for the same URL. If yes, it calls Gemini to compare descriptions:

- **REUSE** → re-inject k6 options into the cached script (no generation, saves quota)
- **REGENERATE** → call Gemini for a new script

### Key prompt engineering

- Flow scripts use `group('Step N: name', fn)` for per-step metrics
- Extraction rules (auth tokens, IDs) use `exec.vu.abort()` on failure — only the failing VU stops, not the entire test
- Parameterisation: generates `SharedArray` + `open('./data.json')` or `open('./data.csv')` when test data is provided

---

## 2. Performance Analysis & AI Insights

**Service:** `analyser-service`  
**When it runs:** Automatically after every completed test  
**Quota cost:** 1 Gemini call per completed test (fallback: deterministic analysis only)

### Two-layer analysis

**Layer 1 — Deterministic (always runs):**
- Threshold checks: p95 < 1000ms, avg < 500ms, error rate < 1%
- Regression detection: compares vs baseline or previous run
- Status: `passed` / `degraded` (>20% worse) / `failed` (threshold exceeded)

**Layer 2 — AI Insights (best-effort):**

| Field | Description |
|-------|-------------|
| **narrative** | 2-3 sentences interpreting what the results mean for system health |
| **anomalies** | Specific patterns detected (e.g. "high p99/p95 gap suggests occasional GC pauses") |
| **rootCauses** | Engineering inferences from the data pattern |
| **recommendations** | Concrete, actionable next steps (e.g. "Profile DB queries > 500ms") |
| **severity** | `critical` / `warning` / `info` |

Shown in a collapsible **AI Insights panel** on the result detail page.

---

## 3. Flow Recording Intelligence

**Service:** `recorder-service`  
**When it runs:** After the user stops a recording session  
**Quota cost:** Up to 3 Gemini calls per recording (names + ignore patterns + correlations)

### 3a. Correlation Detection

Identifies tokens/IDs that flow from a response into later requests — so the k6 script can chain them automatically.

**Example:** `POST /auth/token` response contains `access_token` → subsequent requests use it as `Authorization: Bearer ...` header → Gemini detects this and adds an extract rule to the token step.

Supports: JSON body (`$.access_token`), response headers, cookies, regex patterns.

**Restoring stripped auth headers:** `toFlowSteps()` strips sensitive request headers (`Authorization`, `Cookie`, etc. — see `SKIP_HEADERS` in `recorder.ts`) from `FlowStep.headers` to avoid hardcoding stale tokens. When a correlation is found, `substituteValue()` checks the *raw* recorded request headers (still available via `RecordedRequest.headers`) for the literal value — if found, it re-adds the header to the consuming step's `FlowStep.headers` with the `{{varName}}` placeholder (e.g. `Authorization: Bearer {{access_token}}`), so the chained token is visible and editable in FlowBuilder's "Request headers" section.

### 3b. Human-Readable Step Naming

Renames mechanical step names to descriptive labels:

| Before | After |
|--------|-------|
| `Step 7: POST /ugp-api/auth/oauth/v5/token` | `Authenticate — get bearer token` |
| `Step 12: GET /ugp-api/bag/v1/count` | `Load shopping cart count` |
| `Step 20: GET /ugp-api/browse/v1/category/womens` | `Browse women's category` |

### 3c. Ignore-List Suggestions

After recording, analyses all captured domains and identifies analytics, CDN, and tracking hosts:

```
✨ Suggested ignore patterns for next recording:
  analytics.google.com  cdn.clarity.ms  s7d2.scene7.com
  [+ Add all to Ignore list]
```

### 3d. Step Deduplication Detection

Pure function (no Gemini). Identifies steps calling the same endpoint with varying query parameters:

```
⚠ Duplicate steps detected
  Steps 5, 8, 12 all call the same /category endpoint with different id values.
  Consider keeping one step and parameterising it with test data.
```

### 3e. Think-Time Hints

Pure function (no Gemini). Derives realistic inter-step pauses from actual browser timestamps:

```
Step 1: GET /homepage
Step 2: POST /auth/token  ⏱ 1.4s    ← observed think time
Step 3: GET /dashboard    ⏱ 0.8s
```

---

## 4. Smart Test Configuration

**Service:** `results-service` (queries history + calls Gemini)

### 4a. VU/Duration Recommendation (AI-9)

Entry point: `✨ Suggest settings` link below the URL field on the New Test form.

Checks run history for the URL and recommends:
- **VU count** — based on past successful loads
- **Duration** — appropriate for the test goal
- **Profile** — `load` / `spike` / `soak` / `capacity`
- **Reasoning** — one sentence explaining the choice

### 4b. SLO Threshold Suggestions (AI-1)

Entry point: `✨ Suggest` button in the SLO thresholds section.

Analyses the last 10 completed runs for that URL and suggests realistic-but-meaningful thresholds:

```
Based on 8 runs — p95 typically runs ~320ms; suggesting p95 < 500ms, 
avg < 180ms, error rate < 0.5%
```

---

## 5. Error Diagnosis

**Service:** `results-service`  
**Entry point:** `✨ Diagnose with AI` button inside the Error Breakdown card (lazy — only shown when error count > 0)

Classifies each error category with a likely engineering cause and a next step:

| Category | Count | Likely cause | Next step |
|----------|-------|-------------|-----------|
| serverError (5xx) | 15 | Backend overloaded under concurrent load | Scale horizontally or profile slow endpoints |
| timeout | 5 | Connection pool exhaustion | Increase connection pool size |

---

## 6. Trend & Regression Analysis

**Service:** `results-service`  
**Entry point:** `✨ Summarise trend` button on the Trend chart card

Generates a 2-sentence plain-English summary of a performance trend:

> *"Response times have increased 40% over the last 3 deployments, with p95 rising from 320ms to 460ms. The degradation is consistent and accelerating — investigate the changes shipped on 2026-06-02."*

---

## 7. PDF Executive Summary

**Service:** `results-service`  
**When it runs:** Automatically on every PDF report download  
**Quota cost:** 1 Gemini call per PDF

A 3-sentence executive summary at the top of the PDF report, written for a non-technical audience:

> *"The load test of api.example.com completed successfully with 5 virtual users over 2 minutes. Response times averaged 215ms with a 99th percentile of 380ms, well within acceptable thresholds. No performance degradation was observed compared to last week's baseline — the system is ready for the planned deployment."*

---

## 8. Playwright → k6 Translator

**Service:** `ai-service`  
**Entry point:** `✨ Translate Playwright` file-upload button in Custom Script mode

Converts an existing Playwright `.ts`/`.js` test file into a k6 load test script — reusing teams' existing test investments.

**Input:** Playwright test file (max 256 KB)  
**Output:** Full k6 script with `http.get/post`, `check()`, `sleep()`, `export const options`

---

## 9. Cron Assistant

**Service:** `results-service`  
**Entry point:** Natural-language text box below the Cron expression field in Schedules

Converts plain English to a cron expression:

| Input | Output |
|-------|--------|
| `every weekday at 9am` | `0 9 * * 1-5` — *Every weekday at 9 AM* |
| `twice a day at 8am and 8pm` | `0 8,20 * * *` — *At 08:00 and 20:00 daily* |
| `first monday of every month` | `0 9 1-7 * 1` — *First Monday at 9 AM* |

---

## 10. Alert Noise Prediction

**Service:** `results-service`  
**Entry point:** Fires automatically when toggling webhook event checkboxes (failed/degraded)

Analyses run history and warns if the selected events would be too noisy or never fire:

```
⚠ Alert would fire on ~80% of runs with current settings.
  Consider adding "degraded" only, not "failed".
```

---

## 11. Parameterisation Suggestions

**Service:** `results-service`  
**Entry point:** `✨ Suggest columns` button in the FlowBuilder Test data section

Scans step URLs and request bodies for hardcoded values that should be varied across virtual users:

```
Suggested test data columns: product_id, category, user_email
Found hardcoded IDs in /products/{id} and /search?q= query strings.
```

---

## 12. Preset Name + Tags

**Service:** `results-service`  
**Entry point:** Fires automatically when clicking "Save preset"

Generates a descriptive name and relevant tags based on the test configuration:

```
Saved as: AE.com Homepage — 10 VUs load test
Tags:  e-commerce  load  authenticated
```

---

## 13. Chat-Based Test Creation + Multi-Step Flow Building from Context

**Service:** `results-service` (`POST /chat/parse`)
**Entry point:** "Chat" tab in the sidebar — a multi-turn conversation, not a single-shot form.

The user describes a test in plain English or provides structured context (Swagger spec, HAR
recording, documentation, codebase files); Gemini parses the conversation into one of four outcomes:

- **`ready`** — a complete `backend` or `client-side` test config (URL, VUs/sessions, duration,
  profile, thresholds). Shown as a read-only preview card with **Run Test** / **Edit settings**.
  Confirming calls the existing `POST /tests` unchanged.
- **`flowReady`** — **new** — a complete `FlowTestConfig` (`steps: FlowStep[]`, `targetUrl`,
  `description`, `options`, optional `thresholds`). Returned when multi-step intent is detected
  **and** the AI can extract concrete step details from attachments or the conversation. The UI
  renders a step list card with three actions:
  - **Run flow test** — calls `createTest({ type: 'flow', steps, ... })` immediately; status bubble
    appears and subscribes to WebSocket `test:status` events for that test.
  - **Edit in Flow Builder** — stores the steps in `sessionStorage('chatFlowSteps')`, navigates to
    `/?type=flow&fromChat=1`; the home page reads and clears the key on mount, pre-filling FlowBuilder.
  - **Adjust settings** — dismisses the card and lets the conversation continue.
- **`needsClarification`** — a follow-up question when something required is missing (URL, VUs,
  duration, or which endpoints from the Swagger spec to include), shown as a normal assistant reply.
- **`redirectToFlowBuilder`** — last resort only; returned when multi-step intent is detected but
  no usable context was provided to extract step details from. Offers a "Open Flow Builder" link to
  `/?type=flow`.

**Attachment support** — the request body accepts `attachments?: ChatAttachment[]`; each attachment
is processed server-side before the AI prompt is built (`processAttachments()` in `helpers.ts`):

| Type | Source | Processing |
|------|--------|-----------|
| `swagger_url` | URL | Fetched server-side (SSRF-validated), JSON parsed + endpoints summarized; raw text if YAML |
| `har` | Uploaded `.json` file | Parsed, static assets filtered out, top-50 entries formatted as `METHOD URL → STATUS` |
| `documentation` | Any text file | Passed as-is, truncated to 4000 chars |
| `codebase` | Source files | Same as documentation |

The UI provides three ways to add context: a **paperclip button** (file picker — `.json` files
become `har`, all others `documentation`), a **Swagger icon** (opens an inline URL input that adds
a `swagger_url` attachment without triggering a send), and **drag-and-drop** anywhere on the page.
Pending attachments appear as dismissible chips above the input bar.

When context attachments are present, `buildChatParsePrompt` injects `flowReady` as outcome 1
(highest priority), pushing single-URL `ready` to 2 and `needsClarification` to 3 — so the AI
attempts to build a flow before asking questions. Without attachments the prompt is unchanged: only
three outcomes exist (`ready`, `needsClarification`, `redirectToFlowBuilder`), preserving the
original single-URL behavior and all existing tests.

Resolves the **per-team** AI provider override (`getEffectiveAiProviderSetting`) — per-team aware,
unlike AI-9 (`suggest-settings`) which still uses the global-only `getAiProviderSetting`. The
server caps the conversation to the last 20 messages before building the prompt. Each turn meters
one call against the team's daily Gemini quota (`checkGeminiQuota`/`incrementGeminiUsage`).

---

## 14. Output Validation & Prompt Injection Mitigation

**Service:** `@alt/shared` (`packages/shared/src/aiValidation.ts`) — shared helpers used across
results-service, ai-service, and recorder-service.

Two guardrails, added after a live-testing session found Gemini returning malformed JSON on the
chat endpoint (a hallucinated `flow` type, and threshold values as unit-suffixed strings like
`"1000ms"` instead of plain numbers):

**Output schema validation** — every AI-backed endpoint that returns structured JSON now validates
the parsed response before trusting it, not just regex-extracts + `JSON.parse()`s it:
- `extractAndParseAIJson(text, kind?)` — extracts a `{...}` or `[...]` block and parses it, returning
  `null` (never throwing) on no match or invalid JSON.
- `coerceNumericValue(v)` — coerces a unit-suffixed string (`"1000ms"`) to a plain number, returning
  `null` if it can't be coerced — confirmed live that Gemini doesn't always honor a prompt's "return
  a plain number" instruction.
- A per-endpoint type-guard validator (e.g. `isValidChatParseResponse`, `isValidCronResponse`,
  `isValidSuggestThresholdsResponse`, `isValidDiagnoseResponse`, etc. — one per AI endpoint in
  `results-service/app.ts`) checks the exact fields that endpoint's prompt promises. On a `false`,
  each endpoint falls back to **its own pre-existing failure response** — most return
  `500 { error: 'AI returned unexpected response' }`, but `/ai/webhook-noise` returns its existing
  soft `{ warning: null }` and `/results/:testId/diagnose` returns its existing soft
  `{ diagnoses: [], message: ... }` — validation only catches malformed output, it doesn't change
  any endpoint's error-handling UX.

**Prompt injection fencing** — `fenceUserContent(label, value)` wraps user-supplied free text in
`<user_data label="...">...</user_data>` before it's interpolated into a prompt, paired with one
`USER_DATA_INSTRUCTION` line per prompt telling the model to treat fenced content as data only,
never as instructions. This is a lightweight, delimiter-based mitigation (not a classifier) —
applied at every site where genuinely user-controlled text enters a prompt: chat messages, schedule
descriptions (`/ai/cron`), script-generation `targetUrl`/`description` (all 3 prompt variants in
`ai-service/generator.ts`), recorder-service's correlation prompt (actual recorded HTTP body/header
content — the highest-risk site, since a user can record traffic from any website), captured
domains, recorded step data, and flow-step parameterization data. Deliberately **not** applied to
fixed-enum fields (webhook events) or system-computed data (trend metrics, error summaries), where
fencing adds no value.

---

## Infrastructure & Reliability

### Model configuration & multi-provider fallback

Gemini is the default provider, but every AI call site resolves its model/provider through a pluggable abstraction (`generateAIText()` in `@alt/shared`) rather than calling the Gemini SDK directly, so OpenAI or Anthropic can serve as an alternate primary or fallback (AI-15, see root [`TODO.md`](../TODO.md) for delivery history):

```bash
GEMINI_MODEL=gemini-3.1-flash-lite          # default Gemini model
OPENAI_API_KEY=...                          # optional — enables OpenAI as primary/fallback
OPENAI_MODEL=gpt-4o-mini                    # default OpenAI model
ANTHROPIC_API_KEY=...                       # optional — enables Anthropic as primary/fallback
ANTHROPIC_MODEL=claude-3-5-haiku-latest     # default Anthropic model
```

- **Platform default** — an admin sets the active provider + fallback chain via `GET`/`PUT /system/ai-provider` (admin-only `PUT`). Every AI call site — `ai-service` (script generation), `analyser-service` (AI insights), `recorder-service` (correlation/naming/ignore suggestions), and results-service's on-demand `/ai/*` endpoints — resolves this setting through `generateAIText()`/`getProviderSetting()`, cached in-process for 30s per lookup.
- **Per-team override** — teams can override the platform default via `GET`/`PUT`/`DELETE /teams/:id/ai-provider` (admin-only); a team with no override row inherits the platform default. The Team page shows "Custom for this team" vs. "Using platform default" with a one-click revert.
- **UI** — an admin-only "AI Provider" section on the Team page: provider dropdown + fallback checkboxes, showing "(not configured)" next to any provider with no API key set.

### Rate limit handling

There are two independent rate-limit layers — Gemini's own per-minute/day quota is a different thing from the platform's own per-team daily quota — and they fail differently:

**1. Gemini API rate limit during script generation — retries automatically.**
When `ai-service` calls Gemini (or another configured provider) while generating a script or comparing descriptions and gets a `429`, it retries in-process up to 3 attempts, waiting 60s then 120s between attempts. If it's still rate-limited after those 3 attempts, the message is requeued via RabbitMQ for up to 3 further attempts; the test's status line shows `"Gemini unavailable — retrying… (N attempts left)"` while this happens. If every retry is exhausted, the test fails with `"Script generation failed after 3 attempts — test could not start"`.

**2. Everywhere else — fails closed immediately, no retry.**
- AI insights (`analyser-service`) does not retry on a provider rate-limit: it immediately falls back to deterministic-only analysis (thresholds + regression, no narrative/anomalies/root-causes) and posts a `status_message` on the test result: *"Gemini quota exceeded — AI insights unavailable until quota resets (midnight UTC)"*.
- All on-demand `/ai/*`, `suggest-*`, and `/results/:testId/diagnose` endpoints in results-service check the caller's own **per-team daily quota** (`team_quotas.maxGeminiCallsPerDay`) before ever calling the AI provider, and return `429 { "error": "Daily AI quota exceeded for this team" }` if it's exhausted — see [API reference → Team quotas](api.md#team-quotas).
- All non-AI features keep working regardless — tests with cached scripts still run.

**3. UI banner.**
`AIStatus.tsx` polls `GET /system/ai-status` every 60s, which looks back 2 hours for any Gemini-related `status_message` (retry, quota, or generation-failure wording) on a test result. If one is found, an amber **"Gemini API — daily quota exceeded"** banner appears (dismissible, and reappears if a new occurrence lands after dismissal).

### LLM tracing (Langfuse, optional)

Every `generateAIText()` call — script generation, the chat endpoint, AI insights, recorder
correlation — is traced via [Langfuse](https://langfuse.com) when configured: prompt, completion,
and which provider in the fallback chain served the request, all visible in one dashboard across
every AI feature in this doc. Disabled by default and fully optional:

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com   # default; set your own URL if self-hosting
```

Free Cloud tier (no card required) covers dev use: 50k trace units/month, 30-day retention. Leaving
both keys empty disables tracing entirely — it's a single OTel span processor added alongside the
existing Tempo exporter (see [Grafana Integration](how-to/grafana-integration.md) for Tempo), so
there's no separate service to run and no performance cost when unconfigured.

### Service summary

| Service | AI responsibilities | Fallback |
|---------|--------------------|---------| 
| `ai-service` | Script generation, description comparison, Playwright translation | DLQ + status_message |
| `analyser-service` | AI insights per test result | Deterministic analysis only |
| `recorder-service` | Correlation detection, step naming, ignore suggestions | Steps without extract rules / original names |
| `results-service` | All on-demand AI endpoints (8 routes) | HTTP 503 with clear error message |

---

## Metrics

| Metric | Value |
|--------|-------|
| Total AI-powered features | 18 |
| Gemini calls per new test (max) | 2 (generation + comparison) |
| Gemini calls per completed test | 1 (AI insights) |
| Gemini calls per recording session | 3 (correlation + naming + ignore patterns) |
| Pure AI features (no Gemini) | 2 (think-time hints, step deduplication) |
| Test coverage for AI code | 51 new tests across 4 files |
