# Chaos Report — Service Failure (Local Docker Compose)

- **Date:** 2026-06-09
- **Environment:** Local Docker Compose (Windows 11 / Docker Desktop)
- **Engineer:** V3 QE Chaos Engineer
- **AI Risk Assessment:** LOW (local docker, stop/start of non-data services only; postgres + redis untouched)
- **Method:** stop → observe → restore, per scenario. Health probes executed over the compose
  network via the `results-service` container using Node (host curl/PowerShell to localhost ports
  were unavailable in this session). Auth is enabled (`SESSION_SECRET` set), so probes authenticated
  via `POST /auth/login` to obtain an `alt_session` cookie (same secret signs both api-service and
  results-service).

---

## 1. Baseline Health (before chaos)

`docker compose ps`: all 12 containers `Up`. `GET /system/health` → `healthy: true`, all 7 app
services `ok`:

| Service | Status | Checks |
|---|---|---|
| results-service | ok | database ok, queue ok |
| api-service | ok | database ok, queue ok |
| ai-service | ok | queue ok |
| worker-backend | ok | database ok, queue ok (cpu 1%, mem 53MB) |
| worker-client | ok | queue ok (cpu 2%, mem 136MB) |
| recorder-service | ok | gemini ok |
| analyser-service | ok | gemini configured |

RabbitMQ consumer baseline: `test-results`=1, `ai-requests`=1, `backend-tests`=1, `client-tests`=1.

---

## 2. Per-Scenario Findings

### Scenario A — `analyser-service` down → local-analysis fallback ✅ PASS

- **Action:** `docker compose stop analyser-service`, then submitted a backend test
  (`https://httpbin.org/get`, `9fd5ee94-…`).
- **Observed:** test ran k6 and reached `status=completed`, `perf_status=passed`, with `analysis`
  **populated** from the local deterministic analyzer:
  `{"summary":"Performance is within acceptable thresholds","perfStatus":"passed","diffs":[],"thresholdViolations":[]}`.
  Metrics saved normally (5,493 reqs, p95 399ms, 10×502 categorized as serverError).
- **Code confirmation:** `results-service/src/consumer.ts:222` —
  `callAnalyserService(...) ?? analyzeResult(...)`. `callAnalyserService` (line 73) uses a 12s
  `AbortSignal.timeout` and `catch { return null; }`, so any analyser error/timeout falls through to
  the local `analyzeResult`. Mechanism fired exactly as designed.
- **Recovery:** `docker compose start analyser-service` → `/health` returned `ok` within ~10s.
- **Gap (minor):** the fallback is **completely silent** — no WARN/INFO log line is emitted when
  analyser-service is unreachable. Operationally indistinguishable from a successful AI analysis; the
  saved `analysis` simply lacks the `aiInsights` narrative. See Gap G3.

### Scenario D — `rabbitmq` down → health 503 + reconnect ❌ GAP (most significant finding)

- **Action:** `docker compose stop rabbitmq`, probed both health endpoints repeatedly, then
  `docker compose start rabbitmq` and watched reconnection.
- **Observed during outage:**
  - **api-service `/health` → 503 immediately** and consistently (`queue:disconnected`). ✅ correct.
  - **results-service `/health` → 200 with `queue:ok` the entire time** (still `ok` 40s+ after
    RabbitMQ stopped). ❌ — it never detected the outage.
- **Observed during recovery (the serious part):** RabbitMQ on this host took
  **~116 s** to start its TCP listener (`Time to start RabbitMQ: 115975 ms`; `started TCP listener on
  [::]:5672` at 21:07:01). Meanwhile the reconnect-capable services retry on a **bounded loop** that
  starts at the `connection.on('close')` event and gives up permanently after a fixed number of
  attempts:
  - **api-service:** 20 attempts → last failure 21:06:55 → `"RabbitMQ reconnect failed"`. It exhausted
    its retries **~6 s before** the RabbitMQ listener actually accepted connections, then **stopped
    retrying entirely** and stayed at 503.
  - **ai-service:** 20 attempts → `"RabbitMQ reconnect failed"`. Consumer dead.
  - **worker-backend:** 20 attempts → `"RabbitMQ reconnect failed"`. Consumer dead.
  - **worker-client:** only **10 attempts** (`maxRetries=10`) → `"RabbitMQ reconnect failed"`. Consumer
    dead (gave up even earlier).
  - **results-service:** **0 reconnect attempts** — no close/error handler at all.
- **Post-recovery queue state (after RabbitMQ healthy):** `test-results`=0, `ai-requests`=0,
  `backend-tests`=0, `client-tests`=0 consumers. **The whole platform was silently disconnected from
  the message bus and did not self-heal**, even though RabbitMQ was back up.
