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
| AUTH-01 | Register creates a new account + team | `SESSION_SECRET` set; email/team name not yet used | 1. Go to `/login`, switch to register mode 2. Enter email, password, name, team name 3. Submit | `POST /auth/register` returns `SessionUser` with `currentTeamId` set and `role: 'admin'`; `alt_session` HttpOnly cookie set; redirected to home | P1 |
| AUTH-02 | Register — duplicate email rejected | Account with that email exists | 1. Register again with the same email, different team name | `409`; no new user/team created | P1 |
| AUTH-03 | Register — duplicate team name rejected | A team with that name exists | 1. Register a new account using an existing team name | `409`; no new user/team created | P2 |
| AUTH-04 | Login with correct credentials | Registered account exists | 1. Go to `/login` 2. Enter correct email + password | `200`; cookie set; `SessionUser` returned with the user's teams/orgs | P1 |
| AUTH-05 | Login — wrong password | Registered account exists | 1. Submit correct email, wrong password | `401`; no cookie set; generic error (does not reveal whether the email exists) | P1 |
| AUTH-06 | Login — unknown email | — | 1. Submit an email with no account | `401`; same generic error as AUTH-05 | P2 |
| AUTH-07 | `GET /auth/me` reflects current session | Logged in | 1. Call `GET /auth/me` | Returns `SessionUser` matching the logged-in account | P1 |
| AUTH-08 | `GET /auth/me` — no/expired/revoked session | Logged out, or cookie cleared | 1. Call `GET /auth/me` | `401` | P1 |
| AUTH-09 | Logout clears session | Logged in | 1. Click "Sign out" | Session row's `revoked_at` set; `alt_session` cookie cleared; subsequent `GET /auth/me` → `401`; redirected to `/login` | P1 |
| AUTH-10 | Switch team | User belongs to ≥2 teams | 1. Use the sidebar team-switcher `<select>` to pick a different team | `POST /auth/switch-team` updates session's current team; `SessionUser.currentTeamId` changes; subsequent requests scoped to the new team's data | P1 |
| AUTH-11 | Switch team — not a member | A team ID the user does not belong to | 1. Call `POST /auth/switch-team` with that team's ID directly | `403` | P2 |
| AUTH-12 | Session with no current team | User removed from their only team (or a session predating any team) | 1. Make any request other than `/teams` or `/orgs` | `403` on all of them | P3 |
| AUTH-13 | Unauthenticated access redirects to login | Not logged in, `SESSION_SECRET` set | 1. Navigate directly to `/results/compare` (or any protected route) | Redirected to `/login`; original destination not rendered | P1 |
| AUTH-14 | Session persists across reload | Logged in | 1. Refresh the browser | User remains authenticated; no redirect to login | P2 |
| AUTH-15 | Dev mode (no SESSION_SECRET) bypasses auth | `SESSION_SECRET=""` | 1. Navigate to any page without logging in | All pages accessible; `/auth/*` return the fixed dev user with no cookie; `request.user/projectId/role` are `null`/`undefined` server-side | P2 |
| AUTH-16 | Tampered session cookie is rejected | Logged in | 1. Edit the `alt_session` cookie value (flip a character) 2. Reload | Hash lookup fails; treated as unauthenticated; redirected to `/login` | P2 |
| AUTH-17 | Cross-team data isolation | Two distinct teams/users created | 1. Log in as team A, create a test/preset/webhook 2. Log out, log in as team B | Team B does not see team A's resources (results, scripts, presets, schedules, webhooks, log sources) | P1 |

---

