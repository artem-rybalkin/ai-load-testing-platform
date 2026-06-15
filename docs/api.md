# API Reference

All requests and responses use JSON. In production with `API_KEYS` set, include `X-API-Key: <key>` on every request.

**Base URLs (local dev):**
- `http://localhost:3000` — api-service
- `http://localhost:3004` — results-service

---

## Authentication

### API key auth (legacy / service-to-service)

When `API_KEYS` is set (production), all endpoints require:

```http
X-API-Key: your-api-key
```

Exempt endpoints (always accessible without a key):
- `GET /health` on both services
- `POST /results/pending` (internal — called by api-service)
- `POST /results/:testId/running`, `/fail`, `/message` (internal — called by workers)

Returns `401 Unauthorized` if the key is missing or invalid.

---

### Cookie session auth (UI / team-scoped)

When `SESSION_SECRET` is set on results-service, session middleware is active. All results-service endpoints (except `/health`, `/auth/*`, internal `/results/pending`, and internal worker callbacks) require a valid `alt_session` cookie.

A session token is an opaque random value; only its SHA-256 hash is stored server-side in the `sessions` table (with `expires_at` and `revoked_at`), so `POST /auth/logout` immediately invalidates the cookie. Each session also tracks a "current team" (`team_id`), switchable via `POST /auth/switch-team`.

A user with no current team (e.g. just logged in but not yet a member of any team) is blocked with `403` from all routes except `/teams` (to create or be added to one).

**Roles:** `admin` | `member` | `viewer`, scoped per team via `team_members`. On mutating requests (`POST`/`PUT`/`PATCH`/`DELETE`): a `viewer` gets `403` on resource routes (tests, schedules, webhooks, presets, etc.); `/teams/:id/*` mutations additionally require `admin` for that team.

If `SESSION_SECRET` is empty, all `/auth/*` endpoints return a fixed dev user `{ "dev": true, ... }` and set no cookie — auth is fully disabled (local dev default).

---

### Per-team API key auth (CI / external automation)

In addition to the global `API_KEYS` list and session cookies, both api-service and results-service accept a **per-team API key** via `X-API-Key`. These are generated via `POST /teams/:id/api-keys` (see below), stored as `sha256(key)` in `team_api_keys`, and scope the request to that team — equivalent to an `admin` session with no current-team-switching ability.

```bash
curl -X POST http://localhost:3000/tests \
  -H "X-API-Key: <team-api-key>" \
  -H "Content-Type: application/json" \
  -d '{ "type": "backend", "targetUrl": "https://api.example.com", "options": { "vus": 5, "duration": "30s" } }'
```

A revoked key returns `401 { "error": "Not authenticated" }`.

#### `POST /auth/register`

Create a new user account, a new team, and sign in as that team's admin.

**Request body:**

| Field | Type | Description |
|-------|------|-------------|
| `email` | string | Valid email address |
| `password` | string | At least 8 characters |
| `name` | string? | Optional display name |
| `teamName` | string | New team name (1–80 chars, lowercased); `409` if already taken |

```bash
curl -X POST http://localhost:3004/auth/register \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{ "email": "alice@example.com", "password": "password123", "name": "Alice", "teamName": "my-team" }'
```

**Response `200`** (`SessionUser`):
```json
{
  "id": "550e8400-...",
  "email": "alice@example.com",
  "name": "Alice",
  "teams": [{ "id": "...", "name": "my-team", "role": "admin" }],
  "currentTeamId": "...",
  "role": "admin"
}
```

Sets `alt_session` cookie (HttpOnly, SameSite=Strict, 30-day expiry). `400` for invalid email/password; `409` if email or team name already taken.

#### `POST /auth/login`

Authenticate with email + password and issue a session cookie.

**Request body:**

| Field | Type | Description |
|-------|------|-------------|
| `email` | string | Account email |
| `password` | string | Account password |

```bash
curl -X POST http://localhost:3004/auth/login \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{ "email": "alice@example.com", "password": "password123" }'
```

