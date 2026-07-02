# Original Code Specs — Auth and Tenancy (Phase 2 Analysis)

Factual specification of auth and tenancy code in Projects A (results-service), B (api-service),
E (recorder-service), F (UI), and G (shared types). No design decisions, no recommendations.
Every claim is cited to file:line.

---

## Project A — results-service Auth + Tenancy

### A.1 Files Covered

**Correction note:** The original Phase 1/2 analysis described `app.ts` as a monolithic file containing the `onRequest` hook, all auth routes, and all resource endpoints. `app.ts` has since been split into a thin app factory plus one route-plugin file per concern; it is now 194 lines. Table below reflects the current layout, verified directly against source.

| File | Role |
|------|------|
| `services/results-service/src/app.ts` | Fastify app factory (194 lines): CORS/cookie/rate-limit registration, WebSocket attach, the single `onRequest` auth/tenancy hook, and route-plugin registration. No route handlers live here anymore. |
| `services/results-service/src/routes/auth.ts` | `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/switch-team` (205 lines). |
| `services/results-service/src/routes/teams.ts` | Team + org management: member CRUD, quotas, audit-log listing, per-team API keys, team-level AI provider override, org CRUD (514 lines). Out of scope for this doc beyond what A.3/A.5 need — see `docs/ARCHITECTURE.md` Security Architecture section for a current summary, or read the file directly for exact routes. |
| `services/results-service/src/routes/results.ts` | Result CRUD, live metrics, baseline management, PDF/CSV export — the project-scoped-filter examples in A.6 live here. |
| `services/results-service/src/routes/system.ts` | Health, `/system/ai-status`, `/system/ai-provider`, cross-service `/system/health`. |
| `services/results-service/src/routes/helpers.ts` | `DEV_USER`, `loadUserTeams`, `loadUserOrgs`, `EMAIL_RE`, and other route-plugin-shared helpers (591 lines). |
| `services/results-service/src/session.ts` | Session token mechanism — see Section A.9 (already current, not touched by this pass). |
| `services/results-service/src/db.ts` | `createSchema` (now advisory-lock-guarded), `findOrCreateProject` (now unreferenced — see A.5), 14 migrations. |
| `services/results-service/src/__tests__/auth.test.ts` | 45 tests across 8 `describe` blocks: register, login, logout, me, switch-team, session middleware, dev mode, and a dedicated **cross-team isolation** suite (see A.7). |
| `services/results-service/src/__tests__/api.test.ts` | 122 integration tests for REST endpoints. |

---

### A.2 App Factory

