# Original Code Specs — Auth and Tenancy (Phase 2 Analysis)

Factual specification of auth and tenancy code in Projects A (results-service), B (api-service),
E (recorder-service), F (UI), and G (shared types). No design decisions, no recommendations.
Every claim is cited to file:line.

---

## Project A — results-service Auth + Tenancy

### A.1 Files Covered

| File | Role |
|------|------|
| `services/results-service/src/app.ts` | Fastify app factory, `onRequest` hook, auth routes, all resource endpoints |
| `services/results-service/src/db.ts` | `createSchema`, `findOrCreateProject`, all migrations |
| `services/results-service/src/__tests__/auth.test.ts` | 18 integration tests for auth and middleware |
| `services/results-service/src/__tests__/api.test.ts` | 64 integration tests for REST endpoints |

---

### A.2 App Factory

**File:** `services/results-service/src/app.ts:21-24`

```typescript
export const buildApp = async (
  pool: Pool,
  opts: { logger?: boolean; readPool?: Pool } = {}
): Promise<FastifyInstance>
```

**Business purpose:** Creates and fully configures the Fastify HTTP server. Registers CORS, cookie plugin, WebSocket server, and all `onRequest` hooks. Returns a ready-to-listen `FastifyInstance`.

**Callers:**
- `services/results-service/src/index.ts` — production startup, called with primary pool after `initDb()`.
- `services/results-service/src/__tests__/auth.test.ts:31` — test setup with Testcontainers pool.
- `services/results-service/src/__tests__/api.test.ts:30` — test setup with Testcontainers pool.

**Parameters:**
- `pool: Pool` — primary read/write PostgreSQL pool (required).
- `opts.readPool?: Pool` — optional read replica. When absent, primary pool is used for all queries. `rPool = opts.readPool ?? pool` at `app.ts:26`.
- `opts.logger?: boolean` — controls Fastify's built-in Pino logger. Defaults to `false` when not provided.

**Framework features used:**
- `@fastify/cors` — registered at `app.ts:30` with `ALLOWED_ORIGIN` env var and `credentials: true`.
- `@fastify/cookie` — registered at `app.ts:31`. Provides `request.cookies` and `reply.setCookie/clearCookie`.
- `app.addHook('onRequest', ...)` — single hook registered at `app.ts:47`.

**Fastify request augmentation** (`app.ts:14-19`):
```typescript
declare module 'fastify' {
  interface FastifyRequest {
    session: SessionPayload | null;
    projectId: string | undefined;
  }
}
```
Both `session` and `projectId` are attached to every request after the hook runs.

---

### A.3 `onRequest` Hook

**File:** `services/results-service/src/app.ts:47-70`

**Signature (anonymous async function):**
```typescript
app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => void)
```

**Execution order:**
1. Check if URL is an auth route (`/auth/login`, `/auth/logout`, `/auth/me`) → `return` (skip all auth).
2. Check `isInternal(url)` → `return` (skip all auth).
3. If `apiKeys.length > 0`: check `x-api-key` header → 401 on miss/mismatch.
4. If `sessionSecret !== ''`: call `verifySession()` → 401 on null; set `request.session` + `request.projectId` on success.
5. If `sessionSecret === ''` (dev mode): set `request.session = null`, `request.projectId = undefined`.

**Exemption sets** (`app.ts:41-45`):

Auth routes (always exempt):
```typescript
if (url === '/auth/login' || url === '/auth/logout' || url === '/auth/me') return; // line 49
```

Internal paths set (`app.ts:41`):
```typescript
const internalPaths = new Set(['/health', '/system/ai-status', '/results/pending', '/ws'])
```

Internal suffixes (`app.ts:42`):
```typescript
const internalSuffixes = ['/running', '/fail', '/message', '/live', '/cancel']
```

`isInternal(url)` function (`app.ts:43-45`): strips query string (`url.split('?')[0]`), checks `internalPaths.has(stripped)` OR `internalSuffixes.some(s => stripped.endsWith(s))`.

**Secret/key parsing (startup, app.ts:37-38):**
```typescript
const sessionSecret = process.env.SESSION_SECRET || '';
const apiKeys = (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
```

**State set on request after successful session check (app.ts:64-65):**
```typescript
request.session = session;       // SessionPayload object
request.projectId = session.projectId;  // UUID string
```

**State set in dev mode (app.ts:67-68):**
```typescript
request.session = null;
request.projectId = undefined;
```