**Response `200`:** `SessionUser` (see above) — `currentTeamId` is the user's first team, or `null` if they belong to no team yet. Returns `401` on invalid email/password.

#### `POST /auth/logout`

Revoke the session and clear the cookie.

```bash
curl -X POST http://localhost:3004/auth/logout -b cookies.txt
```

**Response `200`:** `{ "success": true }`

#### `GET /auth/me`

Return the currently authenticated user from the session cookie.

```bash
curl http://localhost:3004/auth/me -b cookies.txt
```

**Response `200`:** `SessionUser` (see `/auth/register`). Returns `401` if not authenticated.

#### `POST /auth/switch-team`

Switch the session's current team (must already be a member).

**Request body:** `{ "teamId": "..." }`

```bash
curl -X POST http://localhost:3004/auth/switch-team \
  -H "Content-Type: application/json" \
  -b cookies.txt -c cookies.txt \
  -d '{ "teamId": "660e8400-..." }'
```

**Response `200`:** `SessionUser` with updated `currentTeamId`/`role`. Returns `400` if `teamId` missing, `403` if not a member of that team.

---

### Team management

#### `POST /teams`

Create a new team; the caller becomes its admin.

**Request body:** `{ "name": "..." }`

**Response `200`:** `{ "id": "...", "name": "...", "role": "admin" }`. Returns `400` if name missing, `409` if name already taken.

#### `GET /teams/:id/members`

List members of a team. `:id` must be the caller's current team (`403` otherwise).

**Response `200`:** `[{ "userId": "...", "email": "...", "name": "...", "role": "admin" | "member" | "viewer" }]`

#### `POST /teams/:id/members`

Add an existing user to the team. **Admin only.**

**Request body:**

| Field | Type | Description |
|-------|------|-------------|
| `email` | string | Email of an existing registered user |
| `role` | string? | `admin` \| `member` \| `viewer` — defaults to `member` |

**Response `200`:** `{ "success": true }`. Returns `404` if no user with that email exists, `409` if already a member.

#### `PUT /teams/:id/members/:userId`

Change a member's role. **Admin only.**

**Request body:** `{ "role": "admin" | "member" | "viewer" }`

**Response `200`:** `{ "success": true }`. Returns `400` for an invalid role, `404` if not a member, `409` if this would demote the last remaining admin.

#### `DELETE /teams/:id/members/:userId`

Remove a member from the team. **Admin only.**

**Response `200`:** `{ "success": true }`. Returns `404` if not a member, `409` if this would remove the last remaining admin.

---

### Team quotas

Per-team resource limits, enforced before queuing tests/schedules and metering `/ai/*` Gemini calls. Any row absent from `team_quotas` falls back to `DEFAULT_TEAM_QUOTA` (5 concurrent tests, 1000 max VUs/test, 3600s max duration, 10 scheduled tests, 100 Gemini calls/day).

#### `GET /teams/:id/quotas`

Any member of team `:id`.

```bash
curl http://localhost:3004/teams/<id>/quotas -b cookies.txt
```

**Response `200`:**
```json
{
  "quota": { "maxConcurrentTests": 5, "maxVusPerTest": 1000, "maxTestDurationSeconds": 3600, "maxScheduledTests": 10, "maxGeminiCallsPerDay": 100 },
  "usage": { "concurrentTests": 1, "scheduledTests": 2, "geminiCallsToday": 7 }
}
```

#### `PUT /teams/:id/quotas`

**Admin only.** Body is a partial `TeamQuota` (positive integers); upserts the team's `team_quotas` row.

```bash
curl -X PUT http://localhost:3004/teams/<id>/quotas \
  -H "Content-Type: application/json" -b cookies.txt \
  -d '{ "maxConcurrentTests": 2 }'
```

**Response `200`:** `{ "quota": { ...TeamQuota } }`

When a quota is exceeded, `POST /tests` and `POST /schedules` return `429 { "error": "..." }`; `/ai/*` and `suggest-*` endpoints return `429 { "error": "Daily AI quota exceeded for this team" }`.

---