- **Manual recovery:** `docker compose restart api-service ai-service worker-backend worker-client
  results-service` → each connected on attempt 1; consumers returned to 1 each; `/system/health` →
  `healthy: true`. (worker-client took ~60s extra to warm up Chromium.)
- **Verdict:** The documented "AMQP reconnect within ~5s" resilience claim does **not** hold when
  RabbitMQ's restart exceeds the bounded retry window — which is exactly what happens on a normal-speed
  RabbitMQ cold start. See Gaps G1 and G2.

### Scenario C — `worker-backend` down → test stays pending, recovers on restore ✅ PASS (with gap)

- **Action:** `docker compose stop worker-backend`, submitted a backend test (`30214614-…`).
- **Observed:** ai-service generated the script and published to `backend-tests`. With the worker down,
  `backend-tests` queue held **1 message, 0 consumers**; the test stayed **`pending`** with
  `status_message = "Script ready — starting test…"`. No crash, no error — graceful degradation via the
  durable queue. ✅
- **Recovery:** `docker compose start worker-backend` → it consumed the queued message; the test
  transitioned to `running` (started_at set, status_message cleared) within seconds and later
  `completed`. ✅ Durable queue preserved work across the outage.
- **Gap:** the expected `"No backend worker is running…"` warning was **not** posted. The
  consumer-count check (`getWorkerConsumerCount` in `api-service/src/queue.ts`) only runs on
  api-service's **direct worker-publish path** (cached-script bypass). When a test routes through
  ai-service (any new/regenerated script), api-service never checks the worker queue and ai-service has
  no such check — so the user sees a stale "Script ready — starting test…" with no indication the
  worker is offline. See Gap G4.

### Scenario B — `ai-service` down → request queues, recovers on restore ✅ PASS (with gap)

- **Action:** `docker compose stop ai-service`, submitted a new-URL backend test (`730d14ba-…`,
  forcing the AI generation path).
- **Observed:** request published to `ai-requests`; queue held **1 message, 0 consumers**; the test
  stayed **`pending`** with an empty `status_message`. The DLQ→failed path (3 retries, 60/120/180s
  backoff → `"Script generation failed after 3 attempts"`) was **not** exercised here because that
  retry counting happens *inside* ai-service's consumer — with ai-service stopped, the message simply
  waits in the queue (it does not auto-DLQ). The request would only fail via stale-cleanup after 30 min.
- **Recovery:** `docker compose start ai-service` → it consumed the queued request, generated the
  script, and the test moved to `running`. ✅ Durable queue preserved the request across the full
  outage; then cancelled cleanly via `POST /tests/:id/cancel` (200).
- **Gap:** same silent-pending issue as Scenario C — no "AI worker offline" signal while ai-service is
  down. See Gap G4. (Note: the DLQ-exhaustion path is real but is triggered by Gemini errors *while
  ai-service runs*, not by ai-service being absent.)

---

## 3. Recovery Observations

| Scenario | Recovery action | Time to healthy | Self-healed? |
|---|---|---|---|
| A analyser-service | `start` | ~10 s | Yes (fallback during outage; service auto-recovered) |
| D rabbitmq | `start` rabbitmq (~116s boot) + **manual restart of 5 services** | n/a | **No** — required manual intervention |
| C worker-backend | `start` | seconds; queued test auto-resumed | Yes (durable queue) |
| B ai-service | `start` | seconds; queued request auto-resumed | Yes (durable queue) |

**AMQP reconnect verified?** Partially / negatively. The reconnect *logic* exists and fires (close
event → retry loop) for api-service, ai-service, worker-backend, worker-client. But on a realistic
RabbitMQ restart it **exhausted its bounded retries and gave up permanently**, leaving every service
disconnected. results-service has no reconnect logic at all. Net: the "auto-reconnect within ~5s"
guarantee did not hold.

---

## 4. Gaps Found

- **G1 — Bounded reconnect gives up permanently (HIGH).** api-service / ai-service / worker-backend
  reconnect for 20 attempts (worker-client only 10), then throw `"RabbitMQ reconnect failed"` and never
  retry again. The reconnect is a **one-shot** triggered by a single `connection.on('close')`; once
  `connectQueue()`/`startConsumer()` throws, nothing re-arms it. A RabbitMQ restart slower than the
  retry window (observed: 116s boot vs. retries ending at ~similar time) permanently orphans the
  service. Blast radius: entire platform stops processing tests until all services are manually
  restarted.

- **G2 — results-service has no AMQP close/reconnect handler (HIGH).**
  `results-service/src/consumer.ts:startConsumer` sets `consumerConnected = true` once on connect and
  has **no** `connection.on('close'|'error')` handler. Consequences: (a) `/health` and `/system/health`
  keep reporting `queue:ok` after RabbitMQ dies (false-positive health — confirmed: stayed 200
  throughout Scenario D); (b) the `test-results` consumer dies on RabbitMQ restart and never
  reconnects (confirmed: 0 consumers post-recovery). This contradicts the CLAUDE.md claim that *all*
  queue-connected services reconnect on `connection.on('close')`.