**Edge case — API key + session both configured:** API key check runs first (line 53-57). If API key check fails, 401 is returned and session check never runs. If API key check passes (or is not configured), session check runs. No test covers this combined scenario.

**Edge case — internal suffix matching:** `url.split('?')[0].endsWith(s)` — a URL like `/results/abc123/live?foo=bar` strips the query string first, then checks suffix. Line 44-45.

---

### A.4 Auth Routes

#### `POST /auth/login`

**File:** `services/results-service/src/app.ts:73-97`

**Fastify route declaration:**
```typescript
app.post<{ Body: { username: string; projectName: string } }>('/auth/login', async (request, reply) => { ... })
```

**Body fields:** `username: string`, `projectName: string` — read from `request.body ?? {}` at line 76.

**Validation (lines 77-79):** Returns HTTP 400 `{ error: 'username and projectName are required' }` if either field is falsy after `.trim()`.

**Dev mode branch (lines 80-83):** When `sessionSecret === ''`, returns `{ projectId: 'dev', username: username.trim(), projectName: projectName.trim() }` with no cookie set.

**Auth mode branch (lines 84-96):**
1. Calls `findOrCreateProject(projectName.trim(), pool)` — line 84. Note: `projectName.trim()` is passed; `findOrCreateProject` itself also calls `.trim().toLowerCase()` on its argument (`db.ts:212`), so the effective stored name is `projectName.trim().toLowerCase()`.
2. Builds `SessionPayload`: `{ projectId, username: username.trim(), projectName: projectName.trim().toLowerCase() }` — line 85.
3. Calls `signSession(payload, sessionSecret)` — line 86.
4. Sets `alt_session` cookie with attributes (lines 87-94):

| Attribute | Value | Source line |
|-----------|-------|-------------|
| `httpOnly` | `true` | 88 |
| `sameSite` | `'strict'` | 89 |
| `path` | `'/'` | 90 |
| `secure` | `process.env.NODE_ENV === 'production'` | 91 |
| `maxAge` | `2592000` (30 × 24 × 60 × 60 s) | 92 |
| `domain` | `.${process.env.DOMAIN}` if DOMAIN set | 93 |

5. Returns `payload` as JSON response body — line 95.

**Tests (auth.test.ts:49-97):**
- 400 missing username — line 51
- 400 missing projectName — line 56
- 400 both whitespace — line 62
- 200 success, returns username/projectName/projectId — line 67
- Sets HttpOnly alt_session cookie — line 80
- Same projectName produces same projectId on second login — line 91
- One row in `projects` table for same projectName — line 94

#### `POST /auth/logout`

**File:** `services/results-service/src/app.ts:99-102`

```typescript
app.post('/auth/logout', async (_request, reply) => {
  reply.clearCookie('alt_session', { path: '/' });
  return { ok: true };
});
```

**No body required. No auth check.** Exempt from `onRequest` hook via auth-route check at line 49.

**Tests (auth.test.ts:102-115):** 200 ok, cookie cleared (empty value or Max-Age=0).

#### `GET /auth/me`

**File:** `services/results-service/src/app.ts:104-109`

```typescript
app.get('/auth/me', async (request, reply) => {
  if (!sessionSecret) return { projectId: 'dev', username: 'dev', projectName: 'dev' };
  const session = verifySession(request.cookies?.['alt_session'], sessionSecret);
  if (!session) return reply.code(401).send({ error: 'Not authenticated' });
  return session;
});
```

**Dev mode:** returns hardcoded static `{ projectId: 'dev', username: 'dev', projectName: 'dev' }` regardless of any cookie present.

**Auth mode:** verifies cookie directly (bypasses middleware — route is exempt). Returns payload on success, 401 on failure.

**Note:** Uses `request.cookies?.['alt_session']` (optional chaining on line 106) while the `onRequest` hook uses `request.cookies['alt_session']` (no optional chaining on line 62). Behavior identical since `verifySession` accepts `undefined`.

**Tests (auth.test.ts:120-145; 215-224):**
- 401 no cookie — line 121
- 200 valid cookie from login — line 127
- 401 tampered cookie — line 141
- Dev mode: 200 static response, no cookie required — line 216

---

### A.5 DB Schema and Migrations

**File:** `services/results-service/src/db.ts`

#### `createSchema`

**Signature (db.ts:183):**
```typescript
export const createSchema = async (p: Pool): Promise<void>
```

