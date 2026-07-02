# Original Code Specs — Service Tenancy Gaps (Phase 2 Analysis)

Factual gap analysis for Projects C (worker-backend, worker-client) and D (ai-service, analyser-service).
Identifies exactly where project_id is present, absent, or lost in the RabbitMQ message pipeline.
No design decisions, no recommendations. Every claim is cited to file:line.

---

## Summary Table

| Gap Question | Finding |
|--------------|---------|
| Does `EnrichedTestRequest` include `project_id`? | YES — `packages/shared/src/index.ts:64` |
| Does worker-backend `saveScript()` write `project_id`? | YES (new scripts only); NO on REUSE path |
| Does worker-backend result published to `test-results` carry `project_id`? | YES — `worker-backend/src/index.ts:385` |
| Does worker-client result published to `test-results` carry `project_id`? | NO — explicit gap at `worker-client/src/index.ts:374` |
| Does `handleResult()` in results-service receive/store `project_id`? | [UNKNOWN — consumer.ts not read; see Gap C-4] |
| Does analyser-service receive/use project context? | NO |
| Does ai-service pass project context between queue messages? | YES — message passed through intact |

---

## Project C — worker-backend (Gap Analysis)

### C.1 File Covered

`services/worker-backend/src/index.ts`

---

### C.2 Gap Question 1: Does the RabbitMQ message payload (`EnrichedTestRequest`) include `project_id`?

**Answer: YES.**

**Type definition (packages/shared/src/index.ts:51-66):**
```typescript
export interface TestRequest {
  id: string;
  type: TestType;
  targetUrl: string;
  description: string;
  options: BackendTestOptions | ClientTestOptions;
  thresholds?: SLOThresholds;
  steps?: FlowStep[];
  envVars?: Record<string, string>;
  testData?: Array<Record<string, string>>;
  csvData?: string;
  csvFilename?: string;
  customScript?: string;
  projectId?: string;   // <-- line 64
  createdAt: string;
}

export interface EnrichedTestRequest extends TestRequest { ... }  // line 190
```

`EnrichedTestRequest` extends `TestRequest` and therefore inherits `projectId?: string`.

**How it is populated (api-service/src/index.ts:149):**
```typescript
const test: EnrichedTestRequest = {
  ...
  projectId: request.projectId,
  ...
};
```

`request.projectId` is set by the api-service session hook from `session.projectId` (UUID string) in auth mode, or `undefined` in dev mode.

**How the message is consumed (worker-backend/src/index.ts:338-339):**
```typescript
const test: EnrichedTestRequest = JSON.parse(msg.content.toString());
```
The full `EnrichedTestRequest` is deserialized, including `projectId` if present.

---

### C.3 Gap Question 2: Does `saveScript()` in worker-backend write `project_id` to `test_scripts`?

**Answer: YES for new scripts; NO on the REUSE path.**

**`saveScript` function (worker-backend/src/index.ts:46-68):**

```typescript
const saveScript = async (
  targetUrl: string,
  script: string,
  scriptId?: string,
  description?: string,
  projectId?: string,       // <-- parameter at line 51
): Promise<string> => {
  if (scriptId) {
    // REUSE path: only increments used_count, does NOT write project_id
    await pool.query(
      'UPDATE test_scripts SET used_count = used_count + 1, updated_at = NOW() WHERE id = $1',
      [scriptId]
    );
    return scriptId;  // lines 53-58
  }
  // NEW script path: INSERT includes project_id
  const { rows } = await pool.query(
    `INSERT INTO test_scripts (target_url, test_type, script, description, project_id)
     VALUES ($1, 'backend', $2, $3, $4)
     ON CONFLICT (target_url, test_type) DO UPDATE
     SET script = EXCLUDED.script, description = EXCLUDED.description, updated_at = NOW()
     RETURNING id`,
    [targetUrl, script, description ?? null, projectId ?? null]  // line 66
  );
  return rows[0].id;  // lines 60-68
};
```

**The `ON CONFLICT ... DO UPDATE` on the new-script path does NOT update `project_id`.** If a script row already exists (from a previous run with `project_id = null`), the conflict fires and only updates `script`, `description`, and `updated_at`. The existing `project_id = null` is preserved. Line 63-65.

**[GAP C-2a]:** When `saveScript` is called on the REUSE path (`scriptId` present), `project_id` is not updated on the existing script row. The script row retains its original `project_id` value (likely `null` for worker-inserted rows from before auth was added).