- **G3 — Silent analyser-service fallback (LOW).** `callAnalyserService` swallows all errors with a
  bare `catch { return null; }` (consumer.ts:91-93). No log when analyser-service is unreachable or
  times out, so operators cannot tell AI insights were skipped.

- **G4 — No "worker offline" signal on the AI-routed path (MEDIUM).** The consumer-count warning
  (`getWorkerConsumerCount`) only runs on api-service's direct cached-script bypass. Any test that
  goes through ai-service (new/changed script) gets no warning if worker-backend/worker-client is down;
  the user sees an indefinitely-stale `pending` + "Script ready — starting test…" until 30-min
  stale-cleanup. ai-service performs no worker-availability check before publishing to the worker
  queues.

- **G5 — AI options injection ignored (MEDIUM, observed incidentally, not a chaos finding).** A
  submission with `options:{vus:1,duration:"10s"}` produced a Gemini script with hardcoded stages
  totalling **5 minutes at 50 VUs** (`{1m→50},{3m→50},{1m→0}`). The requested vus/duration were not
  applied to the AI-generated script, so "short" tests run for minutes. Worth a separate ticket.

- **G6 — `duration` type fragility (LOW, observed incidentally).** Posting `duration` as a number
  (instead of `"10s"`) throws `500 "d.match is not a function"` from
  `parseDurationSeconds` (api-service/index.ts:17). Add input validation/coercion and return 400.

---

## 5. Recommendations

For **G1/G2** (the core resilience gaps), apply a single consistent pattern across **all five**
queue-connected services:

1. **Unbounded, capped-backoff reconnect that re-arms itself.** Replace the one-shot 10/20-attempt
   loop with a persistent supervisor: on `connection.on('close')` (and `'error'`), set the
   connected-flag to `false`, then schedule reconnect with exponential backoff capped at e.g. 30s and
   **no maximum attempt limit** (or a very high one with continued retry). The reconnect routine must
   re-attach the same `close`/`error` handlers so subsequent drops also recover.
2. **Add a close/error handler to results-service** (`consumer.ts`) mirroring api-service's
   `setupConnection`: set `consumerConnected = false` on close so health reports `queue:disconnected`,
   and trigger the same reconnect supervisor. This fixes both the false-positive health and the dead
   consumer.
3. **Re-establish channel + consumer on reconnect**, not just the connection — re-run
   `createChannel` / `assertQueue` / `channel.consume` so consumers actually resume.
4. **Make worker-client consistent** — raise its `maxRetries` (currently 10) to match, or better,
   move it to the unbounded supervisor too.
5. **Add a startup-ordering / readiness guard** so a slow RabbitMQ boot (observed 116s) cannot orphan
   dependents; the unbounded reconnect in (1) makes this robust regardless of boot time.

For **G3:** log a WARN (`"analyser-service unreachable — using local analysis fallback"`) in the
`catch` of `callAnalyserService`, and consider surfacing a `analysisSource: "local"|"ai"` field on the
result so the UI/operators know AI insights were skipped.

For **G4:** have ai-service call a worker-consumer-count check (reuse `getWorkerConsumerCount` logic)
before publishing to `backend-tests`/`client-tests`, and post the existing "No … worker is running…"
status_message when count is 0 — so the AI-routed path matches the direct path's UX.

For **G5/G6:** (separate tickets) ensure k6 options (`buildK6Options`) are injected into AI-generated
scripts via `replaceK6Options` regardless of generation path; and validate/coerce `options.duration`
in api-service, returning 400 on malformed input instead of 500.

---

## Summary

| Scenario | Expected | Result |
|---|---|---|
| A — analyser down | local fallback, result saved with analysis | ✅ PASS (silent fallback — G3) |
| D — rabbitmq down | both health 503, reconnect ~5s | ❌ GAP — api 503 OK, results stayed 200 (G2); reconnect exhausted & gave up, no self-heal (G1) |
| C — worker-backend down | warning + stays pending, recovers | ✅ PASS recovery; ⚠️ no warning on AI path (G4) |
| B — ai-service down | queues, eventually fails / recovers | ✅ PASS recovery; ⚠️ silent pending (G4); DLQ-fail path not exercised by absence |

**Most important takeaway:** the message-bus reconnect story is the weakest link. A single RabbitMQ
restart silently disconnected every consumer and required a manual multi-service restart to recover.
Fixing G1 (unbounded re-arming reconnect) and G2 (results-service close handler + honest health) is the
highest-value resilience work. System was fully restored and verified `healthy: true` at end of test.
