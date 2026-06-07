# Flow Recording

The **🔴 Record** feature lets you build a multi-step flow test by interacting with a real browser — no manual step configuration required. The platform captures all HTTP traffic via Chrome DevTools Protocol (CDP) and uses Gemini AI to detect correlations between responses and subsequent requests.

---

## How it works

```
Click "Record"
     │
     ▼
recorder-service launches Chromium
     │
     ▼
Xvfb virtual display + noVNC proxy exposed on :6080
     │
     ▼
You open http://localhost:6080 — see the browser, interact naturally
     │
     ▼
CDP Network domain captures all XHR/fetch/navigation requests
     │
     ▼
Click "Stop Recording"
     │
     ▼
Gemini AI analyses request/response pairs
     │  → Identifies tokens from response N used in request N+1
     │  → Assigns ExtractRule (jsonpath / header / cookie / regex)
     ▼
FlowBuilder populated with steps + extract rules
     │
     ▼
Review, adjust, and run as normal
```

---

## Requirements

The `recorder-service` must be running:

```bash
# If using docker compose, it starts automatically:
docker compose up --build

# Check it's healthy:
curl http://localhost:3007/health
```

The recorder-service is **optional** — the rest of the platform works without it. If it's not running, the Record button shows an error message.

---

## Using the recorder

### Step 1 — Open FlowBuilder

1. Go to **New Test** → **Multi-step Flow**
2. You'll see three options in the FlowBuilder header:
   - **+ Add Step** — manual entry
   - **Import HAR** — Chrome DevTools HAR file
   - **🔴 Record** — browser recording

### Step 2 — Start recording

Click **🔴 Record**. The button changes to **⏹ Stop Recording** and a yellow status banner appears:

```
🔴 Recording active — 0 requests captured   [Open Browser ↗]
Interact with the target page, then click Stop Recording.
```

At the same time, a new browser tab opens at `http://localhost:6080` showing the noVNC viewer.

### Step 3 — Interact in the browser

The noVNC tab shows a live view of the Chromium window running inside Docker. Click, type, and navigate as you would normally. You'll see the request counter in the yellow banner increment as traffic is captured.

**Tips for clean recordings:**
- Navigate to the target URL first (type it in the address bar or click a link)
- Perform the specific flow you want to test — login, browse, submit a form, etc.
- Avoid navigating to unrelated pages — all captured requests will be included
- The recorder automatically filters out static assets (JS, CSS, images, fonts) — only API calls and page navigations are kept

### Step 4 — Stop recording

Click **⏹ Stop Recording**. The recorder:

1. Stops CDP capture
2. Sends all captured request/response pairs to Gemini
3. Returns a `FlowStep[]` array with AI-detected extract rules

The FlowBuilder populates automatically with the captured steps.

### Step 5 — Review and edit

Inspect each step in the FlowBuilder. The AI may have added `extract` rules like:

```
Step 1 (Login) → extract: token via jsonpath $.access_token
Step 2 (Get profile) → uses ${token} in Authorization header
```

You can:
- Rename steps
- Remove unwanted steps (e.g. analytics pings, health checks)
- Edit extract rules or add new ones
- Reorder steps by dragging
- Add `envVars` for sensitive values

### Step 6 — Run the test

Click **▶ Run Test** as normal. The recorded steps run exactly as configured.

---

## Ignore list

If certain domains or URL patterns are consistently captured but not relevant to your test (analytics, error tracking, CDN pings), you can add them to the **Ignore list** in the FlowBuilder. Matching URLs are excluded from the captured steps.

---

## AI correlation detection

After stopping, the platform sends the request/response log to Gemini with a structured prompt asking it to identify **correlation points** — places where a value from response N appears in request N+1 or later.

For each correlation found, Gemini returns:
- Which response step contains the value
- A suggested variable name (snake_case)
- The extraction source (`jsonpath`, `header`, `cookie`, or `regex`)
- The extraction expression
- Which later steps use this variable

These are mapped onto the `FlowStep.extract` fields automatically.

**Correlation works best with:**
- Token-based authentication (JWT, session tokens)
- Resource IDs returned from creation endpoints and used in subsequent requests
- CSRF tokens in response headers or cookies
- Pagination cursors

**AI correlation is best-effort** — if Gemini fails or returns no correlations, the steps are still returned without extract rules. You can add them manually.

---

## Without Docker (local dev)

When running services locally (not in Docker), the recorder uses your machine's real display:

- **Linux/Mac:** Set `DISPLAY=:0` in the recorder-service environment — the browser window appears on your screen
- **Windows:** Chromium uses its own window

In this case, the noVNC viewer at `:6080` is not needed — you interact with the browser directly on your desktop.

---

## Recorder API

The recorder-service exposes a REST API you can call directly:

### `POST /recordings/start`

Start a recording session.

```bash
curl -X POST http://localhost:3007/recordings/start \
  -H "Content-Type: application/json" \
  -d '{ "targetUrl": "https://example.com" }'
```

**Response:**
```json
{
  "id": "rec-abc123",
  "status": "active",
  "noVncUrl": "http://localhost:6080/vnc.html"
}
```

`targetUrl` is optional — if provided, the browser navigates there immediately on launch.

### `GET /recordings/:id`

Poll for status and live request count.

```bash
curl http://localhost:3007/recordings/rec-abc123
```

**Response:**
```json
{
  "id": "rec-abc123",
  "status": "active",
  "stepCount": 12,
  "noVncUrl": "http://localhost:6080/vnc.html"
}
```

### `POST /recordings/:id/stop`

Stop recording and run AI correlation. Returns the resulting steps.

```bash
curl -X POST http://localhost:3007/recordings/rec-abc123/stop
```

**Response:**
```json
{
  "id": "rec-abc123",
  "status": "completed",
  "steps": [
    {
      "name": "POST /login",
      "url": "https://example.com/api/login",
      "method": "POST",
      "body": "{\"username\": \"...\"}",
      "extract": {
        "token": { "source": "jsonpath", "expression": "$.access_token" }
      }
    },
    {
      "name": "GET /profile",
      "url": "https://example.com/api/profile",
      "method": "GET",
      "headers": { "Authorization": "Bearer ${token}" }
    }
  ]
}
```

### `DELETE /recordings/:id`

Abort a recording without returning steps (e.g. user cancelled).

```bash
curl -X DELETE http://localhost:3007/recordings/rec-abc123
```

Returns `204 No Content`.

### `GET /health`

```bash
curl http://localhost:3007/health
```

---

## Troubleshooting

**"recorder-service is not running"** — Start the service: `docker compose up recorder-service`

**noVNC shows a blank screen** — The Xvfb display may not have started yet. Wait a few seconds and refresh. Check logs: `docker compose logs recorder-service`

**No steps returned after stopping** — The recorder may have captured only static assets (which are filtered). Try recording a flow with actual API calls or form submissions.

**Correlations not detected** — Gemini couldn't identify relationships automatically. Add extract rules manually in the FlowBuilder.

**Browser crashes** — The recorder runs as non-root with `--no-sandbox`. If you see `Failed to launch the browser process`, check `docker compose logs recorder-service` for `DISPLAY` errors. The Xvfb display must start before Chromium — this is handled by `docker-entrypoint.sh`.
