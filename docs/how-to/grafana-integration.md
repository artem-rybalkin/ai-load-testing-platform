# Grafana Integration Guide

How to connect Grafana (with Prometheus, Loki and Tempo) to the AI Load Testing Platform so that:
- every test result page has one-click links that open the exact time window in Grafana
- AI analysis (Insights and Diagnose) automatically pulls observability data from your stack

---

## Prerequisites

- Grafana running and accessible (e.g. `http://localhost:3030`)
- At least one datasource configured: Prometheus, Loki, or Tempo
- The AI Load Testing Platform running (all services up)

---

## Step 1 — Find Your Datasource IDs

```bash
curl http://localhost:3030/api/datasources
```

You will get a JSON array. Note the `id` and `type` for each datasource:

```json
[
  { "id": 1, "name": "Prometheus", "type": "prometheus" },
  { "id": 2, "name": "Loki",       "type": "loki" },
  { "id": 3, "name": "Tempo",      "type": "tempo" }
]
```

---

## Step 2 — Create a Grafana API Token (if auth is enabled)

If your Grafana requires login, create a service account token:

1. Open Grafana → **Administration** → **Service Accounts** → **Add service account**
2. Set role: **Viewer** (read-only access is sufficient)
3. Click **Add service account token** → copy the token

If Grafana has no authentication enabled (local dev), skip this step — leave the Auth header blank.

---

## Step 3 — Add Log Sources in the Platform

Go to the platform UI → **Webhooks** tab → **Log Sources** section.

Add one entry per data source you want to integrate. The fields are:

| Field | Purpose |
|-------|---------|
| **Name** | Display label shown on the result page button |
| **Platform** | Select Grafana (or the matching type) |
| **Dashboard URL template** | Deep-link opened in a new tab when the user clicks "View Logs" |
| **Metrics API endpoint template** *(optional)* | REST endpoint fetched server-side during AI analysis |
| **Auth header** *(optional)* | Sent as `Authorization` header to the metrics endpoint |

---

### Log Source 1 — Prometheus

Use for: HTTP error rates, JVM memory/GC, CPU, custom application metrics.

**Dashboard URL template:**
```
http://localhost:3030/explore?from={startedAtMs}&to={completedAtMs}&orgId=1
```

**Metrics API endpoint template** (replace `1` with your Prometheus datasource ID):
```
http://localhost:3030/api/datasources/proxy/1/api/v1/query_range?query=rate(http_requests_total[1m])&start={startedAtS}&end={completedAtS}&step=15
```

> **Why `{startedAtS}` not `{startedAtMs}`?**  
> The Prometheus `query_range` API expects Unix timestamps in **seconds**, not milliseconds.  
> `{startedAtS}` = `started_at / 1000`. Use it for all Prometheus queries.  
> `{startedAtMs}` is for Grafana Explore URLs which use milliseconds.

**Auth header** (if Grafana auth is enabled):
```
Bearer eyJhbGci...your-token-here
```

**Example queries for different use cases:**

| What to monitor | Query parameter value |
|----------------|----------------------|
| HTTP error rate | `rate(http_requests_total{status=~"5.."}[1m])` |
| JVM heap used | `jvm_memory_used_bytes{area="heap"}` |
| JVM GC pause | `rate(jvm_gc_pause_seconds_sum[1m])` |
| CPU usage | `rate(process_cpu_seconds_total[1m]) * 100` |
| Request latency p95 | `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[1m]))` |

To use a different query, replace the `query=` value in the Metrics API endpoint template.

---

### Log Source 2 — Loki

Use for: application error logs, stack traces, slow query logs captured during the test.

**Dashboard URL template:**
```
http://localhost:3030/explore?from={startedAtMs}&to={completedAtMs}&orgId=1
```

**Metrics API endpoint template** (replace `2` with your Loki datasource ID):
```
http://localhost:3030/api/datasources/proxy/2/loki/api/v1/query_range?query=%7Bjob%3D%22your-app%22%7D+%7C%3D+%22ERROR%22&start={startedAtISO}&end={completedAtISO}&limit=50
```

The query `{job="your-app"} |= "ERROR"` URL-decoded is a LogQL expression that fetches error logs for your application. Replace `your-app` with your actual Loki job label.

> **Why `{startedAtISO}` for Loki?**  
> The Loki HTTP API accepts ISO 8601 timestamps (`2026-06-05T14:32:10Z`) as well as nanosecond epoch.  
> ISO format is the safest choice for Loki.

**Auth header:** same Grafana token as Prometheus.

**Common LogQL queries:**

| What to find | LogQL expression (URL-encode before pasting) |
|-------------|----------------------------------------------|
| All ERROR logs | `{job="your-app"} \|= "ERROR"` |
| Exception stack traces | `{job="your-app"} \|= "Exception"` |
| Slow queries > 1s | `{job="your-app"} \|= "slow query"` |
| Specific service | `{service="payment-service"} \|= "ERROR"` |

---

### Log Source 3 — Tempo (deep-link only)

Use for: opening distributed traces for the test time window. Tempo does not have a simple metrics API suitable for AI analysis, so configure the dashboard URL only and leave Metrics API endpoint blank.