### Per-team API keys

**Admin only** (all three endpoints).

#### `POST /teams/:id/api-keys`

Generate a new key. The raw key is returned **once** — it is not retrievable afterwards.

**Request body:** `{ "name": "ci-pipeline" }`

```bash
curl -X POST http://localhost:3004/teams/<id>/api-keys \
  -H "Content-Type: application/json" -b cookies.txt \
  -d '{ "name": "ci-pipeline" }'
```

**Response `201`:** `{ "apiKey": { "id": "...", "name": "ci-pipeline", "key": "a1b2c3...", "createdAt": "..." } }`

#### `GET /teams/:id/api-keys`

List keys (no key material).

**Response `200`:** `{ "apiKeys": [ { "id": "...", "name": "ci-pipeline", "createdAt": "...", "lastUsedAt": "...", "revoked": false } ] }`

#### `DELETE /teams/:id/api-keys/:keyId`

Revoke a key (`revoked_at = NOW()`). Returns `204`.

---

### Organizations

Organizations group teams under `org_members` roles `owner` | `admin` | `member`. A team's `org_id` is nullable — teams stay "ungrouped" until added to an org via `POST /orgs/:id/teams`.

#### `POST /orgs`

Any authenticated user; creates the org and an `owner` membership for the caller.

**Request body:** `{ "name": "..." }`

**Response `200`:** `{ "id": "...", "name": "...", "role": "owner" }`. Returns `409` if name taken.

#### `GET /orgs/:id`

Any org member.

**Response `200`:**
```json
{
  "org": { "id": "...", "name": "..." },
  "members": [ { "userId": "...", "email": "...", "name": "...", "role": "owner" } ],
  "teams": [ { "id": "...", "name": "...", "usage": { "concurrentTests": 0, "scheduledTests": 1, "geminiCallsToday": 3 } } ]
}
```

#### `POST /orgs/:id/members`

**Owner/admin only.** Body: `{ "email": "...", "role"?: "owner" | "admin" | "member" }` (defaults to `member`). Returns `404` if no user with that email, `409` if already a member.

#### `PUT /orgs/:id/members/:userId`

**Owner/admin only.** Body: `{ "role": "owner" | "admin" | "member" }`. Returns `400` invalid role, `404` not a member, `409` would remove the last owner.

#### `DELETE /orgs/:id/members/:userId`

**Owner/admin only.** Returns `404` not a member, `409` would remove the last owner.

#### `POST /orgs/:id/teams`

**Owner/admin only.** Creates a new team (`projects` row with `org_id = :id`) and makes the caller its admin.

**Request body:** `{ "name": "..." }`

**Response `200`:** `{ "id": "...", "name": "...", "role": "admin" }`. Returns `409` if team name taken.

---

## api-service (port 3000)

### `GET /health`

Service health check. Returns `503` if database or RabbitMQ are unreachable.

**Response:**
```json
{
  "status": "ok",
  "service": "api-service",
  "checks": {
    "database": "ok",
    "queue": "ok"
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

---

### `POST /tests`

Create and start a new test.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"backend"` \| `"client-side"` \| `"flow"` | ✅ | Test type |
| `targetUrl` | string | ✅* | Target URL. For flow tests defaults to `steps[0].url` |
| `description` | string | — | Natural-language description (≤ 500 chars). Used by Gemini for script generation and semantic reuse |
| `options` | object | ✅ | Type-specific options (see below) |
| `thresholds` | object | — | SLO pass/fail thresholds (see below) |
| `steps` | FlowStep[] | Flow only | Step definitions for flow tests (max 20) |
| `envVars` | object | — | Environment variables passed to k6 as `--env KEY=VALUE`. **Never stored** |
| `testData` | array | — | Inline data rows for parameterization (array of `{key: value}` objects). **Never stored** |
| `csvData` | string | — | Base64-encoded CSV for parameterization. **Never stored** |
| `csvFilename` | string | — | Original CSV filename hint |
| `customScript` | string | — | Custom k6 script (≤ 512 KB). Bypasses AI generation entirely |