**Behavior:**
1. Creates `schema_migrations` table with `(version INTEGER PRIMARY KEY, name TEXT, applied_at TIMESTAMPTZ)` — lines 184-190.
2. Queries all applied versions into a `Set<number>` — lines 192-193.
3. Iterates `MIGRATIONS` array (5 entries, versions 1-5); skips applied; runs `migration.up(p)`; inserts row to `schema_migrations` — lines 195-201.
4. Idempotent — all DDL uses `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`.

**Callers:**
- `services/results-service/src/db.ts:205` — `initDb()` wrapper called at service startup.
- `services/results-service/src/__tests__/auth.test.ts:29` — test setup.
- `services/results-service/src/__tests__/api.test.ts:29` — test setup.

#### Migration Version 5 — `projects_and_project_id`

**File:** `services/results-service/src/db.ts:158-178`

Creates `projects` table and adds `project_id` FK to 6 tables:

```sql
CREATE TABLE IF NOT EXISTS projects (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
)
```
Line 162-168.

```sql
ALTER TABLE test_results  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id)
ALTER TABLE test_scripts  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id)
ALTER TABLE test_presets  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id)
ALTER TABLE schedules     ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id)
ALTER TABLE webhooks      ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id)
ALTER TABLE log_sources   ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id)
```
Lines 169-174. All nullable (no `NOT NULL`). No `ON DELETE` clause — default `NO ACTION`.

Indexes created:
```sql
CREATE INDEX IF NOT EXISTS idx_test_results_project_id ON test_results(project_id)   -- line 175
CREATE INDEX IF NOT EXISTS idx_test_scripts_project_id ON test_scripts(project_id)   -- line 176
```

**[UNKNOWN]:** `live_metrics` table has no `project_id` column across all 5 migrations. Live metric data is not project-isolated.

#### `findOrCreateProject`

**File:** `services/results-service/src/db.ts:209-215`

**Signature:**
```typescript
export const findOrCreateProject = async (name: string, p: Pool = pool): Promise<string>
```

**Behavior:**
1. Executes upsert:
   ```sql
   INSERT INTO projects (name) VALUES ($1)
   ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
   RETURNING id
   ```
   with `name.trim().toLowerCase()` as parameter — line 212.
2. Returns `rows[0].id` as UUID string — line 214.

**Note:** The function itself applies `trim().toLowerCase()` — the Phase 1 spec incorrectly attributed this to the caller only. Confirmed at `db.ts:212`.

**Callers:**
- `services/results-service/src/app.ts:84` — `POST /auth/login`, called with `projectName.trim()`. The function then further lowercases that value internally.

**[UNKNOWN]:** The `DO UPDATE SET name = EXCLUDED.name` performs a write even on conflict, generating WAL writes. No test covers concurrent login for the same project.

---

### A.6 Project-Scoped Query Filter Pattern

**Pattern:** `($N::uuid IS NULL OR r.project_id = $N::uuid)`

- `$N` bound to `request.projectId ?? null`
- When `projectId` is `undefined` (dev mode), PostgreSQL receives `null` — the `IS NULL` branch fires, returning all rows
- When `projectId` is a UUID string, returns only matching rows

**Full list of occurrences in `app.ts` (see `reference-code-specs-project-isolation.md` Section 5 for complete table)**

**Endpoints WITHOUT the project filter (isolation gaps):**
- `POST /results/pending` (line 289) — internal; accepts `projectId` in request body and stores directly
- `POST /results/:testId/baseline` (line 439-449) — no filter: cross-project baseline manipulation possible
- `DELETE /results/:testId/baseline` (line 457) — no filter
- `GET /results/:testId/live` (line 391-404) — no filter
- `GET /results/:testId/report.pdf` (line 1132) — no filter: any authenticated user can download any PDF

**[INCONSISTENCY]:** `POST /results/:testId/baseline` and `DELETE /results/:testId/baseline` are not in `internalSuffixes`, so they are subject to session auth, but have no project_id filter in the query body.

---

### A.7 Test Coverage Summary (auth + tenancy relevant)

#### `auth.test.ts` — 18 tests

| Suite | Count |
|-------|-------|
| POST /auth/login | 5 |
| POST /auth/logout | 2 |
| GET /auth/me | 3 |
| Session middleware | 5 |
| Dev mode | 3 |

**Coverage gaps:**
- No test verifies that project A user cannot read project B data (cross-project isolation)
- No test exercises `secure: true` cookie (only fires in `NODE_ENV=production`)
- No test covers combined `API_KEYS` + `SESSION_SECRET` scenario
- No test for `/ws` path exempt behavior
- No test for Unicode/special characters in `username` or `projectName`

