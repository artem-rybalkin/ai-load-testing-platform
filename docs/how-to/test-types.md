# Test Types

The platform supports three test types. Choose based on what you want to measure.

| Type | Worker | When to use |
|------|--------|-------------|
| `backend` | k6 | HTTP API performance, server throughput, load profiles |
| `client-side` | Puppeteer + Lighthouse | Web Vitals, visual performance, real browser behaviour |
| `flow` | k6 or Puppeteer | Multi-step authenticated workflows, E2E API sequences |

---

## Backend Tests (k6)

Backend tests use [k6](https://k6.io/) to send HTTP requests at scale. They measure **server-side performance** — response times, error rates, and throughput under various concurrency levels.

### Options

```json
{
  "vus": 50,
  "duration": "2m",
  "rampUp": "30s",
  "profile": "load",
  "peakVus": 500,
  "httpOptions": {
    "keepAlive": true,
    "timeout": "30s",
    "discardResponseBodies": false
  }
}
```

| Option | Type | Description |
|--------|------|-------------|
| `vus` | number | Concurrent virtual users |
| `duration` | string | How long to run at peak VUs. Formats: `30s`, `5m`, `1h` |
| `rampUp` | string | Time to ramp from 0 to `vus` before holding. Default: 30s |
| `profile` | string | Load shape — see below |
| `peakVus` | number | Max VUs for spike/capacity profiles. Default: `vus × 10` |
| `httpOptions.keepAlive` | boolean | Reuse TCP connections. Default: `true` |
| `httpOptions.timeout` | string | Per-request timeout. Default: k6's default (60s) |
| `httpOptions.discardResponseBodies` | boolean | Don't parse response bodies — reduces memory. Default: `false` |
| `headers` | object | Custom headers (e.g. API keys, auth tokens) sent with every request. Set via "Custom Headers" in Advanced settings; merged into `params.headers` for every `http.*` call in the generated k6 script |

### Load profiles

Pick a profile based on what you want to find:

#### `load` (default) — steady-state performance
```
VUs
 50 |         ___________
    |        /           \
  0 |_______/             \___
    ramp-up    duration   ramp-down
```
Use to: measure p95/p99 at normal production load.

#### `spike` — handle sudden traffic bursts
```
VUs
500 |              ___
    |             /   \
 50 |____/\______/     \____
    warm  pre  spike   cool
```
Use to: verify auto-scaling or cache warm-up under sudden load.

#### `capacity` — find the breaking point
```
VUs
500 |                    /
    |                   /
  0 |__________________/
           duration
```
Use to: find the VU level where error rate spikes or latency degrades.

#### `soak` — detect memory leaks and long-duration degradation
```
VUs
 50 |      _________________
    |     /                 \
  0 |____/                   \___
```
Use to: find slow memory leaks or connection pool exhaustion over hours.

### Metrics collected

| Metric | Description |
|--------|-------------|
| `requestsTotal` | Total HTTP requests sent |
| `requestsFailed` | Requests that failed or got non-2xx |
| `avgResponseTime` | Mean response time (ms) |
| `p50ResponseTime` | Median response time (ms) |
| `p95ResponseTime` | 95th percentile response time (ms) |
| `p99ResponseTime` | 99th percentile response time (ms) |
| `rps` | Requests per second |
| `statusCodes` | Count per HTTP status code |
| `errorBreakdown` | Categorised error counts (see below) |

**Error breakdown categories:**

| Category | Description |
|----------|-------------|
| `success` | 2xx responses |
| `clientError` | 4xx responses |
| `serverError` | 5xx responses |
| `timeout` | Connection or read timeout |
| `networkError` | Connection refused, DNS failure |

### SLO thresholds

```json
{
  "thresholds": {
    "p95": 500,
    "avg": 200,
    "errorRate": 1,
    "serverErrorRate": 0.5,
    "timeoutRate": 0.5
  }
}
```

A test gets `perf_status = "failed"` when any threshold is exceeded.
A test gets `perf_status = "degraded"` when metrics are ≥ 20% worse than the previous run or baseline.

---

## Browser Tests (Puppeteer + Lighthouse)

Browser tests use headless Chromium (Puppeteer) to measure **user-perceived performance**. Lighthouse provides an overall quality score.

### Options

```json
{
  "sessions": 3,
  "duration": "1m",
  "collectWebVitals": true
}
```

| Option | Description |
|--------|-------------|
| `sessions` | Concurrent Puppeteer sessions |
| `duration` | Session duration |
| `collectWebVitals` | Collect Core Web Vitals (default: `true`) |
| `headers` | Custom headers (e.g. API keys, auth tokens) set via "Custom Headers" in Advanced settings; applied via `page.setExtraHTTPHeaders(...)` before navigation |
| `device` | Optional mobile device emulation preset (e.g. `"iPhone 15"`, `"Pixel 7"`) selectable in Advanced settings — sets viewport, user agent, and touch emulation via Puppeteer's built-in `KnownDevices` before navigation. Omit for the default desktop viewport. An unrecognized preset name is logged and ignored rather than failing the test. |

Browser tests never route through Gemini script generation or the script cache — `worker-client` always runs its own native Puppeteer flow regardless of `description`, so `POST /tests` skips AI entirely for `type: "client-side"` (no quota consumed, no request-latency cost from the generation round-trip).

### Metrics collected

**Core Web Vitals:**

| Metric | Full name | Good threshold |
|--------|-----------|----------------|
| `lcp` | Largest Contentful Paint | < 2500ms |
| `fid` | First Input Delay | < 100ms |
| `cls` | Cumulative Layout Shift | < 0.1 |
| `ttfb` | Time to First Byte | < 800ms |
| `fcp` | First Contentful Paint | < 1800ms |

**Lighthouse scores** (0–100):

| Score | Description |
|-------|-------------|
| `performance` | Page speed and responsiveness |
| `accessibility` | WCAG compliance |
| `bestPractices` | Security, modern APIs |
| `seo` | Search engine discoverability |

A Lighthouse performance score < 50 is treated as a threshold violation.

### SLO thresholds

```json
{
  "thresholds": {
    "lcp": 2500,
    "fcp": 1800,
    "ttfb": 800,
    "cls": 0.1
  }
}
```

---

## Multi-step Flow Tests

Flow tests orchestrate a sequence of HTTP steps in order — useful for authenticated workflows where step N depends on tokens from step N-1.

### Building a flow in the UI

1. Select **Multi-step Flow** in the type selector
2. In the **FlowBuilder** section:
   - Click **+ Add Step**
   - Set name, URL, HTTP method, and optional body/headers
   - Add **Extract rules** to capture response tokens for later steps
3. Choose **Run as ⚡ k6 HTTP** or **🌐 Puppeteer Browser**
4. Click **▶ Run Test**

### Step configuration

Each step supports:

```json
{
  "name": "Login",
  "url": "https://api.example.com/login",
  "method": "POST",
  "body": "{\"user\": \"${username}\", \"password\": \"${password}\"}",
  "headers": {
    "Content-Type": "application/json"
  },
  "extract": {
    "token": {
      "source": "jsonpath",
      "expression": "$.access_token"
    },
    "userId": {
      "source": "jsonpath",
      "expression": "$.user.id"
    }
  }
}
```

**Extract rule sources:**

| Source | Expression example | Description |
|--------|--------------------|-------------|
| `jsonpath` | `$.data.token` | JSONPath expression on response JSON |
| `header` | `Authorization` | Response header value |
| `cookie` | `session_id` | Cookie value |
| `regex` | `token=(.*?);` | Regex on response body — captures group 1 |

Extracted variables are available as `${variableName}` in subsequent steps' URLs, bodies, and headers. If an extraction fails (empty result), the VU aborts — preventing corrupted state from propagating.

### Data parameterization

Supply a data table to give each VU different credentials or inputs.

**Inline table (UI or API):**
```json
{
  "testData": [
    { "username": "alice", "password": "pass1" },
    { "username": "bob",   "password": "pass2" }
  ]
}
```

**CSV upload (API):**
```json
{
  "csvData": "dXNlcm5hbWUscGFzc3dvcmQKYWxpY2UscGFzczEKYm9iLHBhc3My",
  "csvFilename": "users.csv"
}
```

The AI generates a `SharedArray` in the k6 script that distributes rows round-robin across VUs:
`data[(__VU - 1) % data.length]`

### Environment variables

Pass sensitive values like credentials via `envVars` — they reach k6 as `--env KEY=VALUE` flags and are **never stored in the database**:

```json
{
  "envVars": {
    "API_BASE_URL": "https://staging.api.example.com",
    "ADMIN_TOKEN": "secret-token"
  }
}
```

Use them in steps as `${API_BASE_URL}` or in the generated script as `__ENV.API_BASE_URL`.

### HAR import

Instead of building steps manually:
1. Open Chrome DevTools → Network tab
2. Perform the flow you want to test
3. Right-click → **Save all as HAR with content**
4. In FlowBuilder, click **Import HAR** and select the file

The platform converts each relevant XHR/fetch request into a FlowStep (static assets filtered out).

### Flow recording

For even faster step capture:
1. Click **🔴 Record** in the FlowBuilder header
2. A Chromium window opens (visible via noVNC at `http://localhost:6080`)
3. Navigate and interact as a real user
4. Click **⏹ Stop Recording**
5. AI detects correlations between requests and auto-fills extract rules

See [Flow Recording](flow-recording.md) for details.

### Per-step metrics

After a flow test completes, the **Step Metrics** table shows for each step:
- Average response time
- p95 response time
- Total requests
- Failed requests

The **Live Metrics** charts also show per-step lines during k6 execution.

### Run as Puppeteer Browser

Toggle to **🌐 Puppeteer Browser** below the FlowBuilder to run the same steps in a real browser instead of k6. This measures the full client-side experience of the flow (Web Vitals per page load) rather than raw API performance.