**[GAP C-2b]:** When `saveScript` is called on the new-script path with a conflict (`ON CONFLICT DO UPDATE`), the `project_id` column is NOT in the `DO UPDATE SET` clause. Existing rows keep their original `project_id`.

**How `saveScript` is called (worker-backend/src/index.ts:371-372):**
```typescript
const scriptSaveKey = test.scriptCacheKey ?? test.targetUrl;
const scriptId = await saveScript(scriptSaveKey, test.generatedScript!, test.scriptId, test.description, test.projectId);
```
`test.projectId` is passed — so the intent is there, but the `ON CONFLICT` gap means it only applies to brand-new rows with no conflict.

---

### C.4 Gap Question 3: Does worker-backend's result published to `test-results` carry `project_id`?

**Answer: YES.**

**Message published to `test-results` queue (worker-backend/src/index.ts:383-387):**
```typescript
channel.sendToQueue(
  RESULTS_QUEUE,
  Buffer.from(JSON.stringify({
    ...result,
    scriptId,
    reusedScript: test.reusedScript,
    thresholds: test.thresholds,
    projectId: test.projectId    // <-- explicit line 385
  })),
  { persistent: true }
);
```

`test.projectId` is explicitly spread into the published message object at line 385. Present as `projectId?: string` — will be `undefined` in dev mode or when no session was active.

---

### C.5 Gap Summary — worker-backend

| Item | File:line | Gap type |
|------|-----------|----------|
| `saveScript` REUSE path: no `project_id` update | `index.ts:53-58` | Silent — script row retains original project_id |
| `saveScript` ON CONFLICT: `project_id` not in UPDATE SET | `index.ts:63-65` | Silent — existing `null` project_id preserved on script update |
| `test-results` message: `projectId` explicitly included | `index.ts:385` | Not a gap |
| Incoming message: `EnrichedTestRequest.projectId` available | `index.ts:338` | Not a gap |

---

## Project C (continued) — worker-client (Gap Analysis)

### C.6 File Covered

`services/worker-client/src/index.ts`

---

### C.7 Gap Question: Does worker-client's result published to `test-results` carry `project_id`?

**Answer: NO. This is a gap.**

**Message type consumed (worker-client/src/index.ts:348):**
```typescript
const test: TestRequest = JSON.parse(msg.content.toString());
```

**[GAP C-7a]:** Worker-client uses `TestRequest` (not `EnrichedTestRequest`) as the typed variable. `TestRequest` includes `projectId?: string` (inherited), so the field IS present in the deserialized JSON if the sender included it. The typing does not prevent access.

**Result object constructed (worker-client/src/index.ts:365-372):**
```typescript
const result: TestResult = {
  testId: test.id,
  targetUrl: test.targetUrl,
  status: 'completed',
  metrics,
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
};
```

`projectId` is **not** included in the `result` object.

**Message published (worker-client/src/index.ts:374):**
```typescript
channel.sendToQueue(
  RESULTS_QUEUE,
  Buffer.from(JSON.stringify({ ...result, thresholds: test.thresholds })),
  { persistent: true }
);
```

Only `...result` and `test.thresholds` are spread into the message. `test.projectId` is NOT included. The `test-results` message from worker-client has no `projectId` field.

**[GAP C-7b]:** Even though `test.projectId` is available at line 348 (because it was sent in the queue message by ai-service, which passes through the `EnrichedTestRequest` unchanged), it is never added to the result object or the published message.

**Exact location of the gap:** `worker-client/src/index.ts:374` — the spread `{ ...result, thresholds: test.thresholds }` needs `projectId: test.projectId` to be added.

**What value would need to be threaded through:** `test.projectId` (type `string | undefined`, present in the deserialized message as `(test as TestRequest).projectId` or more safely `(test as EnrichedTestRequest).projectId`).

---

### C.8 Worker-client vs. worker-backend Comparison

| Aspect | worker-backend | worker-client |
|--------|---------------|---------------|
| Message type variable | `EnrichedTestRequest` (`index.ts:338`) | `TestRequest` (`index.ts:348`) |
| `projectId` available from message | Yes | Yes (in JSON, but typed as `TestRequest`) |
| `projectId` in published result | YES — explicit `projectId: test.projectId` (`index.ts:385`) | NO — gap at `index.ts:374` |
| `saveScript` equivalent | Yes, writes `project_id` | No `saveScript` — no script persistence |

---

## Project D — ai-service (Gap Analysis)

### D.1 File Covered

`services/ai-service/src/index.ts`

---

### D.2 Gap Question: Does ai-service pass project context between queue messages?

**Answer: YES — by passthrough. The `EnrichedTestRequest` is forwarded intact.**