#### `api.test.ts` — 64 tests

- Auth is disabled in all tests (`SESSION_SECRET` not set) — `request.projectId` is `undefined` throughout.
- The `($N::uuid IS NULL OR project_id = $N::uuid)` filter with a non-null UUID is never tested.

**Coverage gap:** No integration test covers the authenticated path where only project-scoped rows are returned.

---

### A.8 Unknowns and Assumptions

| ID | Type | Description | Evidence |
|----|------|-------------|----------|
| A-U1 | Unknown | `live_metrics` has no `project_id` column. Live data is not project-isolated. | `db.ts:22-178` |
| A-U2 | Unknown | `POST /results/:testId/baseline` and `DELETE /results/:testId/baseline` lack the project filter. | `app.ts:439-449, 457` |
| A-U3 | Unknown | `GET /results/:testId/report.pdf` lacks the project filter. | `app.ts:1132` |
| A-U4 | Unknown | No server-side session revocation. Sessions are valid until the 30-day client cookie expires. | `app.ts:92` |
| A-U5 | Unknown | `findOrCreateProject` does `name.trim().toLowerCase()` internally; caller also trims. Double-trim is harmless but the Phase 1 spec was wrong about where lowercasing occurs. | `db.ts:212`, `app.ts:84` |
| A-U6 | Unknown | `GET /auth/me` in dev mode ignores any cookie present and always returns hardcoded dev payload. | `app.ts:105` |
| A-U7 | Unknown | `/system/ai-status` (line 129) queries `test_results` with no `project_id` filter — returns status messages from all projects. | `app.ts:131-143` |

---

## Project B — api-service Auth + Routing

### B.1 Files Covered

| File | Role |
|------|------|
| `services/api-service/src/index.ts` | Fastify app factory, API key hook, session hook, POST /tests, cancel |
| `services/api-service/src/__tests__/index.test.ts` | 23 unit tests (mocked queue, scripts, fetch) |

---

### B.2 App Factory

**File:** `services/api-service/src/index.ts:47-256`

```typescript
export const buildApp = async (): Promise<FastifyInstance>
```

Takes no parameters. Reads all configuration from environment variables at call time.

**Fastify request augmentation (index.ts:12-14):**
```typescript
declare module 'fastify' {
  interface FastifyRequest { projectId: string | undefined; }
}
```
Only `projectId` is attached — no `session` field (unlike results-service).

**Plugins registered:**
- `@fastify/cors` — `index.ts:51-55` with `ALLOWED_ORIGIN` env var and `credentials: true`
- `@fastify/cookie` — `index.ts:56`

---

### B.3 API Key Hook

**File:** `services/api-service/src/index.ts:59-68`

```typescript
const apiKeys = (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean); // line 59
if (apiKeys.length > 0) {
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;
    const key = request.headers['x-api-key'];
    if (!key || !apiKeys.includes(key as string)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });
}
```

**Registration:** Conditional — hook is only registered when `API_KEYS` is non-empty. When `API_KEYS` is empty, no hook object is created (differs from results-service which runs an inline conditional check inside an always-registered hook).

**Exempt routes:** Only `/health` (exact match on line 62).

**No session check, no internal paths set** — api-service only performs API key auth at this hook.

---

### B.4 Session Hook

**File:** `services/api-service/src/index.ts:73-82`

```typescript
const sessionSecret = process.env.SESSION_SECRET || '';  // line 70

app.addHook('onRequest', async (request, reply) => {  // always registered
  if (request.url === '/health') return;  // line 74
  if (sessionSecret) {
    const session = verifySession(request.cookies?.['alt_session'], sessionSecret);
    if (!session) return reply.code(401).send({ error: 'Not authenticated' });
    request.projectId = session.projectId;
  } else {
    request.projectId = undefined;
  }
});
```

**Registration:** Always registered (not conditional). Runs as second hook after API key hook.

**Exempt route:** Only `/health` (line 74). No internal-paths set, no suffix exemptions.

**[INCONSISTENCY]:** results-service has an extensive `internalPaths` + `internalSuffixes` exemption set. api-service only exempts `/health`. All other routes (including `POST /tests/:testId/cancel`) require valid session auth. However, the cancel endpoint on api-service is user-facing (called by UI), not server-to-server — so this is correct behavior, not a bug.

**Dev mode (sessionSecret empty, line 80):** sets `request.projectId = undefined`. Unlike results-service, does NOT set `request.session`.