*Required unless `type = "flow"` with steps.

**Backend options (`options` for `type: "backend"`):**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `vus` | number | — | Virtual users (concurrent) |
| `duration` | string | — | Test duration, e.g. `"30s"`, `"5m"`, `"1h"` |
| `rampUp` | string | — | Ramp-up period before holding at `vus`, e.g. `"30s"` |
| `profile` | `"load"` \| `"spike"` \| `"capacity"` \| `"soak"` | `"load"` | Load profile shape |
| `peakVus` | number | `vus * 10` | Peak VUs for spike/capacity profiles |
| `httpOptions` | object | — | HTTP transport settings (see below) |
| `headers` | object | — | Custom request headers (e.g. API keys, auth tokens), sent with every request. Merged into `params.headers` for every `http.*` call in the generated k6 script |

**HTTP options (`options.httpOptions`):**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `keepAlive` | boolean | `true` | Keep TCP connections alive between requests |
| `timeout` | string | — | Per-request timeout, e.g. `"30s"` |
| `http2` | boolean | `false` | Force HTTP/2 |
| `discardResponseBodies` | boolean | `false` | Skip body parsing — saves memory on large responses |

**Browser options (`options` for `type: "client-side"`):**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `sessions` | number | — | Concurrent Puppeteer sessions |
| `duration` | string | — | Session duration |
| `collectWebVitals` | boolean | `true` | Collect LCP, FID, CLS, TTFB, FCP |
| `headers` | object | — | Custom request headers, applied via `page.setExtraHTTPHeaders(...)` before navigation |

**SLO thresholds (`thresholds`):**

| Field | Unit | Default | Applies to |
|-------|------|---------|------------|
| `p95` | ms | 1000 | Backend — p95 response time |
| `avg` | ms | 500 | Backend — average response time |
| `errorRate` | % | 1 | Backend — total error rate |
| `serverErrorRate` | % | 1 | Backend — 5xx error rate |
| `timeoutRate` | % | 1 | Backend — timeout error rate |
| `lcp` | ms | 2500 | Browser — Largest Contentful Paint |
| `fcp` | ms | 1800 | Browser — First Contentful Paint |
| `ttfb` | ms | 800 | Browser — Time to First Byte |
| `cls` | score | 0.1 | Browser — Cumulative Layout Shift |
| `inp` | ms | 200 | Browser — Interaction to Next Paint |
| `tbt` | ms | 200 | Browser — Total Blocking Time |

**FlowStep object:**

```json
{
  "name": "Login",
  "url": "https://api.example.com/auth/login",
  "method": "POST",
  "body": "{\"username\": \"${username}\", \"password\": \"${password}\"}",
  "headers": { "Content-Type": "application/json" },
  "extract": {
    "token": {
      "source": "jsonpath",
      "expression": "$.access_token"
    }
  }
}
```

`extract` maps variable names to `ExtractRule` objects:

| `source` | `expression` example | Extracts from |
|----------|----------------------|---------------|
| `"jsonpath"` | `"$.data.id"` | Response JSON body |
| `"header"` | `"Authorization"` | Response header value |
| `"cookie"` | `"session_id"` | Cookie value |
| `"regex"` | `"token=(.*?);"` | Response body via regex capture group 1 |

**Example — backend test:**
```bash
curl -X POST http://localhost:3000/tests \
  -H "Content-Type: application/json" \
  -d '{
    "type": "backend",
    "targetUrl": "https://api.example.com",
    "description": "Load test with 50 VUs for 2 minutes with spike profile",
    "options": {
      "vus": 50,
      "duration": "2m",
      "rampUp": "30s",
      "profile": "spike",
      "peakVus": 200
    },
    "thresholds": { "p95": 500, "errorRate": 2 }
  }'
```