**Message consumed from `ai-requests` (ai-service/src/index.ts:123):**
```typescript
let test: EnrichedTestRequest = JSON.parse(msg.content.toString());
```

**REUSE path — message forwarded to target queue (ai-service/src/index.ts:149-152):**
```typescript
const reused: EnrichedTestRequest = { ...test, generatedScript: test.cachedScript, reusedScript: true };
channel.sendToQueue(targetQueue, Buffer.from(JSON.stringify(reused)), { persistent: true });
```
The spread `{ ...test, ... }` includes `test.projectId` (if present). `projectId` flows through unchanged.

**REGENERATE path — message forwarded after script generation (ai-service/src/index.ts:164-166):**
```typescript
const enrichedTest: EnrichedTestRequest = { ...test, generatedScript: script };
channel.sendToQueue(targetQueue, Buffer.from(JSON.stringify(enrichedTest)), { persistent: true });
```
Again, `{ ...test, ... }` spreads all fields including `projectId`.

**Mutation of `test` on REGENERATE branch (ai-service/src/index.ts:156):**
```typescript
test = { ...test, scriptId: undefined };
```
Only `scriptId` is cleared. `projectId` is preserved.

**DLQ exhaustion path (ai-service/src/index.ts:184):**
```typescript
channel.sendToQueue(DLQ, msg.content, { persistent: true });
```
`msg.content` is the original, unmodified buffer — includes `projectId`.

**Conclusion:** ai-service is a transparent passthrough for `projectId`. It does not read, modify, or use `projectId` for any logic. No gaps in propagation.

---

### D.3 ai-service does NOT use project context for

- Script generation (`generateScript` / `compareDescriptions`) — no project context passed to Gemini
- Queue routing — target queue (`backend-tests` or `client-tests`) is determined by `test.type` only
- Status messages — `POST /results/:testId/message` calls use `test.id` only
- Health checks — `GET /health` returns queue connection status only

---

## Project D (continued) — analyser-service (Gap Analysis)

### D.4 File Covered

`services/analyser-service/src/index.ts`

---

### D.5 Gap Question: Does analyser-service receive or use project context?

**Answer: NO.**

**`POST /analyse` endpoint body type (analyser-service/src/index.ts:24-38):**
```typescript
interface AnalyseBody {
  testId: string;
  targetUrl: string;
  type: string;
  metrics: BackendMetrics | ClientMetrics;
  previousMetrics: BackendMetrics | ClientMetrics | null;
  thresholds?: SLOThresholds | null;
  externalMetrics?: ExternalMetricSource[];
}
```

`projectId` is NOT a field in `AnalyseBody`. The analyser-service receives no project context in its request body.

**Caller of analyser-service:** results-service's `consumer.ts` calls `POST /analyse` (URL: `http://analyser-service:3008/analyse`). That caller constructs the request body from the test result message — and could potentially include `projectId`, but the `AnalyseBody` interface does not declare it, and any extra field would be silently ignored.

**[GAP D-5a]:** analyser-service `POST /analyse` accepts no `projectId`. Even if results-service passes one, the analyser does not use it for any scoping, quota tracking, or AI prompt personalization.

**Authentication on `/analyse` endpoint:** None. No API key auth, no session auth. The endpoint is assumed to be internal-only (accessible only within Docker network). `GET /health` is also unauthenticated.

**[GAP D-5b]:** analyser-service has no authentication. Any service or external actor on the same Docker network can call `POST /analyse` with arbitrary metrics.

---

### D.6 analyser-service does NOT use project context for

- Deterministic analysis (`analyzeResult`) — processes raw metrics, no project context
- AI insights (`generateAiInsights`) — generates Gemini prompt from metrics; no project context
- Rate limiting — Gemini calls are not rate-limited per project
- Audit logging — no project identifier in any log output visible in `index.ts`

---

## Consolidated Gap Register

| Gap ID | Service | File:line | Description | What would need to be threaded |
|--------|---------|-----------|-------------|-------------------------------|
| C-2a | worker-backend | `index.ts:53-58` | `saveScript` REUSE path: `project_id` not updated on script row | No change needed for REUSE (used_count only) |
| C-2b | worker-backend | `index.ts:63-65` | `saveScript` ON CONFLICT: `project_id` not in `DO UPDATE SET` clause | Add `project_id = EXCLUDED.project_id` to UPDATE SET if desired |
| C-7a | worker-client | `index.ts:348` | Message typed as `TestRequest` not `EnrichedTestRequest` — projectId is in JSON but not in TS type | Change type annotation to `EnrichedTestRequest` |
| C-7b | worker-client | `index.ts:374` | `projectId` not spread into published `test-results` message | Add `projectId: (test as EnrichedTestRequest).projectId` to the spread |
| D-5a | analyser-service | `index.ts:24-38` | `AnalyseBody` has no `projectId` field | Add `projectId?: string` to `AnalyseBody` if needed |
| D-5b | analyser-service | `index.ts:40-70` | No auth on `POST /analyse` or `GET /health` | Out of scope for tenancy; SSRF concern only |

