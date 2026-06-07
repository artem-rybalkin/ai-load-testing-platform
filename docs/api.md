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

### Cookie session auth (UI / project-scoped)

When `SESSION_SECRET` is set on results-service, session middleware is active. All results-service endpoints (except `/health`, `/auth/*`, internal `/results/pending`, and internal worker callbacks) require a valid `alt_session` cookie.

#### `POST /auth/login`

Create or join a project and issue a session cookie.

**Request body:**

| Field | Type | Description |
|-------|------|-------------|
| `username` | string | Display name (1–80 chars) |
| `projectName` | string | Project slug (1–80 chars, lowercased) |

```bash
curl -X POST http://localhost:3004/auth/login \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{ "username": "alice", "projectName": "my-team" }'
```

**Response `200`:**
```json
{ "projectId": "550e8400-...", "username": "alice", "projectName": "my-team" }
```

Sets `alt_session` cookie (HttpOnly, SameSite=Strict). If `SESSION_SECRET` is empty, returns a 200 dev response with `{ "dev": true }` and sets no cookie.

#### `POST /auth/logout`

Clear the session cookie.

```bash
curl -X POST http://localhost:3004/auth/logout -b cookies.txt
```

**Response `200`:** `{ "success": true }`

#### `GET /auth/me`

Return the currently authenticated user from the session cookie.

```bash
curl http://localhost:3004/auth/me -b cookies.txt
```

**Response `200`:** `{ "projectId": "...", "username": "alice", "projectName": "my-team" }`

Returns `401` if not authenticated.

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

All live metric points recorded during a k6 test (5-second windows, chronological).

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

Returns `application/pdf`. Includes test summary, metrics, and performance analysis.

---

### `POST /results/:testId/baseline`

Mark a completed test as the baseline for future regression comparisons against the same URL + type.
Clears any existing baseline for that URL + type first.

```bash
curl -X POST http://localhost:3004/results/550e8400/baseline
```

**Response:** `{ "success": true, "testId": "..." }`

Returns `404` if the test is not completed.

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
| 401 | Missing or invalid `X-API-Key` |
| 404 | Resource not found |
| 500 | Internal server error |
| 503 | Service health check failed |