**Example — flow test:**
```bash
curl -X POST http://localhost:3000/tests \
  -H "Content-Type: application/json" \
  -d '{
    "type": "flow",
    "description": "Authenticated API flow with 10 users for 1 minute",
    "options": { "vus": 10, "duration": "1m" },
    "steps": [
      {
        "name": "Login",
        "url": "https://api.example.com/login",
        "method": "POST",
        "body": "{\"user\": \"test\"}",
        "headers": { "Content-Type": "application/json" },
        "extract": { "token": { "source": "jsonpath", "expression": "$.token" } }
      },
      {
        "name": "Get profile",
        "url": "https://api.example.com/profile",
        "method": "GET",
        "headers": { "Authorization": "Bearer ${token}" }
      }
    ],
    "envVars": { "TEST_USER": "alice", "TEST_PASS": "secret" }
  }'
```

**Response:**
```json
{
  "success": true,
  "test": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "type": "backend",
    "targetUrl": "https://api.example.com",
    "description": "...",
    "options": { "vus": 50, "duration": "2m" },
    "createdAt": "2024-01-15T10:30:00.000Z"
  },
  "scriptReused": false
}
```

`scriptReused: true` means an existing cached script was used without calling Gemini.

Returns `429 { "error": "..." }` if the caller's team has exceeded its `team_quotas` limits (concurrent tests, max VUs/test, or max test duration) — see [Team quotas](#team-quotas).

---

### `POST /tests/:testId/cancel`

Cancel a running or pending test.

```bash
curl -X POST http://localhost:3000/tests/550e8400-e29b-41d4-a716-446655440000/cancel
```

**Response:**
```json
{ "success": true, "testId": "550e8400-e29b-41d4-a716-446655440000" }
```

Returns `404` if the test is not found or already completed/cancelled.

---

## results-service (port 3004)

### `GET /health`

Service health. Returns `503` if database or RabbitMQ consumer are disconnected.

---

### `GET /system/health`

Aggregated health of all 6 services. HTTP `200` = all healthy, `207` = partial degradation.

```bash
curl http://localhost:3004/system/health | jq .
```

**Response:**
```json
{
  "healthy": false,
  "services": [
    { "name": "results-service", "status": "ok", "checks": { "database": "ok", "queue": "ok" } },
    { "name": "api-service",     "status": "ok", "checks": { "database": "ok", "queue": "ok" } },
    { "name": "ai-service",      "status": "ok", "checks": {} },
    { "name": "worker-backend",  "status": "ok", "checks": {}, "metrics": { "cpuPercent": 12.5, "memoryMb": 180, "activeTests": 1, "maxTests": 1 } },
    { "name": "worker-client",   "status": "ok", "checks": {} },
    { "name": "recorder-service","status": "unreachable", "checks": {} }
  ]
}
```

Worker services include a `metrics` object with `cpuPercent`, `memoryMb`, `memoryPercent`, `activeTests`, `maxTests`.

---

### `GET /results`

All test results, most recent first (last 50). Includes joined script text.

```bash
curl http://localhost:3004/results | jq '.results[0]'
```

**Response:** `{ "results": [ ...TestResult ] }`

---

### `GET /results/active`

Currently pending or running tests.

```bash
curl http://localhost:3004/results/active
```

**Response:** `{ "active": [ { "test_id", "type", "target_url", "status", "created_at" } ] }`

---

### `GET /results/:testId`

Single result with joined script and script description.

```bash
curl http://localhost:3004/results/550e8400-e29b-41d4-a716-446655440000
```

**Response:** `{ "result": { ...TestResult, "script": "...", "script_description": "..." } }`

Returns `404` if not found.

---

### `GET /results/compare?a=<testId>&b=<testId>`

Side-by-side diff of two completed results.

```bash
curl "http://localhost:3004/results/compare?a=<id1>&b=<id2>"
```

**Response:** `{ "resultA": TestResult, "resultB": TestResult }`

---

### `GET /results/trend?url=<url>&limit=<n>`

Chronological metric trend for a URL (most recent N completed tests, default 20, max 100).

```bash
curl "http://localhost:3004/results/trend?url=https://api.example.com&limit=10"
```

**Response:** `{ "url": "...", "trend": [ ...TestResult ] }` — oldest first.