**Not gaps (working correctly):**

| Item | Service | File:line | Reason |
|------|---------|-----------|--------|
| `EnrichedTestRequest` includes `projectId` | shared | `index.ts:64` | Field present and documented |
| ai-service passes `projectId` through intact | ai-service | `index.ts:149, 164` | Spread preserves all fields |
| worker-backend publishes `projectId` in result | worker-backend | `index.ts:385` | Explicit inclusion |
| api-service injects `projectId` into test | api-service | `index.ts:149` | From session hook |
| results-service stores `projectId` from pending body | results-service | `app.ts:289-292` | Direct insert |

---

## Pipeline Trace: project_id Flow End-to-End

### Happy path (auth mode, backend test, new script)

```
User login → results-service POST /auth/login
  → findOrCreateProject() → projectId UUID
  → SessionPayload.projectId = UUID
  → alt_session cookie set

UI POST /api/tests → api-service POST /tests
  → session hook: request.projectId = session.projectId    [api-service/index.ts:78]
  → EnrichedTestRequest.projectId = request.projectId     [api-service/index.ts:149]
  → fetch POST /results/pending with projectId            [api-service/index.ts:164]
    → results-service: INSERT test_results(project_id)    [results-service/app.ts:289-292]
  → publishTest(test, false)                              [api-service/index.ts:188]

RabbitMQ ai-requests → ai-service
  → test = EnrichedTestRequest (projectId present)        [ai-service/index.ts:123]
  → generateScript(test)
  → sendToQueue backend-tests { ...test, generatedScript }  [ai-service/index.ts:164-166]
    projectId flows through in spread

RabbitMQ backend-tests → worker-backend
  → test.projectId available                              [worker-backend/index.ts:338]
  → runK6Test(...)
  → saveScript(key, script, undefined, desc, test.projectId)
    → INSERT test_scripts(project_id) = test.projectId    [worker-backend/index.ts:61-66]
  → sendToQueue test-results { ...result, projectId: test.projectId }  [worker-backend/index.ts:385]

RabbitMQ test-results → results-service consumer
  → handleResult() saves projectId to test_results.project_id  [consumer.ts — not fully read]
```

### Gap path (auth mode, client-side test)

```
... (same up through ai-service) ...

RabbitMQ client-tests → worker-client
  → test.projectId available in JSON                      [worker-client/index.ts:348]
  → runClientTest(test)
  → result object: NO projectId                           [worker-client/index.ts:365-372]
  → sendToQueue test-results { ...result, thresholds }    [worker-client/index.ts:374]
    projectId MISSING from message ← GAP C-7b

RabbitMQ test-results → results-service consumer
  → handleResult() receives message with no projectId
  → test_results.project_id stored as NULL for all browser tests
```

---

## Unknowns

| ID | Type | Description | Evidence |
|----|------|-------------|----------|
| X-U1 | Unknown | `results-service/src/consumer.ts` was not read in this analysis. It is cited in Phase 1 specs (`reference-code-specs-project-isolation.md` Section 6) as saving `projectId` to `test_results.project_id`. That claim is assumed correct based on Phase 1 output, not re-verified here. | Phase 1 spec section 6 |
| X-U2 | Unknown | The `scripts.ts` `findExistingScript` function in api-service is called with `request.projectId` as the last argument (`index.ts:206`). Whether `findExistingScript` uses it to filter the script lookup is not analyzed in this phase. If it does, and `test_scripts.project_id` is null for all worker-inserted scripts, then no script cache hits would occur for authenticated users. | `api-service/index.ts:206` |
| X-U3 | Unknown | `worker-client` typed the incoming message as `TestRequest` at line 348. The actual JSON on the wire is an `EnrichedTestRequest` (sent by ai-service). All `EnrichedTestRequest` fields (including `projectId`) are present in the JSON but not in the TypeScript type. This creates a type-safety gap where accessing `(test as TestRequest).projectId` would work at runtime but requires a cast. | `worker-client/index.ts:348`, `ai-service/index.ts:166` |