**Note on optional chaining:** `request.cookies?.['alt_session']` (line 76) — optional chaining on `.cookies`. results-service uses `request.cookies['alt_session']` (no optional chaining, line 62). Both are safe because `verifySession` accepts `undefined`.

---

### B.5 `POST /tests` Handler — project_id Propagation

**File:** `services/api-service/src/index.ts:103-236`

**Signature:**
```typescript
app.post<{ Body: Omit<TestRequest, 'id' | 'createdAt'> }>('/tests', async (request, reply) => { ... })
```

**project_id injection (line 149):**
```typescript
const test: EnrichedTestRequest = {
  ...
  projectId: request.projectId,   // set by session hook; undefined in dev mode
  ...
};
```

**Propagation to results-service `POST /results/pending` (line 164):**
```typescript
body: JSON.stringify({
  testId: test.id, type: test.type, targetUrl: test.targetUrl,
  durationSeconds, steps: test.steps, testData: test.testData,
  projectId: test.projectId   // <-- passed here
})
```

**Propagation to RabbitMQ via `publishTest(test, skipAI)` (line 188, 201, 222, 224, 233):**
The entire `EnrichedTestRequest` object (including `projectId`) is serialized and published. `publishTest` is in `queue.ts` and is mocked in tests. No additional filtering of `projectId` from the message occurs.

**`safeTestResponse` function (lines 35-45):** Strips sensitive fields from the HTTP response body:
- `envVars`, `testData`, `csvData`, `csvFilename` — user-provided secrets/data
- `customScript`, `generatedScript`, `cachedScript`, `cachedScriptDescription` — internal pipeline state

**Note:** `projectId` is NOT stripped by `safeTestResponse`. It is visible in the HTTP response.

---

### B.6 Test Coverage Summary

**File:** `services/api-service/src/__tests__/index.test.ts` — 23 tests

| Suite | Count | Auth-relevant content |
|-------|-------|----------------------|
| POST /tests | 9 | Creates pending record with projectId in body; queue/script routing |
| POST /tests — parameterization | 4 | testData/csvData passthrough |
| POST /tests — sensitive fields | 5 | envVars, testData, csvData stripped from response |
| POST /tests/:testId/cancel | 2 | Forwards to results-service + publishes cancel |
| GET /health | 3 | DB/queue health checks |

**Auth hooks are NOT tested** in `index.test.ts`. The test setup creates `buildApp()` with no `SESSION_SECRET` or `API_KEYS` set, so both auth hooks are effectively in dev/disabled mode.

**Coverage gap:** No test covers api-service session auth (401 on missing/invalid cookie). No test covers api-service API key auth.

**Coverage gap:** No test verifies that `projectId` from session is injected into the test request (only tested indirectly via the pending body).

---

### B.7 Unknowns and Assumptions

| ID | Type | Description | Evidence |
|----|------|-------------|----------|
| B-U1 | Unknown | api-service session hook always registered (not conditional on SECRET). Even with empty SECRET, the hook runs and sets `request.projectId = undefined`. No way to disable this hook. | `index.ts:73-82` |
| B-U2 | Unknown | The `POST /tests/:testId/cancel` handler (`index.ts:238-253`) calls `results-service/results/:testId/cancel` via HTTP. This internal call carries NO auth headers — relies on results-service treating the `/cancel` suffix as internal (exempt). | `index.ts:244` |
| B-U3 | Unknown | `findExistingScript` is called with `request.projectId` as last argument (line 206). The scripts query may filter by project but the scripts table has `project_id = null` for worker-inserted scripts (see Project C). | `index.ts:206` |
| B-U4 | Assumption | `import './tracing'` (line 1) must be first. This loads OTel instrumentation. No auth implications; noted because it changes module load order. | `index.ts:1` |

---

## Project E — recorder-service Auth

### E.1 Files Covered

| File | Role |
|------|------|
| `services/recorder-service/src/index.ts` | Full service: API key auth, SSRF validation, recording routes |

---

### E.2 App Factory

**File:** `services/recorder-service/src/index.ts:40-295`

```typescript
export async function buildApp(
  _sessions = sessions,
  _completed = completedResults,
): Promise<FastifyInstance>
```

**Parameters:** `_sessions` and `_completed` are module-level Maps passed for testability.

**Plugins registered:**
- `@fastify/cors` — `index.ts:46-49` with `ALLOWED_ORIGIN || '*'` and `methods: ['GET', 'POST', 'DELETE', 'OPTIONS']`.
- No `@fastify/cookie` registered. No session auth.