## 2. Team & RBAC Management

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| TEAM-01 | View team members | Logged in | 1. Go to `/team` | `GET /teams/:id/members` lists `{ userId, email, name, role }` for the caller's current team | P1 |
| TEAM-02 | Add a member (admin) | Admin role; target user has an existing account | 1. Enter their email + role 2. Submit | `POST /teams/:id/members` adds them with the chosen role (default `member`); appears in the list | P1 |
| TEAM-03 | Add member — unknown email | Admin role | 1. Submit an email with no account | `404` | P2 |
| TEAM-04 | Add member — already a member | Admin role; target is already on the team | 1. Submit their email again | `409` | P2 |
| TEAM-05 | Change a member's role (admin) | Admin role; ≥2 members incl. another admin | 1. Change a member's role via the dropdown | `PUT /teams/:id/members/:userId` persists; UI reflects new role | P1 |
| TEAM-06 | Change role — invalid role string | Admin role | 1. Call the endpoint directly with `role: "superadmin"` | `400` | P3 |
| TEAM-07 | Last-admin protection | Exactly one admin on the team | 1. Try demoting the sole admin to member/viewer 2. Try removing the sole admin | `409` on both `PUT` and `DELETE .../members/:userId`; role/membership unchanged | P1 |
| TEAM-08 | Remove a member (admin) | Admin role; ≥2 members | 1. Click remove on a non-admin member | `DELETE /teams/:id/members/:userId` succeeds; member disappears from list | P1 |
| TEAM-12 | Create a new team | Logged in (any role) | 1. Use "+ New team" (Org page) or `POST /teams` directly with `{ name }` | New team created; caller becomes its `admin`; appears in `user.teams` | P1 |
| TEAM-13 | Create team — duplicate name | A team with that name exists | 1. Submit the same name | `409` | P2 |
| TEAM-14 | Team-switcher visibility | User belongs to exactly 1 team vs ≥2 | 1. Compare sidebar in both cases | `<select>` switcher is hidden for 1 team, shown for ≥2 | P3 |

---

### RBAC — Cross-Resource 403 Matrix

The cases below all test the same underlying rule — a caller without the required role attempts a mutating (or otherwise privileged) action on some resource and must get `403` — with only the resource/endpoint/role varying. Consolidated here as a single parameterized table instead of one verbose test case per resource.

| Test ID | Resource | Endpoint | Required Role | Expected Result | Notes |
|---------|----------|----------|----------------|------------------|-------|
| TEAM-10 | Team membership | `POST/PUT/DELETE /teams/:id/members...` | admin | `403` | UI renders a read-only member list (no controls) for non-admins |
| TEAM-11 | All resources, platform-wide | Any mutating route (tests, scripts, presets, etc.) | member or above (not viewer) | `403` on every mutating request | Broader than the rest of this table — `viewer` is read-only across *all* resource routes, not just team membership |
| ORG-08 | Org membership | `POST/PUT/DELETE /orgs/:id/members...` | owner/admin | `403` | — |
| KEY-06 | Team API keys | `POST /teams/:id/api-keys`, `DELETE .../api-keys/:keyId` | admin | `403` | — |
| QUOTA-03 | Team quotas | `PUT /teams/:id/quotas` | admin | `403` | — |
| AIP-09 | AI provider settings | `PUT /teams/:id/ai-provider`, `PUT /system/ai-provider` | admin | `403` (per-team); global `PUT /system/ai-provider` also requires admin of the caller's current team | Global endpoint has an extra nuance: it isn't just "any admin," it must be admin of the caller's *current* team |
| AUDIT-05 | Audit log | `GET /teams/:id/audit-log` | admin | `403`; section absent from the Team page UI | Read (`GET`), not a mutation — otherwise the same admin-only rule |
| AUDIT-10 | Data erasure | `DELETE /teams/:id/data` | admin | `403` | — |

All rows: P2 (except TEAM-10, which is P1 as the canonical/first-discovered case).

---