---

### `GET /results/:testId/live`

All live metric points recorded during a k6 test (5-second windows, chronological). Requires a valid session when `SESSION_SECRET` is set, and is project-scoped — returns only points for tests owned by the caller's project (only `POST /results/:testId/live`, used internally by `worker-backend`, is exempt from auth).

```bash
curl http://localhost:3004/results/550e8400/live
```

**Response:**
```json
{
  "points": [
    {
      "timestamp": "2024-01-15T10:30:05.000Z",
      "vus": 10,
      "rps": 45.2,
      "avgResponseTime": 220.5,
      "errorRate": 0.0,
      "stepMetrics": [
        { "name": "Login", "avgResponseTime": 180, "rps": 22.1, "errorRate": 0.0 },
        { "name": "Get profile", "avgResponseTime": 261, "rps": 23.1, "errorRate": 0.0 }
      ]
    }
  ]
}
```

`stepMetrics` is present only for flow tests.

---

### `GET /results/:testId/report.pdf`

Download a PDF report for a completed test.

```bash
curl http://localhost:3004/results/550e8400/report.pdf -o report.pdf
```

Returns `application/pdf`. Includes test summary, metrics, and performance analysis. Project-scoped — returns `404` if the test belongs to a different project.

---

### `GET /results/:testId/report.csv`

Download a CSV export of a test's metrics.

```bash
curl http://localhost:3004/results/550e8400/report.csv -o report.csv
```

Returns `text/csv` with `metric,value` rows (test summary + backend or client metrics). For flow tests, a blank line is followed by a `step,avgResponseTime,p95ResponseTime,requestsTotal,requestsFailed` section with one row per step. Project-scoped — returns `404` if the test belongs to a different project.

---

### `POST /results/:testId/baseline`

Mark a completed test as the baseline for future regression comparisons against the same URL + type.
Clears any existing baseline for that URL + type first.

```bash
curl -X POST http://localhost:3004/results/550e8400/baseline
```

**Response:** `{ "success": true, "testId": "..." }`

Returns `404` if the test is not completed, or if it belongs to a different project.

---

### `DELETE /results/:testId/baseline`

Clear the baseline flag.

```bash
curl -X DELETE http://localhost:3004/results/550e8400/baseline
```

Returns `204 No Content`.

---

### Scripts

Saved k6/Puppeteer scripts are cached and reused across tests to avoid regenerating the same script.

#### `GET /scripts`

All saved scripts, ordered by `used_count` descending.

```bash
curl http://localhost:3004/scripts | jq '.scripts'
```

#### `GET /scripts/:id`

Single script with full `script` text.

#### `DELETE /scripts/:id`

Delete a cached script. The next test for the same URL will regenerate via AI.

```bash
curl -X DELETE http://localhost:3004/scripts/<uuid>
```

Returns `204 No Content`.

---

### Webhooks

Webhooks fire a `POST` request to your endpoint when a test result has `perf_status = "failed"` or `"degraded"`.

#### `GET /webhooks`

List all configured webhooks.

#### `POST /webhooks`

Create a webhook.

**Request body:**

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | ✅ HTTPS endpoint to call |
| `events` | string[] | Default: `["failed", "degraded"]` |
| `secret` | string | Optional — sent as `X-Webhook-Secret` header |

```bash
curl -X POST http://localhost:3004/webhooks \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://hooks.slack.com/services/...", "events": ["failed"] }'
```

**Response `201`:**
```json
{
  "webhook": {
    "id": "...",
    "url": "https://hooks.slack.com/services/...",
    "events": ["failed"],
    "created_at": "2024-01-15T10:30:00.000Z"
  }
}
```

**Webhook payload** sent to your URL:
```json
{
  "perfStatus": "failed",
  "testId": "550e8400-...",
  "targetUrl": "https://api.example.com",
  "timestamp": "2024-01-15T10:35:00.000Z"
}
```

#### `DELETE /webhooks/:id`

Delete a webhook. Returns `204`.

---

### Schedules

Cron-based recurring test runs.