**Correction note:** The signature is unchanged from the original spec, but the body has grown substantially: it now registers `@fastify/rate-limit`, attaches a raw WebSocket server, and registers seven route plugins instead of declaring routes inline. The request augmentation shape also changed — `session: SessionPayload | null` no longer exists (see A.9's correction note on the session mechanism); it has been replaced by four separate fields.

**File:** `services/results-service/src/app.ts:32-35`

```typescript
export const buildApp = async (
  pool: Pool,
  opts: { logger?: boolean; readPool?: Pool } = {}
): Promise<FastifyInstance>
```

**Business purpose:** Creates and fully configures the Fastify HTTP server. Registers CORS, cookie plugin, rate limiting, the WebSocket server, the single `onRequest` auth/tenancy hook (A.3), and every route plugin (auth, teams/orgs, system, results, ai, resources, workspaces). Returns a ready-to-listen `FastifyInstance`.

**Callers:**
- `services/results-service/src/index.ts` — production startup, called with primary pool after `initDb()`.
- `services/results-service/src/__tests__/auth.test.ts` — test setup with Testcontainers pool.
- `services/results-service/src/__tests__/api.test.ts` — test setup with Testcontainers pool.

**Parameters:**
- `pool: Pool` — primary read/write PostgreSQL pool (required).
- `opts.readPool?: Pool` — optional read replica. When absent, primary pool is used for all queries. `rPool = opts.readPool ?? pool` at `app.ts:36`.
- `opts.logger?: boolean` — controls Fastify's built-in Pino logger. Defaults to `false` when not provided.

**Framework features used:**
- `@fastify/cors` — registered at `app.ts:40` with `ALLOWED_ORIGIN` env var, `credentials: true`, and an explicit method list (`GET, POST, PUT, DELETE, OPTIONS`).
- `@fastify/cookie` — registered at `app.ts:41`. Provides `request.cookies` and `reply.setCookie/clearCookie`.
- `@fastify/rate-limit` — registered at `app.ts:68-75`, Redis-backed (`redisClient`), global, `max`/`timeWindow` from env (default 600 req/60s), `skipOnError: true`, with an `allowList` callback that exempts the same internal/public URLs as the auth hook (see A.3). **Not present in the original spec** — this is a new cross-cutting concern.
- `setupWebSocketServer(app.server)` at `app.ts:45` — attaches a raw WebSocket server to Fastify's underlying `http.Server` for `GET /ws`, bypassing Fastify plugins entirely.
- `app.addHook('onRequest', ...)` — single hook registered at `app.ts:77`.
- Route plugins registered at `app.ts:185-191`: `authRoutes`, `teamOrgRoutes`, `systemRoutes`, `resultRoutes`, `aiRoutes`, `resourceRoutes`, `workspaceRoutes` — each an `async (app, { pool, rPool }) => void` Fastify plugin function from `./routes/*`.

**Fastify request augmentation** (`app.ts:19-27`):
```typescript
declare module 'fastify' {
  interface FastifyRequest {
    user: { id: string; email: string; name: string | null } | null;
    projectId: string | undefined;
    role: TeamRole | null;
    orgId: string | null;
    orgRole: OrgRole | null;
  }
}
```
`user` replaces the old `session` field — it holds the resolved DB user row (`id`/`email`/`name`), not the raw session/token. `projectId` still means "current team ID" (kept for naming continuity with the rest of the codebase's propagation — see Project B and G). `role`, `orgId`, and `orgRole` are new: they carry the caller's team role and, if their current team belongs to an organization, the org ID and the caller's role in that org. All five fields are set on every request by the `onRequest` hook (A.3), including the disabled-auth branch.

---

### A.3 `onRequest` Hook

**Correction note:** This hook has grown from a ~24-line, 5-step check into a ~107-line hook that additionally resolves per-team API keys, organization membership, and role-based mutation guards. The old `/auth/login|logout|me` exact-match exemption is gone (replaced by a prefix check on `/auth/`, since there are now five auth routes). Rewritten below against current source.

**File:** `services/results-service/src/app.ts:77-183`

**Signature (anonymous async function):**
```typescript
app.addHook('onRequest', async (request, reply) => { ... })
```

**Execution order:**
1. Strip query string; if URL starts with `/auth/` → `return` (all five auth routes exempt; A.4).
2. If URL is in `publicPaths` (`/health`, `/system/ai-status`, `/ws`) → `return`.
3. If URL is `/system/ai-provider` and method is `GET` → `return` (read-only, polled by ai-service with no session; `PUT` still requires admin — enforced in the handler).
4. If `isInternalCallback(url, method)` is true → check `X-Internal-Key` header against `INTERNAL_API_KEY` (401 on mismatch when configured; no-op when `INTERNAL_API_KEY` is empty) → `return` either way.
5. Per-team API key: if `x-api-key` header is present and not one of the global `API_KEYS`, hash it and look it up in `team_api_keys`. On a hit, sets `request.user = null`, `request.projectId = <team_id>`, `request.role = 'admin'`, `request.orgId = null`, `request.orgRole = null`, bumps `last_used_at` (fire-and-forget), and `return`s — this bypasses the global `API_KEYS`/session checks entirely for that one request.
6. Global `API_KEYS`: if configured and the header is missing/not in the list → 401.
7. Session auth (only if `SESSION_SECRET` configured): `getSession()` (A.9) → 401 on null. Joins `users`/`team_members` for the caller's role in their current team → 401 if the user row is gone. Sets `request.user`, `request.projectId = session.teamId`, `request.role`.
8. **No-team gate:** if `role === null` (no current team, or no longer a member of it) and the URL doesn't start with `/teams` or `/orgs` → 403 `{ error: 'No team selected — create or join a team first' }`.
9. **Org resolution:** if `request.projectId` is set, joins `projects.org_id` → `org_members` for the caller to populate `request.orgId`/`request.orgRole` (left as `null` if the team has no org or the caller isn't an org member).
10. **Mutation role guards** (POST/PUT/PATCH/DELETE only): `/teams/:id/...` mutations require `role === 'admin'` (403 otherwise); all other mutations outside `/teams`, `/orgs`, `/orgs/...` are blocked with 403 if `role === 'viewer'`.
11. Else (no `SESSION_SECRET`, dev mode): `request.user = null`, `request.projectId = undefined`, `request.role = null`, `request.orgId = null`, `request.orgRole = null`.

**Exemption sets** (`app.ts:52, 57-58`):

Public paths (always exempt from all auth):
```typescript
const publicPaths = new Set(['/health', '/system/ai-status', '/ws']);
```

Internal callback paths/suffixes (server-to-server; gated on `X-Internal-Key`, not session/cookie):
```typescript
const internalPaths = new Set(['/results/pending']);
const internalSuffixes = ['/running', '/fail', '/message', '/live', '/cancel', '/log-line'];
```

`isInternalCallback(url, method)` (`app.ts:59-65`): `internalPaths.has(url)` OR (`internalSuffixes.some(s => url.endsWith(s))`, **except** `GET .../live` is explicitly excluded — only the worker's `POST .../live` (pushing live metric points) is treated as internal; the UI's `GET .../live` requires normal session auth and project scoping (see A.6). This is a behavior change from the original spec, which listed `GET /results/:testId/live` as an isolation gap — that gap is now closed.

**Secret/key parsing (startup, app.ts:47-49):**
```typescript
const sessionSecret = process.env.SESSION_SECRET || '';
const apiKeys = (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
const internalApiKey = process.env.INTERNAL_API_KEY || '';
```
`INTERNAL_API_KEY` is new — it did not exist in the original spec's env-var set.

**State set on request after successful session check (app.ts:138-142):**
```typescript
request.user = { id: rows[0].id, email: rows[0].email, name: rows[0].name };
request.projectId = session.teamId ?? undefined;
request.role = rows[0].role;
request.orgId = null;   // populated below if the team belongs to an org
request.orgRole = null;
```

**State set in dev mode (app.ts:176-182):** all five fields reset to their empty values (`null`/`undefined` as appropriate) — see step 11 above.

**Edge case — per-team API key + global API key + session all configured:** per-team key check runs first (most specific), then global `API_KEYS`, then session. Each successful branch `return`s before the next check runs. A per-team key match always grants `role: 'admin'` for that team regardless of the actual `team_members` role of whoever generated the key — per-team keys are a bearer credential scoped to the team, not to an individual user.

**Edge case — per-team API key lookup failure:** the `team_api_keys` query is wrapped in `try/catch` with a comment `// team_api_keys lookup unavailable — fall through to global API key / session checks` (`app.ts:112-114`). A DB error here is silently swallowed rather than surfaced, which could mask a genuine misconfiguration (e.g. a botched migration) as "key not found."

**Edge case — internal suffix matching:** unchanged in spirit from the original spec — `url.split('?')[0].endsWith(s)` strips the query string before the suffix check (`app.ts:78`).

---

### A.4 Auth Routes

**Correction note:** The original spec's login model (`username` + `projectName`, no password, no account concept) is gone entirely. Auth routes now live in a dedicated plugin (`services/results-service/src/routes/auth.ts`, registered as `authRoutes` in `app.ts:185`), cover five endpoints instead of three, and are built around real user accounts: email + bcrypt password hash, multi-team membership, and organizations. All five routes return a `SessionUser` (`@alt/shared`; see A.9 and G.3) rather than the old flat `{ projectId, username, projectName }` payload.

**Shared setup** (`routes/auth.ts:12-22`): `sessionSecret` re-read from env inside the plugin; `AUTH_RATE_LIMIT_MAX` (default 10/min, applied via Fastify route-level `config.rateLimit` on register/login only — new, not in the original spec); `cookieOpts` unchanged in shape from the original spec (`httpOnly: true`, `sameSite: 'strict'`, `path: '/'`, `secure` in production, `maxAge: 30 * 24 * 60 * 60`, optional `domain`).

#### `POST /auth/register`

**File:** `routes/auth.ts:25-99`. **New endpoint — did not exist in the original spec.**

```typescript
app.post<{ Body: { email: string; password: string; name?: string; teamName: string } }>('/auth/register', ...)
```

**Validation:** email required + regex-matched (`EMAIL_RE`, `routes/helpers.ts:554`); password required, minimum 8 characters; `teamName` required.

**Behavior (single DB transaction, `client.query('BEGIN'/'COMMIT'/'ROLLBACK')`):**
1. 409 if the (lowercased) email is already registered.
2. `bcrypt.hash(password, 10)` (`bcryptjs`), inserts into `users`.
3. Inserts a new `projects` row (a "team") from the lowercased `teamName`; 409 on unique-violation (`err.code === '23505'`) — team names are globally unique, same constraint the old `projects.name` had.
4. Inserts a `team_members` row for the new user with `role = 'admin'` — the registering user is always the new team's sole admin.
5. Issues a session (`createSession`, A.9) scoped to the new team, sets the `alt_session` cookie, returns the `SessionUser`.

**Dev mode:** returns the hardcoded `DEV_USER` constant (`routes/helpers.ts:557-565`) with no DB access, no cookie.

#### `POST /auth/login`

**File:** `routes/auth.ts:102-141`

```typescript
app.post<{ Body: { email: string; password: string } }>('/auth/login', ...)
```

**Body fields:** `email`, `password` — no longer `username`/`projectName`.

**Validation:** 400 `{ error: 'email and password are required' }` if either is missing.

**Behavior:**
1. Looks up the user by lowercased email; 401 `{ error: 'Invalid email or password' }` if not found.
2. `bcrypt.compare(password, password_hash)`; same 401 on mismatch (no user-enumeration distinction between "no such email" and "wrong password").
3. Loads all teams (`loadUserTeams`) and orgs (`loadUserOrgs`) the user belongs to; `currentTeamId` defaults to the first team (`teams[0].id`) or `null` if the user has no teams.
4. Issues a session scoped to `currentTeamId`, sets the cookie, returns the `SessionUser`.

**Dev mode:** returns `DEV_USER`, as above.

**Tests (auth.test.ts, `describe('POST /auth/login')` at line 115):** covers missing fields, wrong password, unknown email, successful login with multi-team users, and that `currentTeamId` defaults sensibly.

#### `POST /auth/logout`

**File:** `routes/auth.ts:144-148`

```typescript
app.post('/auth/logout', async (request, reply) => {
  if (sessionSecret) await revokeSession(pool, request.cookies?.['alt_session']);
  reply.clearCookie('alt_session', { path: '/' });
  return { success: true };
});
```

Now calls `revokeSession` (A.9) — genuine server-side revocation, not just a client-side cookie clear as in the original HMAC-cookie era. Response body key is `success`, not the old `ok`.

#### `GET /auth/me`

**File:** `routes/auth.ts:151-170`

Dev mode returns `DEV_USER` unconditionally (ignores any cookie, same behavior class as the original spec noted, just a different literal payload). Auth mode calls `getSession` (A.9), 401 on null or if the user row is gone, then re-loads teams/orgs/role fresh from the DB on every call (not cached on the token) and returns a `SessionUser`.

#### `POST /auth/switch-team`

**File:** `routes/auth.ts:173-204`. **New endpoint — did not exist in the original spec** (there was only ever one project per login before).

```typescript
app.post<{ Body: { teamId: string } }>('/auth/switch-team', ...)
```

Validates the caller is actually a member of `teamId` (403 `{ error: 'Not a member of this team' }` otherwise), then calls `switchSessionTeam` (A.9) to update `sessions.team_id` in place — no new token is issued, so the cookie value doesn't change. Returns the refreshed `SessionUser` with `currentTeamId`/`role` reflecting the new team.

**Tests:** `auth.test.ts` has one `describe` block per route above (`register`, `login`, `logout`, `me`, `switch-team`), plus `Session middleware`, `Auth dev mode`, and a new **`Cross-team isolation`** suite (line 380) — 45 `it()` cases total. The cross-team isolation suite directly closes the coverage gap the original spec flagged ("No test verifies that project A user cannot read project B data") — see A.7.

---

### A.5 DB Schema and Migrations

**Correction note:** The migration set has grown from 5 to 14 entries as the users/teams/orgs/quotas/audit feature area was added. `createSchema` also gained an advisory-lock guard and a retry wrapper that weren't in the original spec. `findOrCreateProject` is no longer called from anywhere in the codebase (see below) — the original spec's description of it as the login-path project-creation function is now obsolete.

**File:** `services/results-service/src/db.ts`

#### `createSchema`

**Signature (db.ts:390):**
```typescript
export const createSchema = async (p: Pool): Promise<void>
```

**Behavior:**
1. Creates `schema_migrations` table (`version INTEGER PRIMARY KEY, name TEXT, applied_at TIMESTAMPTZ`) via `queryWithRetry` — `db.ts:378-388, 391-397`. **New:** `queryWithRetry` retries up to 5 times (1s delay) to tolerate the Postgres Docker image's post-`initdb` restart, so Testcontainers-based tests don't flake on the first query.
2. **New:** acquires a Postgres session-level advisory lock (`pg_advisory_lock($1)` with a fixed arbitrary ID, `db.ts:401-404`) before running migrations, and releases it in a `finally` block — prevents two service instances racing to apply the same migration concurrently on startup. Not present in the original spec.
3. Queries all applied versions into a `Set<number>` — `db.ts:406-407`.
4. Iterates the `MIGRATIONS` array — now **14 entries, versions 1-14** (not 5) — skipping applied versions, running `migration.up(p)`, and recording each — `db.ts:409-415`.
5. Idempotent — all DDL uses `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`.

**New migrations since the original spec** (versions 6-14, `db.ts:179-370`):

| Version | Name | Adds |
|---------|------|------|
| 6 | `users_team_members_sessions` | `users` (email/password_hash/name), `team_members` (team_id/user_id/role, `CHECK role IN ('admin','member','viewer')`), `sessions` (token_hash/team_id/expires_at/revoked_at) — the whole account + session substrate A.4/A.9 depend on. |
| 7 | `team_quotas_and_gemini_usage` | `team_quotas` (per-team concurrent-test/VU/duration/schedule/Gemini-call limits), `gemini_usage` (daily call counter per team). |
| 8 | `organizations_and_team_api_keys` | `organizations`, `org_members` (`CHECK role IN ('owner','admin','member')`), `projects.org_id` FK, `team_api_keys` (name/key_hash/last_used_at/revoked_at) — the per-team API key mechanism used in A.3. |
| 9 | `audit_log` | `audit_log` (team_id/user_id/action/resource_type/resource_id) — written to by `recordAudit()` from `routes/results.ts` on script deletion and PDF/CSV export, among other actions. |
| 10 | `app_settings` | Generic key/value settings table, seeded with a default `ai_provider` row. |
| 11 | `team_ai_providers` | Per-team AI-provider override (provider + fallbacks). |
| 12 | `execution_log` | `test_results.execution_log` column. |
| 13 | `script_id_on_delete_set_null` | Changes `test_results.script_id`'s FK from the implicit default to `ON DELETE SET NULL`, fixing a bug where deleting a script 500'd once it had ever been used. |
| 14 | `workspaces` | `workspaces` table (team-scoped sub-grouping) plus `workspace_id` columns on `test_results`/`test_scripts`/`test_presets`/`schedules`/`webhooks`. |

**Callers:**
- `services/results-service/src/db.ts:423` — `initDb()` wrapper called at service startup.
- `services/results-service/src/__tests__/auth.test.ts`, `api.test.ts`, and most other `__tests__/*.test.ts` — test setup.

#### Migration Version 5 — `projects_and_project_id`

**File:** `services/results-service/src/db.ts:158-178`. Unchanged from the original spec — creates `projects` and adds nullable `project_id` FKs (no `ON DELETE` clause) to the same 6 tables, with indexes on `test_results`/`test_scripts`.

**[UNKNOWN]:** `live_metrics` still has no `project_id` column across all 14 migrations — confirmed unchanged. Live metric rows themselves remain unscoped; however, the one read endpoint that serves them (`GET /results/:testId/live`) now enforces scoping via a `LEFT JOIN test_results` in the query rather than a column on `live_metrics` itself — see A.6, which supersedes the original spec's isolation-gap listing for this endpoint.

#### `findOrCreateProject`

**File:** `services/results-service/src/db.ts:427-433`. Signature and upsert body unchanged from the original spec (`name.trim().toLowerCase()`, `INSERT ... ON CONFLICT (name) DO UPDATE ... RETURNING id`).

**Correction — this function is now dead code.** The original spec's only caller, `POST /auth/login`, no longer exists in that form. The current `POST /auth/register` (A.4) performs its own plain `INSERT INTO projects (name) VALUES ($1) RETURNING id` inside a transaction and handles the unique-violation (`23505`) manually rather than upserting — a repo-wide search found **no remaining callers of `findOrCreateProject`** anywhere in `services/`. It is exported but unused; the original spec's `[UNKNOWN]` about concurrent-login WAL writes no longer applies since nothing calls it on the login path anymore.

---

### A.6 Project-Scoped Query Filter Pattern

**Correction note:** The four isolation gaps the original spec listed here (`baseline` POST/DELETE, `GET .../live`, `GET .../report.pdf`) have all been **fixed** — every one of them now applies the filter pattern. The original spec's "no filter" claims were verified against current `services/results-service/src/routes/results.ts` and no longer hold.

**Pattern:** `($N::uuid IS NULL OR project_id = $N::uuid)` (or `tr.project_id`/`r.project_id` depending on the query's table alias)

- `$N` bound to `request.projectId ?? null`
- When `projectId` is `undefined` (dev mode, or a role/team resolution edge case), PostgreSQL receives `null` — the `IS NULL` branch fires, returning all rows
- When `projectId` is a UUID string, returns only matching rows

**File:** all occurrences below are in `services/results-service/src/routes/results.ts` (moved out of `app.ts` — see A.1).

**Endpoints that still bypass the filter by design (internal, not isolation gaps):**
- `POST /results/pending` (`results.ts:79-92`) — internal; accepts `projectId` in the request body and stores it directly (this is the write path that originates the project scoping, not a read that needs it).
- `POST /results/:testId/live`, `/running`, `/fail`, `/message` — internal worker→results-service callbacks, exempt via `internalSuffixes` (A.3), gated on `X-Internal-Key` instead of project scoping.

**Endpoints that now correctly apply the filter (previously listed as gaps — now fixed):**
- `POST /results/:testId/baseline` (`results.ts:368-391`) — three queries, all filtered on `project_id`.
- `DELETE /results/:testId/baseline` (`results.ts:394-403`) — filtered.
- `GET /results/:testId/live` (`results.ts:325-343`) — filtered via `LEFT JOIN test_results tr ON tr.test_id = lm.test_id` + `tr.project_id = $2::uuid`, since `live_metrics` itself has no `project_id` column (A.5, A-U1).
- `GET /results/:testId/report.pdf` (`results.ts:407-420`) — filtered.

**Remaining unfiltered read that IS still a gap:** `GET /system/ai-status` (`routes/system.ts:42-59`) queries `test_results` across all teams with no project filter — see A-U7 in A.8.

---

### A.7 Test Coverage Summary (auth + tenancy relevant)

**Correction note:** Both files have grown substantially (18→45 and 64→122 test cases) alongside the users/teams/orgs feature area, and several gaps the original spec flagged are now closed — most notably cross-team isolation, which now has a dedicated suite.

#### `auth.test.ts` — 45 tests, 8 `describe` blocks

| Suite | Notes |
|-------|-------|
| `POST /auth/register` | New endpoint (A.4) — email/password/teamName validation, duplicate email, duplicate team name. |
| `POST /auth/login` | Email/password model, replacing the old username/projectName one. |
| `POST /auth/logout` | Now asserts server-side revocation (A.9), not just cookie clearing. |
| `GET /auth/me` | |
| `POST /auth/switch-team` | New endpoint (A.4) — membership check, session team update. |
| `Session middleware` | Covers the expanded `onRequest` hook (A.3): role gates, org resolution, mutation guards. |
| `Auth dev mode (SESSION_SECRET not set)` | |
| `Cross-team isolation` | **New — closes the original spec's top-listed coverage gap** ("No test verifies that project A user cannot read project B data"). Exercises that a session scoped to one team cannot read/mutate another team's resources. |

**Coverage gaps that still apply:**
- No test exercises `secure: true` cookie (only fires in `NODE_ENV=production`).
- No test covers combined per-team API key + global `API_KEYS` + `SESSION_SECRET` all configured simultaneously (A.3's per-team-key edge case).
- No test for `/ws` path exempt behavior.
- No test for Unicode/special characters in `email`/`name`/`teamName`.

#### `api.test.ts` — 122 tests

Covers the expanded `routes/results.ts`/`routes/resources.ts`/`routes/workspaces.ts` surface (baseline, PDF/CSV export, workspaces) in addition to the original core REST endpoints. Most of this file still runs with `SESSION_SECRET` unset (auth disabled), same as the original spec described — `request.projectId` is `undefined` for most tests. Verified: only a handful of tests set `project_id` directly against the DB and assert on it (e.g. a schedule→api-service `projectId` passthrough test at `api.test.ts:469-481`), rather than exercising the full authenticated session→role→filter path end-to-end. **The original spec's coverage gap here still largely applies** — the dedicated authenticated/cross-team path is covered separately in `auth.test.ts`'s new `Cross-team isolation` suite (see above), not in `api.test.ts` itself.

---

### A.8 Unknowns and Assumptions

**Correction note:** A-U2 and A-U3 are now **resolved** (the underlying gaps were fixed — see A.6) and kept below only for history/traceability. A-U1, A-U5 (reframed), A-U6, and A-U7 are updated with current file:line citations. A-U4 was already corrected in a prior pass and is unchanged here.

| ID | Type | Description | Evidence |
|----|------|-------------|----------|
| A-U1 | Unknown | `live_metrics` still has no `project_id` column across all 14 current migrations — confirmed unchanged. The one read endpoint serving this table (`GET /results/:testId/live`) now scopes via a join to `test_results.project_id` instead (A.6), so this is no longer an exploitable gap, just a schema asymmetry. | `db.ts:112-123` (table def), `routes/results.ts:325-343` (join-based scoping) |
| A-U2 | **Resolved** | Originally: `POST`/`DELETE /results/:testId/baseline` lacked the project filter. Verified fixed — both now filter on `project_id`. | `routes/results.ts:368-403` |
| A-U3 | **Resolved** | Originally: `GET /results/:testId/report.pdf` lacked the project filter. Verified fixed. | `routes/results.ts:407-420` |
| A-U4 | Outdated | This claim ("no server-side session revocation") described the old HMAC-cookie scheme and is no longer accurate. The current opaque-token scheme supports server-side revocation via `revokeSession` (`POST /auth/logout`), which sets `sessions.revoked_at`; `getSession`/`getApiSession` exclude revoked rows on every lookup. See Section A.9. | `services/results-service/src/session.ts:43-46`, `routes/auth.ts:145` |
| A-U5 | Unknown | `findOrCreateProject` is now dead code — it is exported from `db.ts` but has no callers anywhere in `services/`. `POST /auth/register` does its own plain `INSERT` + manual `23505` handling instead of calling it (A.5, A.4). | `db.ts:427-433`, `routes/auth.ts:60-74` |
| A-U6 | Unknown | `GET /auth/me` in dev mode ignores any cookie present and always returns the hardcoded `DEV_USER` constant. | `routes/auth.ts:151-152`, `routes/helpers.ts:557-565` |
| A-U7 | Unknown | `GET /system/ai-status` queries `test_results` with no `project_id` filter — returns status messages from all teams regardless of the caller's session. Still an open gap; unlike the baseline/PDF/live endpoints (A.6), this one was not fixed. | `routes/system.ts:42-59` |
| A-U8 | Unknown | The per-team API key lookup in the `onRequest` hook swallows DB errors silently (bare `catch {}`, falls through to global-key/session checks) rather than surfacing them, which could mask a genuine `team_api_keys` misconfiguration as "key not recognized." | `app.ts:112-114` |

---

### A.9 Session Token Mechanism (`session.ts`)

**File:** `services/results-service/src/session.ts:1-53`, mirrored (not byte-for-byte — see below) by `services/api-service/src/session.ts:1-40`.

**Correction note:** An earlier reference doc (`reference-code-specs-auth.md`, now archived) documented an HMAC-signed-cookie scheme (`signSession`/`verifySession` producing a `<base64url_payload>.<hex_hmac>` cookie, with a `SessionPayload { projectId, username, projectName }` decodable client-side). That scheme is no longer present in the codebase. Sessions are now DB-backed opaque bearer tokens, consistent with `ARCHITECTURE.md`. This subsection describes the current implementation, verified directly against the source files above.

**Token issuance — `createSession`** (`session.ts:20-28`):
```typescript
export const createSession = async (pool: Pool, userId: string, teamId: string | null): Promise<string> => {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, team_id, expires_at) VALUES ($1, $2, $3, $4)`,
    [userId, hashToken(token), teamId, expiresAt]
  );
  return token;
};
```
- Token is `crypto.randomBytes(32)` hex-encoded — 64 hex chars, 256 bits of CSPRNG entropy. Line 21.
- `SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000` (30 days) — line 12. Matches the `alt_session` cookie's `maxAge: 30 * 24 * 60 * 60` set in `routes/auth.ts:20`.
- Only `hashToken(token)` is persisted (`session.ts:14`: `createHash('sha256').update(token).digest('hex')`, unsalted). The raw token is returned to the caller and never stored — it exists only as the cookie value on the client. Line 27.
- Called from `POST /auth/register` (`routes/auth.ts:79`) and `POST /auth/login` (`routes/auth.ts:127`).

**Token verification — `getSession`** (`session.ts:31-40`):
```typescript
export const getSession = async (pool: Pool, token: string | undefined): Promise<SessionRecord | null> => {
  if (!token) return null;
  const { rows } = await pool.query<{ user_id: string; team_id: string | null; expires_at: Date }>(
    `SELECT user_id, team_id, expires_at FROM sessions
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
    [hashToken(token)]
  );
  if (rows.length === 0) return null;
  return { userId: rows[0].user_id, teamId: rows[0].team_id, expiresAt: rows[0].expires_at };
};
```
- Returns `null` immediately if `token` is falsy — line 32.
- Matches by `token_hash = sha256(token)`. There is no client-decodable payload to tamper with and no in-process signature comparison (constant-time or otherwise); the token is a bearer credential resolved by an equality lookup on an indexed hash column against a live DB row.
- `revoked_at IS NULL AND expires_at > NOW()` are enforced in the query on every call — both expiry and revocation are server-side and immediate, unlike the old HMAC scheme where `A-U4`/old `U1` (no server-side revocation) applied.
- Returns `SessionRecord { userId, teamId, expiresAt }` — no `username`/`projectName` on the record itself; the caller re-resolves display fields via `SELECT ... FROM users`/`projects` (e.g. `app.ts:129-136`, `routes/auth.ts:157-168`).
- Called from `app.ts:126` (`onRequest` hook), `routes/auth.ts:154` (`GET /auth/me`), `routes/auth.ts:176` (`POST /auth/switch-team`).

**Revocation — `revokeSession`** (`session.ts:43-46`):
```typescript
export const revokeSession = async (pool: Pool, token: string | undefined): Promise<void> => {
  if (!token) return;
  await pool.query(`UPDATE sessions SET revoked_at = NOW() WHERE token_hash = $1`, [hashToken(token)]);
};
```
Called from `POST /auth/logout` (`routes/auth.ts:145`), gated on `sessionSecret` being set. Sets `revoked_at`, which `getSession`'s `WHERE` clause excludes on every subsequent lookup — true server-side logout.

**Team switching — `switchSessionTeam`** (`session.ts:49-52`): updates `sessions.team_id` in place for the existing token row (no new token issued). Called from `POST /auth/switch-team` (`routes/auth.ts:186`).

**api-service's `getApiSession`** (`services/api-service/src/session.ts:21-40`): **not** a verbatim copy (the archived reference doc's note that the two `session.ts` files were byte-for-byte identical no longer applies). It performs the same `token_hash` lookup against the shared `sessions` table, then additionally resolves the caller's current role:
```typescript
export const getApiSession = async (pool: Pool, token: string | undefined): Promise<ApiSession | null> => {
  if (!token) return null;
  const { rows } = await pool.query<{ user_id: string; team_id: string | null }>(
    `SELECT user_id, team_id FROM sessions
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
    [hashToken(token)]
  );
  if (rows.length === 0) return null;
  const { user_id: userId, team_id: teamId } = rows[0];
  if (!teamId) return { projectId: null, role: null };
  const { rows: memberRows } = await pool.query<{ role: TeamRole }>(
    `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId]
  );
  return { projectId: teamId, role: memberRows[0]?.role ?? null };
};
```
`ApiSession.projectId` is actually the team ID (the `projectId` field name is retained for backward compatibility with the rest of the codebase's `projectId` propagation, see Project B/C sections and `original-code-specs-service-tenancy-gaps.md`). Role is re-queried from `team_members` on every call — a role change or removal from the team takes effect on the caller's very next request; it is not cached in the token.

**Edge-case table (verified against current source; supersedes the archived HMAC-era table):**

| Case | Expected | Where enforced |
|------|----------|----------------|
| `undefined`/missing token | `null` | `session.ts:32` (`getSession`), `api-service/src/session.ts:22` (`getApiSession`) |
| Token not found in `sessions` | `null` | `token_hash = $1` matches zero rows |
| Token revoked (`revoked_at` set) | `null` | `revoked_at IS NULL` excludes it |
| Token expired (`expires_at <= NOW()`) | `null` | `expires_at > NOW()` excludes it |
| Valid token, `team_id IS NULL` (no team selected) | Resolves; `SessionRecord.teamId = null` / `ApiSession.projectId = null, role = null` | `session.ts:39`; `api-service/src/session.ts:32` |
| Valid token + team, caller no longer in `team_members` for that team | `getApiSession` returns `role: null`; results-service's own hook independently re-queries `team_members` and returns 403 for non-`/teams`/`/orgs` routes when role is null | `api-service/src/session.ts:34-39`; `results-service/src/app.ts:147-149` |

**Tested by** (`services/results-service/src/__tests__/session.test.ts`, real Postgres via Testcontainers): token creation returns a non-empty string; a valid token round-trips to the correct `userId`/`teamId`; only the hash (`^[0-9a-f]{64}$`) is stored, not the raw token; `teamId: null` is supported; unknown token → `null`; `undefined` token → `null`; expired session → `null`; `revokeSession` invalidates a previously valid token and is a no-op for `undefined`; `switchSessionTeam` updates the team on lookup and is a no-op for `undefined`.

**`getApiSession` tested by** (`services/api-service/src/__tests__/session.test.ts`, own local schema + Testcontainers, not shared with results-service's test setup): `undefined` token → `null`; unknown token → `null`; valid session → `{ projectId: teamId, role }`; session with no current team → `{ projectId: null, role: null }`; revoked session → `null`; expired session → `null`; role reflects the specific caller's `team_members` row (a second, lower-privileged user in the same team gets `role: 'viewer'` while the admin gets `role: 'admin'`).

**Note:** Because the cookie is now an opaque token rather than a signed, client-decodable payload, there is no "tampered cookie" failure mode in the old sense — flipping any character in the token just makes the hash lookup miss, indistinguishable from "unknown token." The archived reference doc's tamper/short-signature/wrong-secret test cases described a mechanism that no longer exists.

---

## Project B — api-service Auth + Routing

### B.1 Files Covered

**Correction note:** api-service has no separate `app.ts` — `index.ts` remains the single Fastify app factory + route file the original spec described (still true), but it has grown to 362 lines (from a smaller version) and now also imports a quotas module and a per-team API key hash helper.

| File | Role |
|------|------|
| `services/api-service/src/index.ts` | Fastify app factory, the merged API-key/session `onRequest` hook (B.3), `POST /tests`, `POST /tests/:testId/cancel`, `GET /health` (362 lines). |
| `services/api-service/src/session.ts` | `getApiSession`, `hashApiKey` — see A.9. |
| `services/api-service/src/quotas.ts` | `checkTestQuota`, `getTeamQuota` — new module, not in the original spec (B.5). |
| `services/api-service/src/__tests__/index.test.ts` | 40 tests (mocked queue, scripts, fetch) — up from 23. |
| `services/api-service/src/__tests__/session.test.ts` | `getApiSession` unit tests — new. |
| `services/api-service/src/__tests__/security.test.ts` | API key auth, input validation, CORS headers, envVar injection, cancel-endpoint tests — new; closes several of the original spec's B.6 coverage gaps. |
| `services/api-service/src/__tests__/teamApiKey.test.ts` | Per-team API key auth — new. |
| `services/api-service/src/__tests__/quotas.test.ts` | `getTeamQuota`/`checkTestQuota` — new. |

---

### B.2 App Factory

**Correction note:** Line range and augmented fields have both changed — `role` and `isInternalTrusted` were added — and `@fastify/rate-limit` is now registered alongside CORS/cookie.

**File:** `services/api-service/src/index.ts:65-346`

```typescript
export const buildApp = async (): Promise<FastifyInstance>
```

Takes no parameters. Reads all configuration from environment variables at call time.

**Fastify request augmentation (index.ts:15-17):**
```typescript
declare module 'fastify' {
  interface FastifyRequest { projectId: string | undefined; role: TeamRole | null; isInternalTrusted?: boolean; }
}
```
`role` and `isInternalTrusted` are new — `isInternalTrusted` marks requests authenticated via the `INTERNAL_API_KEY` channel (B.3). Still no `session`/`user` field (unlike results-service, which resolves a full user row — B in api-service only needs the team ID and role).

**Plugins registered:**
- `@fastify/cors` — `index.ts:69-73` with `ALLOWED_ORIGIN` env var, `credentials: true`, and an explicit method list.
- `@fastify/cookie` — `index.ts:74`.
- `@fastify/rate-limit` — `index.ts:76-83`, Redis-backed, global, `allowList` exempts only `/health`. **New**, not in the original spec.

---

### B.3 API Key + Session Hook (merged)

**Correction note:** The original spec described **two separate hooks** — a conditionally-registered API key hook (B.3) and an always-registered session hook (B.4). These have since been **merged into a single always-registered `onRequest` hook** (`index.ts:89-149`) that also gained a per-team API key path and a trusted-internal-caller path mirroring results-service's A.3. B.4 below is kept as a pointer for anything that referenced it by section number; the content lives here now.

**File:** `services/api-service/src/index.ts:89-149`

```typescript
app.addHook('onRequest', async (request, reply) => {
  if (request.url === '/health') return;
  // 1. Trusted internal caller (X-Internal-Key === INTERNAL_API_KEY) → isInternalTrusted=true, role='admin', return
  // 2. Per-team API key (team_api_keys, hashed lookup) → projectId=teamId, role='admin', return
  // 3. Global API_KEYS → 401 on miss/mismatch
  // 4. Session (getApiSession) → 401 on null; 403 if role===null (no current team); else projectId/role set
  // 5. Else (no SESSION_SECRET): projectId=undefined, role=null
});
```

**Registration:** Always registered — no longer conditional on `API_KEYS` being non-empty (that conditionality applied only to the old, now-removed, standalone API key hook).

**Exempt route:** Only `/health` (exact match, `index.ts:90`) — unchanged from the original spec. No internal-paths/suffixes set on api-service (all its other routes are user- or scheduler-facing, not worker callbacks).

**Step 1 — trusted internal caller (`index.ts:96-102`, new, not in the original spec):** if `INTERNAL_API_KEY` is configured and the `X-Internal-Key` header matches, sets `isInternalTrusted = true` and `role = 'admin'`, then returns immediately — bypasses API key and session checks entirely. Used by results-service's scheduler to trigger scheduled tests without a session cookie (B.7, B-U2 below).

**Step 2 — per-team API key (`index.ts:104-124`):** same `team_api_keys` hash-lookup mechanism as results-service's A.3, duplicated here. On a hit: `projectId = team_id`, `role = 'admin'`.

**Step 3 — global `API_KEYS` (`index.ts:126-130`):** unchanged in spirit from the original spec — 401 if configured and the header is missing/not in the list.

**Step 4 — session (`index.ts:132-144`):** calls `getApiSession` (A.9) instead of the old `verifySession`. **New 403 gate:** `if (session.role === null) return reply.code(403).send(...)` — "no current team" is now a hard block on every api-service route, since (unlike results-service) api-service has no `/teams`/`/orgs` routes to except.

**Step 5 — dev mode (`index.ts:145-148`):** `request.projectId = undefined; request.role = null;`. Still does not set any `user`/`session` field, matching the original spec's observation that api-service tracks less identity than results-service.

**[INCONSISTENCY, still accurate]:** results-service has an extensive `internalPaths` + `internalSuffixes` exemption set (A.3); api-service only exempts `/health` plus the new `X-Internal-Key` trusted-caller path. `POST /tests/:testId/cancel` still requires normal session/API-key auth like any other route — it's user-facing (UI-triggered), not server-to-server, so this remains correct behavior, not a bug.

**Note on optional chaining:** `request.cookies?.['alt_session']` (`index.ts:133`) — same pattern as before; still safe since `getApiSession` accepts `undefined`.

---

### B.4 Session Hook

**Correction note:** This is no longer a separate hook. See B.3 — the API key hook and session hook were merged into one `onRequest` registration. This section is kept only so anything that references "Section B.4" by name still resolves to something meaningful.

---

### B.5 `POST /tests` Handler — project_id Propagation

**Correction note:** The handler has grown substantially — it now enforces a per-team quota check, supports `workspaceId`, and lets internal/global-key callers override `projectId` from the request body (needed for the scheduler's trusted-internal-caller path, B.3 step 1). Line numbers below are current; the core propagation shape (`projectId` flows into the pending-result POST and the queue message, and is never stripped from the response) is unchanged from the original spec.

**File:** `services/api-service/src/index.ts:172-326`

**Signature:** unchanged —
```typescript
app.post<{ Body: Omit<TestRequest, 'id' | 'createdAt'> }>('/tests', async (request, reply) => { ... })
```

**`effectiveProjectId` resolution (new, `index.ts:180-183`):**
```typescript
const isGlobalKeyAuth = apiKeys.length > 0 && !!apiKeyHeader && apiKeys.includes(apiKeyHeader);
const isTrustedInternalAuth = request.isInternalTrusted === true;
const effectiveProjectId = ((isGlobalKeyAuth || isTrustedInternalAuth) && bodyProjectId) ? bodyProjectId : request.projectId;
```
Only a caller authenticated via the global `API_KEYS` list or the `X-Internal-Key` trusted channel may pass `projectId` in the request body to scope a test to an arbitrary team; a normal session-authenticated (or per-team-API-key) caller always gets `request.projectId` (their own current team), and any `projectId` they send in the body is ignored.

**New: quota check (`index.ts:242-245`):**
```typescript
const quotaError = await checkTestQuota(pool, effectiveProjectId, { type, options, durationSeconds });
if (quotaError) return reply.code(429).send({ error: quotaError });
```
`checkTestQuota` (`quotas.ts`) enforces per-team limits (`TeamQuota`, shared — max concurrent tests, max VUs, max duration, max scheduled tests, max Gemini calls/day; defaults in `DEFAULT_TEAM_QUOTA`). Not present in the original spec at all — this is new tenancy-adjacent enforcement, distinct from the read/write project-scoping the rest of this doc covers.

**`projectId`/`workspaceId` injection into the enriched request (`index.ts:213-230`):**
```typescript
const test: EnrichedTestRequest = {
  ...
  projectId: effectiveProjectId,
  workspaceId: workspaceId ?? undefined,
  ...
};
```

**Propagation to results-service `POST /results/pending` (`index.ts:249-257`):** same shape as the original spec, now also carrying `workspaceId`.

**Propagation to RabbitMQ via `publishTest(test, skipAI)`:** unchanged — the entire `EnrichedTestRequest` (including `projectId`/`workspaceId`) is serialized and published; `publishTest` is mocked in tests.

**`safeTestResponse` function (`index.ts:53-63`):** same stripped-field set as the original spec (`envVars`, `testData`, `csvData`, `csvFilename`, `customScript`, `generatedScript`, `cachedScript`, `cachedScriptDescription`) — content unchanged, only the line numbers moved.

**Note (unchanged from original spec):** `projectId` is NOT stripped by `safeTestResponse` — still visible in the HTTP response.

---

### B.6 Test Coverage Summary

**Correction note:** The original spec's two headline coverage gaps ("Auth hooks are NOT tested," "No test covers api-service session/API key auth") are now **closed** — auth is exercised both within `index.test.ts` itself and in three new dedicated test files.

**File:** `services/api-service/src/__tests__/index.test.ts` — 40 tests, 10 `describe` blocks

| Suite | Auth-relevant content |
|-------|----------------------|
| `POST /tests` | Creates pending record with projectId in body; queue/script routing |
| `POST /tests — workspaceId passthrough contract` | New — workspace scoping |
| `POST /tests — customScript bypass` | |
| `POST /tests/:testId/cancel` | Forwards to results-service + publishes cancel |
| `GET /health` | DB/queue health checks |
| `POST /tests — parameterization` | testData/csvData passthrough |
| `POST /tests — response does not leak sensitive fields` | envVars, testData, csvData stripped from response |
| `POST /tests — session and quota enforcement` | **New** — exercises the merged onRequest hook (B.3) and `checkTestQuota` (B.5) together. |
| `POST /tests — X-Internal-Key trusted channel` | **New** — exercises the trusted-internal-caller path (B.3 step 1) used by the scheduler. |
| `POST /tests — duration validation` | |

**Additional dedicated auth test files (new, not in the original spec):**
- `security.test.ts` — `describe` blocks for `API Key Authentication`, `Input validation`, `CORS headers`, `envVar injection protection`, `Cancel endpoint`.
- `session.test.ts` — `getApiSession` unit tests (see A.9).
- `teamApiKey.test.ts` — per-team API key auth on api-service.
- `quotas.test.ts` — `getTeamQuota`/`checkTestQuota`.

**Remaining gap:** no single test exercises all three auth paths (per-team key, global key, session) racing/overlapping on the same request, mirroring A.7's analogous remaining gap on results-service.

---

### B.7 Unknowns and Assumptions

**Correction note:** B-U2 is now **resolved** — the internal cancel call carries an auth header today. B-U1 is reframed for the merged hook (B.3). B-U3 and B-U4 are still accurate, with updated citations.

| ID | Type | Description | Evidence |
|----|------|-------------|----------|
| B-U1 | Unknown | The merged api-service `onRequest` hook (B.3) is always registered regardless of `SESSION_SECRET`/`API_KEYS`. With both unset, it still runs and sets `request.projectId = undefined`, `request.role = null`. No way to disable it entirely. | `index.ts:89-149` |
| B-U2 | **Resolved** | Originally: the `POST /tests/:testId/cancel` handler's internal call to results-service carried no auth headers. Verified fixed — it now sends `internalHeaders()` (`@alt/shared`), which adds `X-Internal-Key` when `INTERNAL_API_KEY` is configured. | `index.ts:334`, `packages/shared/src/index.ts:626-637` |
| B-U3 | Unknown | `findExistingScript` (`scripts.ts:28-35`) still takes `projectId` as its last argument, now sourced from `effectiveProjectId` rather than raw `request.projectId` (B.5). The project-scoping behavior of the underlying query and its interaction with worker-inserted scripts (`project_id = null`) was not re-verified in this pass — out of scope for this doc (see `original-code-specs-service-tenancy-gaps.md`, Project C, worker-backend). | `index.ts:296`, `scripts.ts:28-35` |
| B-U4 | Assumption | `import './tracing'` (`index.ts:1`) must be first — unchanged. Loads OTel instrumentation; no auth implications, noted because it changes module load order. | `index.ts:1` |

---

## Project E — recorder-service Auth

### E.1 Files Covered

| File | Role |
|------|------|
| `services/recorder-service/src/index.ts` | Full service: API key auth, SSRF validation, recording routes |

---

### E.2 App Factory

**Correction note:** Line range shifted slightly (43-349, file is now 363 lines) with no structural change to the factory itself.

**File:** `services/recorder-service/src/index.ts:43-349`

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

**Correction note:** The hook itself is unchanged (still conditional on `API_KEYS`, same two exemptions), just shifted 3 lines. What's new: `POST /recordings/start` now accepts an optional `teamId` in its body and stores it on the session (`session.teamId`), which is threaded through to the AI-correlation helpers on stop. This is a partial step toward project association, though it does **not** add any access-control check — see below.

**File:** `services/recorder-service/src/index.ts:55-64`

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

**Registration:** Conditional — only when `API_KEYS` is non-empty. Same pattern as api-service's old (now-removed) standalone API key hook — recorder-service did not adopt api-service/results-service's merged-hook or per-team-API-key model.

**Exempt routes:**
- `/health` — exact match
- `/viewer/:id` — starts-with check (`request.url.startsWith('/viewer/')`) — line 58

**[DIFFERENCE from other services, still accurate]:** recorder-service uses `startsWith('/viewer/')` rather than an exact match. This means any sub-path under `/viewer/` is exempt. The `/viewer/:id` route serves an HTML page with embedded JavaScript that opens noVNC — exempting it allows the browser to load this page without an API key.

**No session auth.** No `SESSION_SECRET` usage. No cookie plugin. No `request.projectId` field on the Fastify request type (unlike results-service/api-service).

**New: `session.teamId` (`index.ts:90`).** `POST /recordings/start` sets `session.teamId = request.body?.teamId ?? null` on the in-memory session object. This value is passed to `detectCorrelations`/`suggestStepNames`/`suggestIgnorePatterns` (`correlator.ts`) on stop, presumably to scope AI-correlation caching/config to a team. **It performs no access-control function** — `GET /recordings/:id`, `POST /recordings/:id/stop`, and `DELETE /recordings/:id` all look sessions up by ID alone with no check that the caller's `teamId` (if any) matches `session.teamId`.

**[UNKNOWN, still accurate]:** There is no project *isolation* in recorder-service, despite the new `teamId` field. Recording sessions are stored in module-level `Map<string, RecordingSessionInternal>` (`sessions`) and `Map<string, CompletedResult>` (`completedResults`). Any authenticated client can access any other client's (or team's) recording session by ID (UUIDs, so brute-force is impractical but logical isolation is absent).

---

### E.4 SSRF Protection

**Correction note:** The two regexes have moved out of recorder-service entirely, into `packages/shared`, and are now also used by results-service for webhook URL validation (per that file's own comment). The exported function name recorder-service uses (`validateRecorderUrl`) is now just a local alias for the shared `validateSsrfSafeUrl`. The shared version also validates URL parseability and scheme, and adds `0.0.0.0` to the blocked-IPv4 list — neither of which the original local implementation did.

**File:** `packages/shared/src/index.ts:644-656`, aliased at `services/recorder-service/src/index.ts:19`

```typescript
const SSRF_BLOCKED_HOSTNAME_RE = /^(localhost|.*\.local|host\.docker\.internal|.*\.internal|metadata\.google\.internal)$/i;
const SSRF_PRIVATE_IPV4_RE = /^(0\.0\.0\.0|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|127\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+)$/;

export const validateSsrfSafeUrl = (raw: string): string | null => {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return 'Invalid URL'; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'URL must use http or https';
  const host = parsed.hostname.toLowerCase();
  if (SSRF_BLOCKED_HOSTNAME_RE.test(host)) return 'URL targets a blocked internal hostname';
  if (SSRF_PRIVATE_IPV4_RE.test(host)) return 'URL targets a private/internal IP range';
  return null;
};
```

```typescript
// services/recorder-service/src/index.ts:19
export const validateRecorderUrl = validateSsrfSafeUrl;
```

Used only in `POST /recordings/start` when `targetUrl` is provided in the body (`index.ts:93-99`) — this part is unchanged from the original spec.

**[UNKNOWN, still accurate]:** SSRF validation is applied to `targetUrl` in `POST /recordings/start` body only. The browser inside the container can navigate to any URL once launched — the validation only affects the initial auto-navigation.

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

**Correction note:** E-U1 is updated to reflect the new (access-control-inert) `teamId` field from E.3. E-U2/E-U3 citations updated for the current line numbers; content unchanged.

| ID | Type | Description | Evidence |
|----|------|-------------|----------|
| E-U1 | Unknown | Still no access-control isolation. `POST /recordings/start` now accepts and stores a `teamId` on the session (E.3), but no route checks it — any client with a valid API key (or no key, if `API_KEYS` is unset) can read/stop/delete any session by ID regardless of `teamId`. | `index.ts:55-64, 78-91` |
| E-U2 | Unknown | Completed results are stored in module-level Map with 10-minute TTL (`index.ts:24-39`). Lost on process restart. No DB persistence. | `index.ts:24-39` |
| E-U3 | Unknown | SSRF validation (now `packages/shared`'s `validateSsrfSafeUrl`, E.4) applies only to the initial `targetUrl` in `POST /recordings/start`. Browser CDP can navigate anywhere once launched. | `index.ts:93-99` |

---

## Project F — UI Auth

### F.1 Files Covered

**Correction note:** `lib/api.ts`'s auth portion has been extracted into its own module (`lib/api/auth.ts`) as part of a broader split of `api.ts` into `lib/api/*` domain modules (presets, teams, orgs, workspaces, schedules, recording, webhooks, apiKeys, system, ai, tests, core). `AuthUser` no longer exists — auth functions now return the shared `SessionUser` type (F.2, G.3). `LoginPage` now does both login and registration.

| File | Role |
|------|------|
| `services/ui/lib/AuthContext.tsx` | React context: `AuthProvider`, `useAuth` hook. Gained a `switchTeam` method. |
| `services/ui/app/login/page.tsx` | Login/register page component (dual-mode). |
| `services/ui/lib/api/auth.ts` | `register`, `login`, `logout`, `getMe`, `switchTeam` — all typed against `SessionUser` from `@alt/shared`. Re-exported through `services/ui/lib/api.ts:48`. |
| `services/ui/lib/api/core.ts` | Base fetch wrapper `f`, `authHeaders`, `API_URL`/`RESULTS_URL`/`RECORDER_URL` constants — unchanged in behavior from the original spec's "Base fetch wrapper" description, just relocated. |
| `services/ui/src/App.tsx` | Confirms the `AuthGate`/`Outlet`/router wiring the original spec inferred (F.6) — not a guess, verified directly this pass. |
| `services/ui/__tests__/AuthContext.test.tsx` | 6 unit tests for `AuthProvider` and `AuthGate` — count unchanged from the original spec (`describe` blocks at lines 58 and 114). |
| `services/ui/__tests__/LoginPage.test.tsx` | 11 unit tests (up from 5) — now covering both login and register modes. |

---

### F.2 `AuthUser` Interface

**Correction note:** `AuthUser` no longer exists anywhere in the codebase. The UI now imports and re-exports the shared `SessionUser` type directly, which resolves the original spec's G.3 "three separate definitions of the same auth identity type" inconsistency for this one type (the UI no longer has its own copy).

**File:** `services/ui/lib/api/auth.ts:1, 4`

```typescript
import type { SessionUser } from '@alt/shared';
export type { SessionUser };
```

`SessionUser` (defined once, in `packages/shared/src/index.ts:33-41` — see G.2/G.3) is `{ id, email, name?, teams: TeamMembership[], currentTeamId, role, orgs: OrgMembership[] }` — a materially different shape from the old `AuthUser`/`SessionPayload` (`{ projectId, username, projectName }`), reflecting the shift from single-project sessions to multi-team user accounts.

---

### F.3 API Functions

**Correction note:** All auth functions moved from `lib/api.ts` into `lib/api/auth.ts` (re-exported through `api.ts:48`), and the fetch wrapper moved into `lib/api/core.ts`. Functionally: `login` now takes `email`/`password` instead of `username`/`projectName`; a new `register` and `switchTeam` were added; and — resolving the original spec's F-U1 — every auth function now checks `r.ok` and throws with the server's error message on failure, not just `getMe`.

**File:** `services/ui/lib/api/core.ts`

#### Base fetch wrapper `f`

**Lines 10-15** — unchanged in behavior from the original spec, just relocated:
```typescript
export const authHeaders = (): Record<string, string> =>
  API_KEY ? { 'X-API-Key': API_KEY } : {};

export const f = (url: string, init?: RequestInit) =>
  fetch(url, { ...init, credentials: 'include', headers: { ...authHeaders(), ...(init?.headers ?? {}) } });
```

**`credentials: 'include'`** — ensures the `alt_session` cookie is sent with every request, including cross-origin requests. Unchanged.

**`API_KEY`** — read from `import.meta.env.VITE_API_KEY || ''` (`core.ts:8`). Unchanged.

**Base paths (`core.ts:4-7`):**
```typescript
export const API_URL     = '/api';      // routes to api-service via Vite proxy
export const RESULTS_URL = '/data';     // routes to results-service via Vite proxy
export const RECORDER_URL = import.meta.env.VITE_RECORDER_URL || 'http://localhost:3007'; // new — absolute URL for the opener window
```
`API_URL`/`RESULTS_URL` unchanged; `RECORDER_URL` is new since the original spec.

All auth API calls still go to `RESULTS_URL` (results-service) — unchanged.

**File:** `services/ui/lib/api/auth.ts`

**Shared response helper (`auth.ts:6-12`), new — resolves the original spec's F-U1:**
```typescript
const authJson = async (res: Response): Promise<SessionUser> => {
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
};
```

#### `register` (new)

**`auth.ts:14-19`:**
```typescript
export const register = (email: string, password: string, teamName: string, name?: string): Promise<SessionUser> =>
  f(`${RESULTS_URL}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, teamName, name }) }).then(authJson);
```

#### `login`

**`auth.ts:21-26`:**
```typescript
export const login = (email: string, password: string): Promise<SessionUser> =>
  f(`${RESULTS_URL}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }).then(authJson);
```

Signature changed from `(username, projectName)` to `(email, password)`. Now routed through `authJson`, so it throws on a non-2xx response instead of silently resolving to the error body.

#### `logout`

**`auth.ts:28-29`:** unchanged in shape —
```typescript
export const logout = (): Promise<void> =>
  f(`${RESULTS_URL}/auth/logout`, { method: 'POST' }).then(() => undefined);
```

#### `getMe`

**`auth.ts:31-35`:** unchanged from the original spec (already checked `r.ok`) —
```typescript
export const getMe = (): Promise<SessionUser> =>
  f(`${RESULTS_URL}/auth/me`).then(r => { if (!r.ok) throw new Error('Not authenticated'); return r.json(); });
```

#### `switchTeam` (new)

**`auth.ts:37-42`:**
```typescript
export const switchTeam = (teamId: string): Promise<SessionUser> =>
  f(`${RESULTS_URL}/auth/switch-team`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ teamId }) }).then(authJson);
```
Wired to `AuthContext`'s `switchTeam` (F.4).

---

### F.4 `AuthProvider` and `useAuth`

**Correction note:** `user`/`setUser` are now typed as `SessionUser` instead of the now-gone `AuthUser`. A new `switchTeam` method was added to the context, backing the multi-team switching flow (A.4, F.3).

**File:** `services/ui/lib/AuthContext.tsx`

#### `AuthContextValue` Interface

**Lines 4-10:**
```typescript
interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  logout: () => Promise<void>;
  setUser: (u: SessionUser | null) => void;
  switchTeam: (teamId: string) => Promise<void>;
}
```

#### `AuthProvider` Component

**Signature (line 18):** unchanged —
```typescript
export function AuthProvider({ children }: { children: ReactNode })
```

**State:** `user: SessionUser | null` (null), `loading: boolean` (true).

**On mount (`useEffect`, lines 22-27):** unchanged behavior — calls `getMe()`; resolves → `setUser`; rejects → `setUser(null)`; always → `setLoading(false)`.

**`logout` function (lines 29-32):** unchanged — calls `apiLogout()` then `setUser(null)`. Does not navigate.

**`switchTeam` function (lines 34-37), new:**
```typescript
const switchTeam = async (teamId: string) => {
  const updated = await apiSwitchTeam(teamId);
  setUser(updated);
};
```
Calls the `switchTeam` API function (F.3) and replaces the entire `user` object with the server's fresh `SessionUser` (new `currentTeamId`/`role`).

**Context default value (lines 12-14):** `user: null, loading: true, logout: async () => {}, setUser: () => {}, switchTeam: async () => {}`. Used only when `AuthProvider` is not a parent.

#### `useAuth` Hook

**File:** `services/ui/lib/AuthContext.tsx:16`

```typescript
export const useAuth = () => useContext(AuthContext)
```

Unchanged from the original spec. Returns `AuthContextValue`. No error thrown if used outside `AuthProvider` — returns the default no-op value.

---

### F.5 `LoginPage` Component

**Correction note:** This is now a dual-mode login/register form (email + password, with a team name field in register mode), not the original spec's single username/projectName login form. Error messages are now taken from the thrown `Error`'s message (surfaced by `authJson`, F.3) rather than a hardcoded string.

**File:** `services/ui/app/login/page.tsx`

**State:** `mode: 'login' | 'register'`, `email: string`, `password: string`, `name: string`, `teamName: string`, `error: string`, `loading: boolean`.

**Dependencies:** `useNavigate` (react-router-dom), `login`/`register` (`lib/api`), `useAuth` hook (for `setUser`).

**`handleSubmit` flow (lines 17-32):**
1. `e.preventDefault()`
2. `setError('')`, `setLoading(true)`
3. If `mode === 'login'`: calls `login(email.trim(), password)`. Else: calls `register(email.trim(), password, teamName.trim(), name.trim() || undefined)`.
4. On success: `setUser(user)` → `navigate('/')`
5. On error: `setError(err.message)` if the caught value is an `Error` (now surfaces the server's actual validation/auth error text, e.g. "Invalid email or password" or "Email already registered" — see A.4), else a generic `"Login failed"`/`"Registration failed — please try again"` fallback.
6. Finally: `setLoading(false)`

**UI behavior:**
- `required` on email/password (register mode also requires `teamName`); password has `minLength={8}` matching the server-side minimum (A.4).
- A toggle button switches between login and register mode, clearing any error.
- Button disabled and its label changes to a loading state (`"Signing in..."`/`"Creating account..."`) while `loading === true`.

**Tests (LoginPage.test.tsx — 11 tests, up from 5):** covers both login and register submission paths, field rendering, trimmed-value submission, mode toggling, error display for both modes (using the server's real error message rather than a hardcoded string), and the loading-disabled state.

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

**Correction note:** F-U1 and F-U4 are now **resolved**. F-U2/F-U3 are unchanged in substance, with updated citations.

| ID | Type | Description | Evidence |
|----|------|-------------|----------|
| F-U1 | **Resolved** | Originally: `login()` did not check `r.ok` before calling `.json()`. Verified fixed — `login`/`register`/`switchTeam` all go through the shared `authJson` helper (F.3), which throws with the server's error message on any non-2xx response. `getMe` already checked `r.ok` (unchanged); `logout` still doesn't check `r.ok`, but it discards the response either way (`.then(() => undefined)`), so there's nothing to lose by not checking. | `lib/api/auth.ts:6-12, 21-42` |
| F-U2 | Unknown | `logout()` calls `setUser(null)` but does not navigate. If the current route is protected by `AuthGate`, the `AuthGate` re-render will redirect to `/login`. But if `logout()` is called from an unprotected route or non-route context, no redirect happens. | `AuthContext.tsx:29-32` |
| F-U3 | Unknown | `useAuth()` returns the context default (`user: null, loading: true, ...`) if used outside `AuthProvider`. No runtime error thrown. Consumers would see `loading: true` indefinitely. | `AuthContext.tsx:12-14, 16` |
| F-U4 | **Resolved** | Originally: `AuthUser` was defined separately in the UI and not imported from `@alt/shared`, requiring manual sync. Verified fixed — the UI now imports and re-exports the shared `SessionUser` type directly (F.2); there is no UI-local copy left to drift. | `lib/api/auth.ts:1, 4`, `packages/shared/src/index.ts:33-41` |

---

## Project G — Shared Types (auth/tenancy relevant)

### G.1 Files Covered

| File | Role |
|------|------|
| `packages/shared/src/index.ts` | All shared TypeScript types |

---

### G.2 Auth/Tenancy-Related Types

**Correction note:** Line numbers shifted (the file grew — `aiProvider`/`aiValidation` re-exports were added at the top, pushing everything down). `TestRequest` gained a `workspaceId` field. Most significantly, **the shared package now DOES contain auth/tenancy identity types** — see G.3, which supersedes the original spec's "No `SessionPayload`/`AuthUser` in shared" claim.

#### `TestRequest.projectId` and `TestRequest.workspaceId`

**File:** `packages/shared/src/index.ts:113-129`

```typescript
export interface TestRequest {
  ...
  projectId?: string;   // set by api-service from session; filters DB scope
  workspaceId?: string; // optional sub-project grouping within a team — new
  ...
}
```

`projectId` comment/behavior unchanged from the original spec. `workspaceId` is new (added alongside migration 14, A.5) — an optional sub-team grouping, propagated the same way `projectId` is (B.5).

#### `TestResult.projectId`

**File:** `packages/shared/src/index.ts:230-244`

```typescript
export interface TestResult {
  ...
  projectId?: string;  // set by workers from test.projectId; consumer saves it to test_results.project_id
  ...
}
```

Unchanged from the original spec other than its line number.

#### `EnrichedTestRequest`

**File:** `packages/shared/src/index.ts:305-312`

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

Unchanged from the original spec (field set is identical; only the line number moved). Extends `TestRequest` — inherits `projectId?: string` and the new `workspaceId?: string`.

---

### G.3 Auth/Tenancy Types Now IN the Shared Package (was: "Types NOT in Shared Package")

**Correction note:** This section's entire premise is now false. The original spec's `SessionPayload`/`AuthUser` triplication was fixed by moving the canonical identity type into `@alt/shared` as part of the users/teams/orgs rework — the UI imports it directly (F.2), and results-service's session/auth-route code (A.4, A.9) builds `SessionUser` objects matching this shared shape. Rewritten below against current source.

**File:** `packages/shared/src/index.ts:8-59`

```typescript
export type TeamRole = 'admin' | 'member' | 'viewer';

export interface TeamMembership {
  id: string;
  name: string;
  role: TeamRole;
}

export type OrgRole = 'owner' | 'admin' | 'member';

export interface OrgMembership {
  id: string;
  name: string;
  role: OrgRole;
}

/** Returned by /auth/register, /auth/login, /auth/me, /auth/switch-team */
export interface SessionUser {
  id: string;
  email: string;
  name?: string | null;
  teams: TeamMembership[];
  currentTeamId: string | null;
  role: TeamRole | null;
  orgs: OrgMembership[];
}

export interface TeamQuota {
  maxConcurrentTests: number;
  maxVusPerTest: number;
  maxTestDurationSeconds: number;
  maxScheduledTests: number;
  maxGeminiCallsPerDay: number;
}

export const DEFAULT_TEAM_QUOTA: TeamQuota = {
  maxConcurrentTests: 5,
  maxVusPerTest: 1000,
  maxTestDurationSeconds: 3600,
  maxScheduledTests: 10,
  maxGeminiCallsPerDay: 100,
};
```

| Type | Now Shared? | Consumers |
|------|-------------|-----------|
| `TeamRole` | Yes (`shared:14`) | results-service (`app.ts`, `routes/*`), api-service (`index.ts`), UI |
| `OrgRole` | Yes (`shared:24`) | results-service `app.ts`/`routes/teams.ts` |
| `SessionUser` | Yes (`shared:33-41`) | results-service `routes/auth.ts` (constructs it), UI `lib/api/auth.ts`/`AuthContext.tsx` (consumes it) — this is the type that replaced the old `SessionPayload`/`AuthUser` split. |
| `TeamQuota` / `DEFAULT_TEAM_QUOTA` | Yes (`shared:45-59`) | api-service `quotas.ts` (B.5), results-service `routes/teams.ts` (quota admin endpoints) |

**What's still service-local (not shared), and correctly so:**

| Type | Location | Note |
|------|----------|------|
| `SessionRecord` | `results-service/src/session.ts:6-10` | Internal shape returned by `getSession` (`{ userId, teamId, expiresAt }`) — not sent over the wire, so it doesn't need to be shared. |
| `ApiSession` | `api-service/src/session.ts` (referenced in A.9) | Same reasoning — internal to `getApiSession`'s return value. |

The original spec's `[INCONSISTENCY]` about three separate definitions of the same identity type is resolved for the type that actually crosses process boundaries (`SessionUser`); the two that remain service-local never leave their own process, so duplicating them would add no value.

---

### G.4 Unknowns and Assumptions

**Correction note:** G-U1 still applies, with an updated citation. G-U2 needed re-verification given how much the type surface grew — it still holds: despite `SessionUser`/`TeamRole`/`OrgRole`/`TeamQuota` now being shared (G.3), `EnrichedTestRequest`'s only tenancy identifier is still `projectId` (plus the new `workspaceId`); no org/role field was added to the test-message pipeline itself.

| ID | Type | Description | Evidence |
|----|------|-------------|----------|
| G-U1 | Unknown | `projectId` in both `TestRequest` and `TestResult` is still `string \| undefined`. There is still no `ProjectId` branded type — any string passes type checking. | `packages/shared/src/index.ts:126, 238` |
| G-U2 | Unknown | `EnrichedTestRequest` still has no org, team, or role fields — confirmed unchanged despite the broader shared-types additions in G.3. The only tenancy identifiers threaded through the RabbitMQ message pipeline (api-service → workers → results-service) are `projectId` and the new `workspaceId`; a test message carries no role or org context. | `packages/shared/src/index.ts:305-312` |
| G-U3 | Unknown | `TeamQuota`/`DEFAULT_TEAM_QUOTA` (G.3) are shared, but `getTeamQuota` (the function that reads `team_quotas` and falls back to the default) is independently implemented twice with byte-for-byte identical logic — once in `api-service/src/quotas.ts:5-24` and once in `results-service/src/quotas.ts:5-24`. A change to the `team_quotas` schema or the default values would need to be applied in both places. | `services/api-service/src/quotas.ts:5-24`, `services/results-service/src/quotas.ts:5-24` |