---

### E.3 API Key Hook (Phase 22 auth)

**File:** `services/recorder-service/src/index.ts:52-61`

```typescript
const apiKeys = (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
if (apiKeys.length > 0) {
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health' || request.url.startsWith('/viewer/')) return;
    const key = request.headers['x-api-key'];
    if (!key || !apiKeys.includes(key as string)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });
}
```

**Registration:** Conditional — only when `API_KEYS` is non-empty. Same pattern as api-service.

**Exempt routes:**
- `/health` — exact match
- `/viewer/:id` — starts-with check (`request.url.startsWith('/viewer/')`) — line 55

**[DIFFERENCE from other services]:** recorder-service uses `startsWith('/viewer/')` rather than an exact match. This means any sub-path under `/viewer/` is exempt. The `/viewer/:id` route serves an HTML page with embedded JavaScript that opens noVNC — exempting it allows the browser to load this page without an API key.

**No session auth.** No `SESSION_SECRET` usage. No cookie plugin. No `request.projectId` injection.

**[UNKNOWN]:** There is no project isolation in recorder-service. Recording sessions are stored in module-level `Map<string, RecordingSessionInternal>` (`sessions`) and `Map<string, { steps, at }>` (`completedResults`). Any authenticated client can access any other client's recording session by ID (UUIDs, so brute-force is impractical but logical isolation is absent).

---

### E.4 SSRF Protection

**File:** `services/recorder-service/src/index.ts:13-24`

Two regex patterns block SSRF targets:
```typescript
const BLOCKED_HOSTNAME_RE = /^(localhost|.*\.local|host\.docker\.internal|.*\.internal|metadata\.google\.internal)$/i;
const PRIVATE_IPV4_RE = /^(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|127\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+)$/;
```

`validateRecorderUrl(raw: string): string | null` — returns error string on failure, null on pass.

Used only in `POST /recordings/start` when `targetUrl` is provided in the body (line 90).

**[UNKNOWN]:** SSRF validation is applied to `targetUrl` in `POST /recordings/start` body only. The browser inside the container can navigate to any URL once launched — the validation only affects the initial auto-navigation.

---

### E.5 Routes Protected vs. Exempt

| Route | Method | Protected by API key | Notes |
|-------|--------|---------------------|-------|
| `/health` | GET | Exempt | Returns `{ status: 'ok', sessions: count, gemini: ... }` |
| `/viewer/:id` | GET | Exempt (startsWith) | Serves HTML control panel page |
| `/recordings/start` | POST | Protected | Launches Puppeteer session |
| `/recordings/:id` | GET | Protected | Polls session status |
| `/recordings/:id/stop` | POST | Protected | Stops session, runs AI correlation |
| `/recordings/:id` | DELETE | Protected | Aborts session |

---

### E.6 Unknowns and Assumptions

| ID | Type | Description | Evidence |
|----|------|-------------|----------|
| E-U1 | Unknown | No session auth, no project_id. Recording sessions have no project ownership. Any user with an API key can access any session by ID. | `index.ts:52-61` |
| E-U2 | Unknown | Completed results are stored in module-level Map with 10-minute TTL (`index.ts:31`). Lost on process restart. No DB persistence. | `index.ts:30-36` |
| E-U3 | Unknown | SSRF validation applies only to initial `targetUrl` in `POST /recordings/start`. Browser CDP can navigate anywhere once launched. | `index.ts:89-94` |

---

## Project F — UI Auth

### F.1 Files Covered

| File | Role |
|------|------|
| `services/ui/lib/AuthContext.tsx` | React context: `AuthProvider`, `useAuth` hook |
| `services/ui/app/login/page.tsx` | Login page component |
| `services/ui/lib/api.ts` (auth portion) | `AuthUser`, `login`, `logout`, `getMe` |
| `services/ui/__tests__/AuthContext.test.tsx` | 6 unit tests for `AuthProvider` and `AuthGate` |
| `services/ui/__tests__/LoginPage.test.tsx` | 5 unit tests for `LoginPage` |

---

### F.2 `AuthUser` Interface

**File:** `services/ui/lib/api.ts:523`

```typescript
export interface AuthUser { projectId: string; username: string; projectName: string }
```

Mirrors `SessionPayload` from results-service/session.ts exactly. Defined in the UI's own `api.ts` — not imported from `@alt/shared`.

---

### F.3 API Functions

