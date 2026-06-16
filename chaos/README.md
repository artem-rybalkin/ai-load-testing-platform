# Chaos / Resilience Test Suite

Controlled fault-injection tests for the AI Load Testing Platform. The suite lives in
[`chaos/chaos.test.ts`](./chaos.test.ts) and runs under the repo-root Vitest config
(`chaos/**/*.test.ts` is in the `include` list).

## Running

```bash
# whole chaos suite
npx vitest run chaos/chaos.test.ts

# as part of the full suite
npm test
```

No `docker compose up` is required. Pure-logic gaps use `vi.mock`/`vi.fn`; the two
stateful scenarios (categories 4 and 5) use a **real PostgreSQL** via the shared
Testcontainers container started in `test-support/globalSetup.ts` (Docker must be
running for those two `describe` blocks).

## Design notes

- **No real network / no real RabbitMQ.** The AMQP retry/DLQ routing is re-implemented
  faithfully from `services/results-service/src/consumer.ts` and driven through an
  in-memory `FakeChannel`, so the *decision logic* is exercised without a broker.
- **Real modules where it matters.** `handleResult`, `runStaleCleanup`,
  `checkTestQuota`, `compareDescriptions` and `generateAIText` are the actual production
  functions — only their I/O edges (pg pool, `fetch`, AI SDKs) are mocked.
- The AI fallback-chain cases import the **source** `packages/shared/src/aiProvider.ts`
  (not the built `@alt/shared` barrel) so `vi.doMock` can intercept each provider SDK's
  dynamic `import()`. Importing the compiled barrel would let the real SDK reach the
  network with a dummy key.

## Fault categories, what was tested, and findings

| # | Category | Verdict |
|---|----------|---------|
| 1 | RabbitMQ partition / slow consumer | COVERED |
| 2 | PostgreSQL transient failure | COVERED |
| 3 | AI (Gemini) unavailability + fallback chain | COVERED |
| 3b | `compareDescriptions` safe fallback | COVERED |
| 4 | Worker crash mid-test (stale cleanup) | COVERED (testcontainer) |
| 5 | Cancel race condition | COVERED (testcontainer) |
| 6 | Concurrent submission quota | COVERED |
| 7 | Webhook delivery failure | COVERED |
| 8 | WebSocket reconnect backoff | COVERED |

### 1 — RabbitMQ partition / slow consumer (DLQ retry exhaustion)
**Tested:** the `x-retry-count` header logic from `consumer.ts`. A failing message is
republished with an incremented header for counts `0,1,2`; at count `3` it is treated as
exhausted and routed to `test-results.dlq`. Every delivery is `ack`'d so a poison/slow
message never head-of-line-blocks the queue.
**Finding:** COVERED. The retry/DLQ logic is correct and exhaustion is bounded at 3
retries. (Self-healing of the *connection* itself is **G1/G2** — not re-tested.)

### 2 — PostgreSQL transient failure
**Tested:** `handleResult` against a mock pool whose client throws on the `INSERT`. The
error propagates (the function **throws**) so the AMQP consumer nacks → message is
retried, **not silently dropped**. We also assert the transaction is `ROLLBACK`'d and the
client is `release()`d (no pool leak), then that a subsequent delivery succeeds once the
DB "recovers".
**Finding:** COVERED, no gap. The short-lived transaction in `handleResult` rolls back and
re-throws cleanly, and the consumer's catch block converts the throw into a retry/DLQ.

### 3 — AI (Gemini) provider unavailability
**Tested:** `generateAIText`'s fallback chain — (a) primary 429 → fallback succeeds;
(b) every provider in the chain fails → the **last** error is thrown (never a silent `""`);
(c) no provider configured → throws.
**Finding:** COVERED, no gap. The chain surfaces the last error with `.status` preserved,
so 429 handling upstream still works.

### 3b — `compareDescriptions` safe fallback
**Tested:** `compareDescriptions` returns `REGENERATE` when the provider call throws, and
when the provider returns an unparseable verdict.
**Finding:** COVERED, no gap. Defaulting to `REGENERATE` is the safe choice (regenerate
rather than reuse a possibly-stale script).

### 4 — Worker crash mid-test (real PostgreSQL)
**Tested:** a `running` row with `started_at` 20 min ago is reaped to `failed` by
`runStaleCleanup(15, 30)`, while a freshly-started `running` row is left untouched; a
`pending` row stuck 45 min is also reaped.
**Finding:** COVERED, no gap. Orphaned runs from a crashed worker self-heal within one
60s cleanup tick. (Note: time-to-recovery is bounded by `STALE_RUNNING_MINUTES`, default
15 min — acceptable, but see TODO below for an optional tightening.)

### 5 — Cancel race condition (real PostgreSQL)
**Tested:** the cancel `UPDATE` is guarded by `status IN ('pending','running')`. A cancel
arriving **after** completion affects 0 rows and the status stays `completed`; a cancel
for a still-`running` test flips it to `cancelled`.
**Finding:** COVERED, no gap. The terminal state is protected; late cancels are no-ops as
designed.

### 6 — Concurrent submission quota enforcement
**Tested:** the real `checkTestQuota` (api-service) with a mocked count. With
`maxConcurrentTests = N`, the `N`th in-flight test is allowed and the `N+1`th returns the
"concurrent test limit" message (→ `POST /tests` responds `429`). Also: `teamId`
undefined (dev mode) bypasses quota without querying the DB.
**Finding:** COVERED, no gap.

### 7 — Webhook delivery failure
**Tested:** `handleResult` persists the row (INSERT + COMMIT) even when the analyser is
down **and** every webhook POST rejects with a network error. The webhook rejection is
swallowed by the `.catch(() => {})` fire-and-forget call and never bubbles to the caller.
**Finding:** COVERED, no gap. Result persistence is fully decoupled from webhook delivery.

### 8 — WebSocket reconnect backoff
**Tested:** the recurrence from `ResultsSocketContext.tsx`
(`delay = Math.min(delay * 2, 30_000)`, starting at 1000): the sequence is
`1s, 2s, 4s, 8s, 16s, 30s, 30s, …` (capped at 30s, never exceeded for arbitrarily long
outages), and `onopen` resets the delay to 1s so backoff restarts cleanly after recovery.
**Finding:** COVERED, no gap.

## Summary

All 8 (+1) categories are **COVERED** with passing tests; no new resilience gaps were
discovered beyond the already-hardened G1–G5. The platform degrades gracefully under
broker, DB, AI-provider, worker-crash, cancel-race, quota, webhook, and WebSocket-outage
faults. The one optional improvement worth tracking is reducing mean-time-to-recovery for
crashed-worker runs (currently bounded by the 15-minute `STALE_RUNNING_MINUTES` window).
