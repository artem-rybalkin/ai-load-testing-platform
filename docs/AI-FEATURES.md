# AI Features — AI Load Testing Platform

All AI functionality in one place. Structured for presentation use.

---

## Overview

The platform uses **Google Gemini AI** (`gemini-3.1-flash-lite` by default, configurable via `GEMINI_MODEL` env var) across **4 services** for **18 distinct AI-powered capabilities**. Every AI call is lazy (user-triggered or event-triggered), non-fatal (graceful fallback when quota is exceeded), and surfaced to the user with a clear indicator.

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

## Infrastructure & Reliability

### Model configuration
All AI calls use a single configurable model:
```bash
GEMINI_MODEL=gemini-3.1-flash-lite  # default
# Override with any Gemini model ID
```

### Rate limit handling
When Gemini quota is exceeded, the platform:
1. Shows an amber **"Gemini API — daily quota exceeded"** banner in the UI (auto-dismisses when quota resets)
2. Posts a `status_message` on affected test results: *"Gemini quota exceeded — AI insights unavailable until quota resets (midnight UTC)"*
3. Continues working for all non-AI features — tests with cached scripts still run, deterministic analysis still executes

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