#### `GET /schedules`

List all schedules.

#### `POST /schedules`

Create a schedule.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | Display name |
| `cron` | string | ✅ | Cron expression, e.g. `"0 */6 * * *"` (every 6 hours) |
| `type` | string | ✅ | Test type: `backend`, `client-side`, or `flow` |
| `target_url` | string | ✅ | Target URL |
| `description` | string | — | Test description |
| `options` | object | ✅ | Test options (same as `POST /tests`) |
| `thresholds` | object | — | SLO thresholds |
| `enabled` | boolean | `true` | Whether the schedule is active |

```bash
curl -X POST http://localhost:3004/schedules \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Hourly API check",
    "cron": "0 * * * *",
    "type": "backend",
    "target_url": "https://api.example.com/health",
    "options": { "vus": 5, "duration": "30s" },
    "thresholds": { "p95": 200 }
  }'
```

**Response `201`:** `{ "schedule": { ...Schedule } }`

#### `PUT /schedules/:id`

Update name, cron, enabled flag, options, or thresholds. Partial updates — only include fields to change.

```bash
# Disable a schedule
curl -X PUT http://localhost:3004/schedules/<id> \
  -H "Content-Type: application/json" \
  -d '{ "enabled": false }'
```

#### `DELETE /schedules/:id`

Delete and stop the schedule. Returns `204`.

#### `POST /schedules/:id/run`

Trigger the schedule immediately (runs a test now, regardless of cron).

```bash
curl -X POST http://localhost:3004/schedules/<id>/run
```

---

### Presets

Reusable test configurations that pre-fill the UI form.

#### `GET /presets`

List all presets, ordered by `used_count` descending.

#### `POST /presets`

Create a preset.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | Preset name |
| `type` | string | ✅ | Test type |
| `options` | object | ✅ | Test options |
| `target_url` | string | — | Default target URL |
| `description` | string | — | Default test description |
| `thresholds` | object | — | Default SLO thresholds |

```bash
curl -X POST http://localhost:3004/presets \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Standard API smoke test",
    "type": "backend",
    "target_url": "https://api.example.com",
    "description": "Quick sanity check",
    "options": { "vus": 5, "duration": "30s" },
    "thresholds": { "p95": 300, "errorRate": 0 }
  }'
```

#### `GET /presets/:id`

Get a preset and increment its `used_count`.

#### `DELETE /presets/:id`

Delete a preset. Returns `204`.

---

## Error responses

All error responses follow:
```json
{ "error": "Human-readable error message" }
```

Common status codes:

| Code | Meaning |
|------|---------|
| 400 | Invalid request body or parameters |
| 401 | Missing or invalid `X-API-Key` / session |
| 403 | Insufficient role (viewer on mutating routes, non-admin on team/org admin routes, no current team) |
| 404 | Resource not found |
| 409 | Conflict (duplicate name, last-admin/owner protection, etc.) |
| 429 | Team quota exceeded (concurrent tests, VUs, duration, scheduled tests, or daily Gemini calls) **or** rate limit exceeded |
| 500 | Internal server error |
| 503 | Service health check failed |

### Rate limiting (429)

In addition to the team-quota `429`s above, both api-service and results-service apply a global per-IP rate limit (`RATE_LIMIT_MAX`, default 600 requests/minute). Exceeding it returns (this is `@fastify/rate-limit`'s default error shape, distinct from this API's usual `{ "error": "..." }` format):

```json
{ "statusCode": 429, "error": "Too Many Requests", "message": "Rate limit exceeded, retry in N seconds" }
```

with a `Retry-After` header (seconds). `/health` is exempt. Two route groups in results-service have stricter per-IP limits:

- `POST /auth/login` and `POST /auth/register`: `AUTH_RATE_LIMIT_MAX` (default 10/min) — brute-force protection
- `/ai/*`, `suggest-*`, and `/results/:testId/diagnose`: `AI_RATE_LIMIT_MAX` (default 20/min) — IP-based defense-in-depth on top of the per-team daily Gemini quota
