# Getting Started

This guide takes you from zero to running your first load test in about 5 minutes.

---

## Prerequisites

- **Docker** 24+ and **Docker Compose** v2 (`docker compose version`)
- A **Gemini API key** — get one free at [aistudio.google.com](https://aistudio.google.com/app/apikey)
- 4 GB of free RAM (all services combined use ~2 GB at idle)

---

## 1. Clone and configure

```bash
git clone https://github.com/youruser/ai-load-testing-platform.git
cd ai-load-testing-platform
```

Create a `.env` file in the project root:

```bash
# .env
GEMINI_API_KEY=your_key_here
```

That's the only required configuration for local development. All other values have sensible defaults.

---

## 2. Start the platform

```bash
docker compose up --build
```

The first build takes **2–5 minutes** — it compiles TypeScript for each service and downloads k6, Chromium, and noVNC. Subsequent starts are much faster.

You'll see all services starting up. Wait until you see log lines like:

```
api-service-1      | {"level":30,"msg":"Server listening at http://0.0.0.0:3000"}
results-service-1  | {"level":30,"msg":"Results-service consumer listening"}
worker-backend-1   | {"level":30,"msg":"Worker listening for backend tests"}
```

---

## 3. Open the dashboard

Go to **http://localhost:3006**

You'll see the **New Test** page with a form on the left and a quick-stats panel on the right.

---

## 4. Run your first backend test

1. In the **URL** field, enter `https://httpbin.org/get`
2. In the **Description** field, type: `Load test with 10 VUs for 30 seconds`
3. The form auto-detects the parameters — you'll see the **Advanced settings** expand with `VUs: 10`, `Duration: 30s`
4. Click **▶ Run Test**

The test starts immediately. You'll see:
- A **LIVE** badge appear while k6 is running
- Real-time charts for response time, error rate, and throughput
- The result page with full metrics once the test completes (~35 seconds)

---

## 5. View results

Click **Results** in the sidebar to see the results list. Your completed test appears at the top with:
- Performance status: **passed** (green), **degraded** (amber), or **failed** (red)
- Key metrics: p95 response time, requests/sec, error rate
- Click the row to open the full detail view

The detail page shows:
- Metric grid (avg, p50, p95, p99, rps, error rate)
- Bar charts (response time distribution, request breakdown)
- Performance analysis (threshold violations, regression diffs vs previous run)
- Trend chart (p95 across all runs for this URL)
- The generated k6 script (expandable, downloadable)

---

## 6. Run your first browser test

1. Click **New Test** in the sidebar
2. Select **Browser** in the type selector
3. Enter `https://example.com` as the URL
4. Description: `Measure Web Vitals with 2 sessions`
5. Click **▶ Run Test**

The worker-client service launches headless Chromium, collects Web Vitals (LCP, FID, CLS, TTFB, FCP) and Lighthouse scores, then returns the result.

---

## 7. Run your first multi-step flow test

1. Click **New Test**, then select **Multi-step Flow**
2. Click **+ Add Step** and configure:
   - Step 1: `GET https://httpbin.org/get` — name it `Fetch data`
   - Step 2: `POST https://httpbin.org/post` — name it `Submit result`
3. Set Description: `Flow test with 5 users for 30 seconds`
4. Choose **Run as ⚡ k6 HTTP**
5. Click **▶ Run Test**

The AI generates a k6 script with `group()` blocks per step. After the test, you'll see per-step metrics in the **Step Metrics** table and per-step lines in the live charts.

---

## 8. System health

The **SystemHealth** strip at the top of the UI shows a warning if any service is unreachable. You can also check health directly:

```bash
# All services
curl http://localhost:3004/system/health | jq .

# Individual services
curl http://localhost:3000/health
curl http://localhost:3004/health
```

---

## Next steps

| Topic | Guide |
|-------|-------|
| Load profiles, SLO thresholds, HTTP options | [Test Types](test-types.md) |
| Record a browser session as a flow | [Flow Recording](flow-recording.md) |
| Upload your own k6 script | [Custom Scripts](custom-scripts.md) |
| Schedule recurring tests | [API Reference → Schedules](api.md#schedules) |
| Deploy to production with HTTPS | [Production Deployment](production.md) |
| Run tests, add services, hot-reload | [Development Guide](development.md) |