## 3. Organizations

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| ORG-01 | Create an organization | Logged in (any role) | 1. `POST /orgs { name }` | Org created; caller becomes `owner` in `org_members`; "Org" nav item now visible | P1 |
| ORG-02 | Create org — duplicate name | An org with that name exists | 1. Submit the same name | `409` | P2 |
| ORG-03 | View an org | Caller is a member of the org | 1. Go to `/org` | `GET /orgs/:id` returns `{ org, members, teams }`; each team shows a usage summary | P1 |
| ORG-04 | Add an org member (owner/admin) | Caller is owner/admin; target has an account | 1. Add by email + role | `POST /orgs/:id/members` succeeds; `404` unknown email, `409` already a member | P1 |
| ORG-05 | Change an org member's role (owner/admin) | ≥2 org members incl. another owner | 1. Change role via UI/API | `PUT /orgs/:id/members/:userId` persists | P2 |
| ORG-06 | Last-owner protection | Exactly one owner | 1. Try demoting or removing the sole owner | `409` on both `PUT` and `DELETE .../members/:userId` | P1 |
| ORG-07 | Remove an org member (owner/admin) | ≥2 members | 1. Remove a non-owner member | `DELETE` succeeds; member disappears | P2 |
| ORG-09 | Create a team inside an org | Caller is owner/admin | 1. Use "+ New team" on the Org page | `POST /orgs/:id/teams { name }` creates a team with `org_id` set; caller becomes its team `admin`; listed under the org's teams | P1 |
| ORG-10 | Ungrouped teams unaffected | A team created before/without an org | 1. Verify it still functions normally | `org_id` is `NULL`; no "Org" nav item forced; team behaves identically to an org-grouped one | P3 |