**Dashboard URL template:**
```
http://localhost:3030/explore?from={startedAtMs}&to={completedAtMs}&orgId=1
```

**Metrics API endpoint template:** *(leave blank)*

**Auth header:** *(leave blank)*

---

## Step 4 — Verify

After saving the log sources:

1. **Run a load test** against your application
2. **Open the result detail page**
3. You should see **"View Logs"** buttons for each configured source — click one to confirm it opens Grafana at the correct time window
4. On a completed test, scroll to the **Error Breakdown** card → click **✨ Diagnose with AI**
5. If Prometheus or Loki data was fetched, the AI diagnosis will mention it:
   > *"External Prometheus data shows JVM heap usage peaked at 87% at 2m30s into the test, correlating with the spike in server errors..."*

---

## Available Template Variables

Use these in both the Dashboard URL and Metrics API endpoint fields:

| Variable | Value | Use for |
|----------|-------|---------|
| `{startedAtMs}` | Unix epoch milliseconds | Grafana Explore URLs, Datadog |
| `{completedAtMs}` | Unix epoch milliseconds | Grafana Explore URLs, Datadog |
| `{startedAtS}` | Unix epoch **seconds** | Prometheus `query_range` API |
| `{completedAtS}` | Unix epoch **seconds** | Prometheus `query_range` API |
| `{startedAtISO}` | `2026-06-05T14:32:10.000Z` | Loki API, Kibana, OpenSearch |
| `{completedAtISO}` | `2026-06-05T14:34:45.000Z` | Loki API, Kibana, OpenSearch |
| `{targetUrl}` | Raw URL being tested | Custom queries filtering by URL |
| `{targetUrlEncoded}` | URL-encoded target URL | URLs that appear in query strings |
| `{testId}` | Test UUID | Custom tagging or tracing |

---

## How AI Analysis Uses External Data

When a test completes, the platform:

1. Checks if any log sources have a **Metrics API endpoint** configured
2. Interpolates the template with the test's `started_at` and `completed_at` timestamps
3. Fetches up to 3 KB of data from each endpoint (5-second timeout per source)
4. Passes the data to Gemini **alongside** the k6 metrics

This means the AI insights and error diagnoses can cross-reference your observability data:

- k6 shows 15% server errors → Loki shows `OutOfMemoryError` at the same time → AI concludes: *"JVM heap exhaustion caused by insufficient memory allocation under concurrent load"*
- k6 shows high p99 latency → Prometheus shows GC pause spikes → AI recommends: *"Tune GC settings or increase heap size — GC pauses of 800ms account for the p99 degradation"*

If an endpoint is unreachable or returns an error, that source is silently skipped and the analysis proceeds with available data only.

---

## Tempo — Distributed Tracing (built-in)

The platform ships with **OpenTelemetry instrumentation** across all 7 services. Every HTTP request, database query, RabbitMQ message, and outgoing Gemini call is automatically traced. Traces include a `test.id` attribute so you can find all spans for a specific test.

### Configure the OTLP endpoint

Add to your `.env`:

```bash
# Tempo OTLP HTTP receiver — default port 4318
OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318
# Disable tracing entirely:
# OTEL_SDK_DISABLED=true
```

`host.docker.internal` lets Docker containers reach the host machine where your Tempo instance runs.

To find Tempo's OTLP port: **Grafana → Connections → Data sources → Tempo → Status** — lists receiver endpoints.

### Search in Grafana → Explore → Tempo

By service name:
```
service.name = api-service
```

By test ID (see all spans for one full test pipeline):
```
test.id = <your-test-uuid>
```

The trace shows the complete journey:
```
POST /tests ──── DB lookup ──── RabbitMQ publish          (api-service, ~50ms)
  └── AMQP consumer ──── Gemini generateScript             (ai-service, ~3s)
        └── AMQP consumer ──── k6 execution                (worker-backend, ~30s)
              └── AMQP consumer ──── DB insert ──── /analyse  (results-service, ~1s)
```

---

## Troubleshooting

**"View Logs" button opens Grafana but wrong time range**
- Check that `started_at` and `completed_at` are populated on the result — they're set when the worker starts and finishes k6
- Pending or failed tests without a start time fall back to `(now - 1h, now)`

**Metrics API returns 401**
- Verify the Auth header value starts with `Bearer ` (note the space)
- Confirm the service account token has at least Viewer role
- Test with curl: `curl -H "Authorization: Bearer YOUR_TOKEN" "http://localhost:3030/api/datasources/proxy/1/api/v1/query?query=up"`

**Metrics API returns 404 on the datasource proxy**
- Check the datasource ID — run `curl http://localhost:3030/api/datasources` again
- Grafana proxy path format: `/api/datasources/proxy/{id}/` (note: some Grafana versions use `/api/datasources/uid/{uid}/`)

**AI analysis doesn't mention Grafana data**
- The data is included but Gemini may not explicitly call it out if it's not directly relevant
- Check the analyser-service logs for `externalMetrics` field count
- Verify the endpoint returns valid JSON

**Loki query returns no results**
- The job label (`{job="your-app"}`) must match what your application sends to Loki
- Find correct labels: in Grafana Explore, switch to Loki, click **Label browser**