**File:** `services/ui/lib/api.ts`

#### Base fetch wrapper `f`

**Lines 12-17:**
```typescript
const authHeaders = (): Record<string, string> =>
  API_KEY ? { 'X-API-Key': API_KEY } : {};

const f = (url: string, init?: RequestInit) =>
  fetch(url, { ...init, credentials: 'include', headers: { ...authHeaders(), ...(init?.headers ?? {}) } });
```

**`credentials: 'include'`** — ensures the `alt_session` cookie is sent with every request, including cross-origin requests.

**`API_KEY`** — read from `import.meta.env.VITE_API_KEY || ''` (line 10). If set, adds `X-API-Key` header to every request.

**Base paths (lines 6-8):**
```typescript
const API_URL     = '/api';      // routes to api-service via Vite proxy
const RESULTS_URL = '/data';     // routes to results-service via Vite proxy
```

All auth API calls go to `RESULTS_URL` (results-service).

#### `login`

**File:** `services/ui/lib/api.ts:525-530`

```typescript
export const login = (username: string, projectName: string): Promise<AuthUser> =>
  f(`${RESULTS_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, projectName }),
  }).then(r => r.json());
```

Returns the parsed JSON body (`AuthUser`) from `POST /data/auth/login`. Does NOT check `r.ok` — if the server returns 400 (validation error), `r.json()` still resolves (with the error body, not an AuthUser).

**[UNKNOWN]:** `login()` does not check `r.ok` before calling `.json()`. If the server returns a 4xx error with a JSON body `{ error: '...' }`, the promise resolves to that error body rather than rejecting. The caller (`LoginPage`) catches errors via `try/catch` — this scenario would silently set user to `{ error: '...' }` rather than triggering the catch. However in practice, `LoginPage` calls `login()` and passes the result to `setUser()` — a non-AuthUser shape would break the session.

#### `logout`

**File:** `services/ui/lib/api.ts:532-533`

```typescript
export const logout = (): Promise<void> =>
  f(`${RESULTS_URL}/auth/logout`, { method: 'POST' }).then(() => undefined);
```

#### `getMe`

**File:** `services/ui/lib/api.ts:535-538`

```typescript
export const getMe = (): Promise<AuthUser> =>
  f(`${RESULTS_URL}/auth/me`).then(r => {
    if (!r.ok) throw new Error('Not authenticated');
    return r.json();
  });