*(Non-owner/admin-cannot-mutate-membership is covered as ORG-08 in the [RBAC — Cross-Resource 403 Matrix](#rbac--cross-resource-403-matrix) in Section 2.)*

---

## 4. Team Quotas

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| QUOTA-01 | View quota & usage | Any team member | 1. Go to `/team` → "Usage & Limits" | `GET /teams/:id/quotas` returns `{ quota, usage }`; `DEFAULT_TEAM_QUOTA` shown when no `team_quotas` row exists yet | P1 |
| QUOTA-02 | Edit quota (admin) | Admin role | 1. Change a limit (e.g. `maxConcurrentTests`) 2. Save | `PUT /teams/:id/quotas` upserts the row with the partial update | P2 |
| QUOTA-04 | Exceeding `maxConcurrentTests` | Quota set low (e.g. 1); one test already running | 1. Submit another test | `POST /tests` → `429` | P1 |
| QUOTA-05 | Exceeding `maxVusPerTest` | Quota set low | 1. Submit a test requesting more VUs than the cap | `429` | P2 |
| QUOTA-06 | Exceeding `maxTestDurationSeconds` | Quota set low | 1. Submit a test with a longer duration than the cap | `429` | P2 |
| QUOTA-07 | Exceeding `maxScheduledTests` | Quota set low; at the schedule limit | 1. Create (or re-enable) one more schedule | `429` | P2 |
| QUOTA-08 | Exceeding `maxGeminiCallsPerDay` | Quota exhausted for the day | 1. Call an explicit `/ai/*` endpoint (e.g. "✨ Suggest settings") | `429` | P2 |
| QUOTA-08a | Core pipeline Gemini calls are NOT metered | Same exhausted daily quota as QUOTA-08 | 1. Run a test that needs AI script generation | Succeeds normally — script generation, recording correlation, and PDF summaries bypass the per-team daily counter | P2 |
| QUOTA-09 | `teamId == null` bypasses quota checks | Dev mode (`SESSION_SECRET` empty) | 1. Submit tests/schedules well past any quota numbers | All succeed — quota checks are skipped entirely when there's no team context | P3 |

*(Non-admin-cannot-edit-quota is covered as QUOTA-03 in the [RBAC — Cross-Resource 403 Matrix](#rbac--cross-resource-403-matrix) in Section 2.)*

---

## 5. Team API Keys

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| KEY-01 | Generate an API key (admin) | Admin role | 1. On `/team` → "API Keys", click generate, name it | `POST /teams/:id/api-keys` returns `{ id, name, key, createdAt }`; raw `key` shown once in the UI | P1 |
| KEY-02 | List API keys | ≥1 key generated | 1. View the API Keys list | `GET /teams/:id/api-keys` shows `{ id, name, createdAt, lastUsedAt, revoked }` — no key material | P1 |
| KEY-03 | Revoke a key | An active key exists | 1. Click revoke | `DELETE .../api-keys/:keyId` sets `revoked_at`; key disappears or shows revoked in the list | P1 |
| KEY-04 | Use an API key to scope a request | A valid, unrevoked key | 1. `POST /tests` with `X-API-Key: <key>` and no session cookie | Succeeds; scoped to that team (`request.projectId = team_id`, `role = 'admin'`); `last_used_at` updates | P1 |
| KEY-05 | Revoked/unknown key rejected | A revoked key, or a made-up string | 1. Use it as `X-API-Key` | `401`; does not fall through to the global-key/session checks | P2 |

*(Non-admin-cannot-manage-keys is covered as KEY-06 in the [RBAC — Cross-Resource 403 Matrix](#rbac--cross-resource-403-matrix) in Section 2.)*

---

## 6. AI Provider Configuration — Global & Per-Team

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| AIP-01 | View available providers (public) | — | 1. `GET /system/ai-provider` (no auth) | Returns `{ provider, fallbacks, available: { gemini, openai, anthropic } }` reflecting which keys are configured in env | P2 |
| AIP-02 | Update global default provider (admin) | Admin role | 1. On `/team` → "AI Provider", change the primary provider dropdown 2. Save | `PUT /system/ai-provider` persists to `app_settings`; reflected on next `GET` | P1 |
| AIP-03 | Invalid provider name rejected | Admin role | 1. Call the endpoint directly with `provider: "chatgpt"` | `400` | P3 |
| AIP-04 | Per-team override | Admin role | 1. Change the team's AI Provider section to differ from the platform default 2. Save | `PUT /teams/:id/ai-provider` upserts `team_ai_providers`; `GET /system/ai-provider?teamId=<id>` now returns `isOverride: true` | P1 |
| AIP-05 | Revert to platform default | A team override exists | 1. Click "Revert to platform default" | `DELETE /teams/:id/ai-provider` removes the override row; subsequent `GET ?teamId=` shows `isOverride: false` and the global setting | P2 |
| AIP-06 | UI badge reflects override state | Team page, AI Provider section | 1. Toggle between overridden and default | Badge reads "Custom for this team" vs "Using platform default" accordingly | P3 |
| AIP-07 | Fallback chain works end-to-end | Primary provider unconfigured (no API key), one fallback configured | 1. Set that combination 2. Run a test needing AI generation | Generation succeeds via the fallback provider, not the unconfigured primary | P2 |
| AIP-08 | "(not configured)" label | A provider with no API key set in env | 1. Open the provider dropdown/checkboxes | That provider is labeled "(not configured)" | P3 |

*(Non-admin-cannot-change-AI-provider-settings is covered as AIP-09 in the [RBAC — Cross-Resource 403 Matrix](#rbac--cross-resource-403-matrix) in Section 2.)*

---

## 7. Audit Log & Data Erasure (GDPR)

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| AUDIT-01 | PDF export recorded | Completed result | 1. Download the PDF report | `audit_log` row inserted: `action='export_pdf'`, correct `resourceId` | P2 |
| AUDIT-02 | CSV export recorded | Completed result | 1. Download the CSV report | `action='export_csv'` row inserted | P3 |
| AUDIT-03 | Script delete recorded | Existing script | 1. Delete it | `action='delete'`, `resourceType='script'` row inserted | P3 |
| AUDIT-04 | View audit log (admin only) | Admin role; ≥1 audited action occurred | 1. Go to `/team` → "Audit Log" | Most recent entries first, joined with the acting user's email | P2 |
| AUDIT-06 | Audit log `limit` param respected | ≥500 audited actions (or fewer, to test the default) | 1. Call with `?limit=500` and with no param | Default `100`; capped at max `500` even if a larger value is requested | P3 |
| AUDIT-07 | Danger Zone two-click confirmation | Admin role | 1. Click "Erase all data" once | Button changes to "Click again to confirm"; no deletion yet on the first click | P1 |
| AUDIT-08 | Data erasure (admin, confirmed) | Admin role; some team data exists | 1. Confirm the second click | `DELETE /teams/:id/data { confirm: true }` deletes test_results, live_metrics, test_scripts, schedules (cron unregistered), test_presets, webhooks, log_sources, audit_log; records a final `erase_team_data` audit entry; returns `{ success, deleted: {...} }` | P1 |
| AUDIT-09 | Data erasure without confirm | Admin role | 1. Call the endpoint directly with no/false `confirm` | `400`; nothing deleted | P2 |
| AUDIT-11 | GDPR auto-purge | `TEST_RESULTS_RETENTION_DAYS > 0`; old `test_results` rows exist | 1. Wait for/trigger the 60s stale-cleanup tick | Rows (and their `live_metrics`) older than N days are deleted; recent rows untouched | P3 |

*(Non-admin-cannot-view-audit-log and non-admin-cannot-erase-data are covered as AUDIT-05 and AUDIT-10 in the [RBAC — Cross-Resource 403 Matrix](#rbac--cross-resource-403-matrix) in Section 2.)*

---

## 8. Test Creation — Backend (k6)

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
| BE-21 | HTTP options — discard response bodies | — | 1. Open Advanced settings 2. Enable "Discard response bodies" 3. Run | `httpOptions: { discardResponseBodies: true }` included in the k6 options block of the generated/cached script (`buildK6Options`) | P3 |
| BE-22 | Custom headers — backend & browser tests | — | 1. Open Advanced settings 2. Under "Custom Headers" click "+ add", set `X-Api-Key` / `secret123` 3. Run — repeat once for **⚡ Backend** and once for **🌐 Browser** | `options.headers: { "X-Api-Key": "secret123" }` sent in `POST /tests` for both types. **Type: Backend** — generated k6 script merges the header into `params.headers` for every `http.*` call. **Type: Browser** — generated Puppeteer script calls `page.setExtraHTTPHeaders({...})` before navigation. Verify in the saved script for whichever type was run | P3 |

---

## 9. Test Creation — Browser (Puppeteer)

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

*(Custom headers for browser tests are covered by the merged BE-22 in Section 8, which now parameterizes both Backend and Browser verification.)*

---

## 10. Test Creation — Multi-step Flow

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

## 11. Test Execution, Live Monitoring & Cancellation

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

## 12. Results — List, Detail, Compare, Trend, Baseline

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
| RES-18 | CSV report download | Completed result | 1. Click "↓ CSV" | Downloads a CSV with summary metrics + one row per step for flow tests | P2 |
| RES-19 | Threshold preview against last run | SLO thresholds section open, target URL set, ≥1 completed result exists for that URL+type | 1. Adjust threshold values 2. Click "👁 Preview against last run" | `GET /results/preview-thresholds` returns pass/degraded/fail + violation details computed via `analyzeResult` against the most recent completed result — no new (potentially long) test is run | P2 |

---

## 13. Execution Log Streaming

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| ELOG-01 | View execution log after completion | Completed test | 1. Open result detail, expand the execution log panel | `GET /results/:testId/log` returns the ANSI-stripped worker output; `{ log: null }` for tests run before this feature existed | P2 |
| ELOG-02 | Real-time streaming during a live run | Test currently running | 1. Watch the log panel while it runs | Lines append live via `test:log` WebSocket events as the worker posts each one internally | P1 |
| ELOG-03 | Internal log-line endpoint requires the internal key | `INTERNAL_API_KEY` set | 1. Call `POST /results/:testId/log-line` with body `{ "lines": [{ "level": "INFO", "line": "test" }] }`, without `X-Internal-Key` | `401`; with the correct key, `{ success: true }` and each line in the batch is broadcast as a separate `test:log` event | P2 |
| ELOG-04 | Log cap enforced | A script producing very verbose/looping output | 1. Run it to completion | Stored log is capped at 5000 lines / 100 KB, not unbounded | P3 |
| ELOG-05 | Partial log retained on failure | A test that fails mid-run | 1. Open its detail | Whatever log was captured up to the failure point is present (not empty/discarded) | P2 |

---

## 14. Scripts Management

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| SCR-01 | View saved scripts list | ≥1 generated/reused script | 1. Navigate to scripts view (if exposed) / `GET /scripts` | Listed by `used_count DESC` with target URL, type, description | P2 |
| SCR-02 | Delete a saved script | Existing script | 1. Delete it | Removed from DB; next test for that URL/type triggers fresh AI regeneration | P2 |
| SCR-03 | Script reuse increments used_count | Cache-hit path triggered repeatedly | 1. Run the same URL+type+description combo multiple times | `used_count` increments correctly without duplicate inserts (per the documented increment ownership: api-service on bypass, worker-backend on confirmed REUSE) | P3 |

---

## 15. Script Library

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| LIB-01 | Browse built-in templates | — | 1. Go to `/library` | `SCRIPT_TEMPLATES` listed with name, description, tags | P2 |
| LIB-02 | Preview a template | ≥1 template listed | 1. Toggle preview on one | Full script source shown inline | P3 |
| LIB-03 | "Use this script" loads it into the form | A template's preview is open | 1. Click "Use this script" | Navigates to the home page with Custom Script mode pre-selected and the template's script pre-filled | P2 |
| LIB-04 | `findScriptTemplate` lookup correctness | Templates with distinct tags/names | 1. If search/filter is exposed, search by a known tag or name | Correct subset of templates returned | P3 |

---

## 16. Presets

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| PRE-01 | Create a preset | Filled test form | 1. Click "Save preset", provide a name | Preset stored with type/URL/options/thresholds; appears in dropdown sorted by `used_count DESC` | P1 |
| PRE-02 | Load a preset into the form | ≥1 preset exists | 1. Select from "Load from preset…" | Form fully repopulated; dropdown resets to placeholder afterward | P1 |
| PRE-03 | Preset increments used_count on load | Existing preset | 1. Load it via `GET /presets/:id` (selection) | `used_count` increments; order in dropdown may shift | P3 |
| PRE-04 | Delete a preset | Existing preset | 1. Delete from presets management page | Removed from list and dropdown | P2 |
| PRE-05 | Preset CRUD page | — | 1. Go to `/presets` | List, create, delete all function correctly; validation errors surfaced for bad input | P2 |

---

## 17. Schedules

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

## 18. Webhooks

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| WH-01 | Create a webhook | — | 1. Go to `/webhooks` 2. Add URL, select events (failed/degraded), optional secret | Webhook saved and listed | P1 |
| WH-02 | Webhook fires on matching perf_status | Webhook configured for `failed` | 1. Run a test that ends with `perf_status = 'failed'` | POST received at the target URL with `{ testId, targetUrl, perfStatus, metrics }`; fire-and-forget (does not block result save) | P1 |
| WH-03 | Webhook does NOT fire on non-matching status | Webhook configured only for `degraded` | 1. Run a `passed` test | No webhook call made | P2 |
| WH-04 | HMAC signature header present when secret set | Webhook with `secret` configured | 1. Trigger a matching event | `X-Webhook-Signature: sha256=<hmac>` header present and verifiable against the payload + secret | P2 |
| WH-05 | Delete a webhook | Existing webhook | 1. Delete it | Removed; no further deliveries | P2 |
| WH-06 | Webhook delivery failure doesn't block result save | Target URL unreachable | 1. Run a matching test | Result still saves successfully; webhook error swallowed (`.catch(() => {})`) | P3 |

---

## 19. Log Sources

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| LOG-01 | Create a log source | — | 1. Add name, platform, URL template with placeholders | Saved; appears as "View Logs" button on relevant results | P2 |
| LOG-02 | Placeholder interpolation correctness | Log source with all placeholder types | 1. Click "View Logs" on a completed result | `{startedAtMs}`, `{completedAtMs}`, `{startedAtISO}`, `{completedAtISO}`, `{targetUrl}`, `{targetUrlEncoded}`, `{testId}` all substituted correctly (encoding applied where specified) | P3 |
| LOG-03 | Delete a log source | Existing log source | 1. Delete it | Removed; "View Logs" button disappears from result detail | P3 |

---

## 20. System Health & Worker Monitoring

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| SYS-01 | System health banner appears on degradation | Stop one dependent service (e.g. ai-service) | 1. Wait up to 15s | Amber dismissible warning strip appears with correct per-service impact text (e.g. "AI (Gemini) unreachable — New tests cannot be started") | P1 |
| SYS-02 | System health banner clears on recovery | Service restarted | 1. Wait for next poll | Banner auto-clears once `/system/health` reports all healthy | P2 |
| SYS-03 | Worker health bars | At least one worker running | 1. View `WorkerHealth` component | CPU/memory/active-test bars render and update via 15s polling | P3 |
| SYS-04 | `/health` deep check (api-service) | — | 1. `GET /health` while DB or RabbitMQ is down | Returns 503 with details on which dependency failed | P2 |
| SYS-05 | `/system/health` aggregation status codes | All services healthy / one degraded | 1. `GET /system/health` in both states | 200 when all OK; 207 when partially degraded; correct per-service breakdown | P3 |
| SYS-06 | AI status indicator | — | 1. Observe `AIStatus` component (60s poll) | Reflects current Gemini reachability/quota status | P3 |

---

## 21. Navigation, Layout & Responsiveness

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| NAV-01 | Sidebar collapse/expand persists | Desktop viewport | 1. Toggle sidebar 2. Reload | State persists via `localStorage`; width animates between 220px ↔ 48px | P3 |
| NAV-02 | Active nav item highlighted | — | 1. Navigate between pages | Current page highlighted with `bg-[#ddf4ff] text-[#0969da]` in sidebar | P3 |
| NAV-03 | Mobile bottom nav & top bar | Mobile viewport (< lg breakpoint) | 1. Resize to mobile width | `BottomNav` (5 tabs, fixed bottom) and `TopBar` (h-10 sticky) shown; sidebar hidden | P2 |
| NAV-04 | Results list responsive layouts | Both desktop and mobile widths | 1. Resize browser | Table view on desktop, card list on mobile; both fully functional | P2 |
| NAV-05 | Quick-stats panel on home page | Desktop, ≥1 result exists | 1. Load `/` | Panel shows today's count, avg p95, pass rate, active tests, recent runs, preset shortcuts | P3 |
| NAV-06 | Charts render consistently | Any result with charts | 1. Inspect chart styling | Horizontal-only gridlines, monospace axis ticks, consistent tooltip style/colors per design tokens | P3 |
| NAV-07 | Dark mode toggle | — | 1. Click "Dark mode" in the sidebar 2. Reload | Theme switches and persists across reload (`useDarkMode` hook); all pages remain legible (no white-on-white/black-on-black regressions) | P3 |

---

## 22. Rate Limiting

| ID | Title | Pre | Steps | Expected | Pri |
|----|-------|-----|-------|----------|-----|
| RATE-01 | Global rate limit exceeded | `RATE_LIMIT_MAX` reachable in a short burst (or temporarily lowered) | 1. Fire more requests than the limit within `RATE_LIMIT_WINDOW_MS` from one IP | `429` with body `{"statusCode":429,"error":"Too Many Requests","message":"Rate limit exceeded, retry in N seconds"}` and a `Retry-After` header | P2 |
| RATE-02 | `/health` exempt from rate limiting | Global limit otherwise exhausted | 1. Call `GET /health` repeatedly past the limit | Always succeeds — `/health` is in the `allowList` | P3 |
| RATE-03 | Auth rate limit | `AUTH_RATE_LIMIT_MAX` (10/min) | 1. Submit `/auth/login` or `/auth/register` more than 10 times in a minute from one IP | `429`, independent of the global limit — brute-force protection | P2 |
| RATE-04 | AI endpoint rate limit | `AI_RATE_LIMIT_MAX` (20/min) | 1. Call an explicit `/ai/*` or `suggest-*`/`diagnose` endpoint >20 times/min from one IP | `429`, independent of the per-team Gemini daily quota (see QUOTA-08) | P3 |
| RATE-05 | Internal worker callbacks exempt | Global limit otherwise exhausted | 1. Hammer `/results/pending` or `/results/:id/running\|fail\|message\|live\|cancel` | Not subject to the global limit (`allowList`) | P3 |
| RATE-06 | Rate limiter fails open if Redis is down | `REDIS_URL` set but Redis unreachable | 1. Stop the `redis` container 2. Make normal requests | Requests still succeed (`skipOnError: true`); `/health` reports `checks.redis: 'disconnected'` without flipping overall health to unhealthy | P3 |

---

## 23. Cross-Cutting / Non-Functional

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

## 24. Boundary, Negative & Security Input Validation

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

## 25. AI-Assist & Productivity Features

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

## Suggested Execution Order (smoke pass before full regression)

1. AUTH-01, AUTH-04, AUTH-09 (can you register, log in, and log out?)
2. TEAM-01, TEAM-02, TEAM-07 (team membership basics + last-admin protection)
3. ORG-01, ORG-09 (org creation + creating a team inside it)
4. BE-01, BR-01, FL-01 (one happy path per test type)
5. EX-01, EX-02, EX-05, EX-06 (lifecycle + the two bugs fixed in the 2026-06-08 session)
6. RES-01, RES-03, RES-07, RES-16, RES-19 (can you see, compare, and sanity-check results?)
7. QUOTA-04, KEY-04 (a quota actually blocks something; an API key actually authenticates)
8. AIP-02, AIP-04 (global + per-team AI provider override both take effect)
9. SYS-01 (does the platform tell you when something's wrong?)
10. SEC-03, SEC-04, SEC-19 (the security checks most likely to catch a real hole fast)
11. AIX-01, AIX-09, AIX-14 (one "✨" AI-assist control per major surface — settings, diagnosis, scheduling)
12. AUDIT-07, AUDIT-08 (Danger Zone confirmation gate actually gates, and erasure actually erases)

Then proceed through the remaining sections by priority (P1 → P2 → P3) for full regression coverage.

---

## Using This Suite with the claude-in-chrome Extension

When asked to execute these scenarios via the Claude Chrome plugin against this app:

1. Log in as the dedicated agent account (see memory: Chrome plugin account) rather than a real user account — `claude-chrome@ai-load-testing.local` / team `claude-chrome-agent` — so test data doesn't pollute anyone's personal team.
2. For cases requiring a *second* team/user (AUTH-17, TEAM-10/11, ORG-08, KEY-05, QUOTA-09, etc.), register a second throwaway account in the same session (e.g. `claude-chrome-2@ai-load-testing.local`) rather than reusing a real one.
3. For cases requiring `admin`/`owner` API access directly (role-enforcement negatives, quota/rate-limit boundary cases), it's faster to drive them with `curl`/`Bash` alongside the browser than to fight the UI into an invalid state.
4. Cases tagged P3 involving infrastructure changes (`docker compose --scale`, stopping a container, editing `.env`) are out of scope for pure browser-driven execution — note them as "requires infra change, not run" rather than skipping silently.
5. Record actual results inline (pass/fail + a one-line note) rather than just running through silently — execution findings get logged in `TEST_EXECUTION_LOG.md` (see that file for the format).

---

**Note:** For narrative bug write-ups and root-cause findings from past execution runs, see [`TEST_EXECUTION_LOG.md`](./TEST_EXECUTION_LOG.md).