```

Throws if `!r.ok` (e.g., 401). This is the only auth function that checks `r.ok`.

---

### F.4 `AuthProvider` and `useAuth`

**File:** `services/ui/lib/AuthContext.tsx`

#### `AuthContextValue` Interface

```typescript
interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  logout: () => Promise<void>;
  setUser: (u: AuthUser | null) => void;
}
```

#### `AuthProvider` Component

**Signature:**
```typescript
export function AuthProvider({ children }: { children: ReactNode }): JSX.Element
```

**State:** `user: AuthUser | null` (null), `loading: boolean` (true).

**On mount (`useEffect`, line 21-25):** Calls `getMe()`:
- Resolves → `setUser(user)`.
- Rejects → `setUser(null)`.
- Always → `setLoading(false)`.

**`logout` function (lines 28-31):** Calls `apiLogout()` then `setUser(null)`. Does not navigate — navigation is left to the consumer.

**Context default value (lines 11-13):** `user: null, loading: true, logout: async () => {}, setUser: () => {}`. Used only when `AuthProvider` is not a parent.

#### `useAuth` Hook

**File:** `services/ui/lib/AuthContext.tsx:15`

```typescript
export const useAuth = () => useContext(AuthContext)
```

Returns `AuthContextValue`. No error thrown if used outside `AuthProvider` — returns the default no-op value.

---

### F.5 `LoginPage` Component

**File:** `services/ui/app/login/page.tsx`

**State:** `username: string`, `projectName: string`, `error: string`, `loading: boolean`.

**Dependencies:** `useNavigate` (react-router-dom), `login` (api.ts), `useAuth` hook.

**`handleSubmit` flow (lines 14-27):**
1. `e.preventDefault()`
2. `setError('')`, `setLoading(true)`
3. Calls `login(username.trim(), projectName.trim())`
4. On success: `setUser(user)` → `navigate('/')`
5. On error: `setError('Login failed — please try again')`
6. Finally: `setLoading(false)`

**UI behavior:**
- `required` HTML attribute on both inputs (lines 43, 53) — browser-level empty field prevention.
- Button disabled when `loading === true` (line 67).

**Tests (LoginPage.test.tsx — 5 tests):**
- Renders username and project inputs — line 27
- Renders Sign in button — line 32
- Calls `login()` with trimmed values — line 38
- Calls `setUser` and navigates on success — line 46
- Shows error on `login()` rejection — line 55
- Disables button while loading — line 65

---

### F.6 `AuthGate` Component

**File:** `services/ui/src/App.tsx` (not directly analyzed — exists by inference from test)

Inferred from `AuthContext.test.tsx:16-21`:
```typescript
function AuthGate() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <Outlet />;
}
```

**Behavior:** Renders `null` while loading, redirects to `/login` when no user, renders `<Outlet />` (child routes) when user present.

**Tests (AuthContext.test.tsx:69-105):**
- Redirects to `/login` when `getMe` rejects — line 70
- Renders protected content when `getMe` resolves — line 88

---

### F.7 Unknowns and Assumptions

| ID | Type | Description | Evidence |
|----|------|-------------|----------|
| F-U1 | Unknown | `login()` does not check `r.ok` before calling `.json()`. A 400 error with JSON body would resolve the promise to `{ error: '...' }` rather than rejecting. | `api.ts:525-530` |
| F-U2 | Unknown | `logout()` calls `setUser(null)` but does not navigate. If the current route is protected by `AuthGate`, the `AuthGate` re-render will redirect to `/login`. But if `logout()` is called from an unprotected route or non-route context, no redirect happens. | `AuthContext.tsx:28-31` |
| F-U3 | Unknown | `useAuth()` returns the context default (`user: null, loading: true, ...`) if used outside `AuthProvider`. No runtime error thrown. Consumers would see `loading: true` indefinitely. | `AuthContext.tsx:11-13, 15` |
| F-U4 | Unknown | `AuthUser` is defined separately in `api.ts:523` and is not imported from `@alt/shared`. If `SessionPayload` in results-service changes, `AuthUser` in the UI must be manually updated. | `api.ts:523` |

---

## Project G — Shared Types (auth/tenancy relevant)

### G.1 Files Covered

| File | Role |
|------|------|
| `packages/shared/src/index.ts` | All shared TypeScript types |

---

### G.2 Auth/Tenancy-Related Types

#### `TestRequest.projectId`

**File:** `packages/shared/src/index.ts:64`

```typescript
export interface TestRequest {
  ...
  projectId?: string;  // set by api-service from session; filters DB scope
  ...
}
```

Optional field. Comment documents the intended propagation path.

#### `TestResult.projectId`

**File:** `packages/shared/src/index.ts:124`

```typescript
export interface TestResult {
  ...
  projectId?: string;  // set by workers from test.projectId; consumer saves it to test_results.project_id
  ...
}
```

Optional field. Comment documents worker-to-consumer propagation.

#### `EnrichedTestRequest`

**File:** `packages/shared/src/index.ts:190-197`

```typescript
export interface EnrichedTestRequest extends TestRequest {
  generatedScript?: string;
  scriptId?: string;
  reusedScript?: boolean;
  scriptCacheKey?: string;
  cachedScript?: string;
  cachedScriptDescription?: string | null;
}
```

Extends `TestRequest` — inherits `projectId?: string`. No additional auth or project-specific fields beyond the inherited one.

**No `SessionPayload` or `AuthUser` type in shared package.** Those types are defined locally in each service (`session.ts` in results-service/api-service, `api.ts` in UI).

---

### G.3 Types NOT in Shared Package

| Type | Location | Note |
|------|----------|------|
| `SessionPayload` | `results-service/src/session.ts` | Duplicated verbatim in `api-service/src/session.ts` |
| `AuthUser` | `ui/lib/api.ts:523` | Mirrors `SessionPayload`; separate definition |

**[INCONSISTENCY]:** `SessionPayload` is defined and duplicated in two backend services. `AuthUser` in the UI mirrors the same shape. Three separate definitions of the same auth identity type exist across the codebase.

---

### G.4 Unknowns and Assumptions

| ID | Type | Description | Evidence |
|----|------|-------------|----------|
| G-U1 | Unknown | `projectId` in both `TestRequest` and `TestResult` is `string | undefined`. There is no `ProjectId` branded type — any string passes type checking. | `index.ts:64, 124` |
| G-U2 | Unknown | `EnrichedTestRequest` has no org, team, or role fields. The only tenancy identifier threaded through the message pipeline is `projectId`. | `index.ts:190-197` |
