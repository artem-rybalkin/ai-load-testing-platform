# Reference Code Specs — Project Isolation Pattern

Factual specification of the single-project isolation model: `projects` table, `findOrCreateProject`,
`project_id` FK pattern across 6 resource tables, `($N::uuid IS NULL OR project_id = $N::uuid)` filter,
and API key authentication in both services.
No generalizations, no recommendations. Every claim is cited to file:line.

---

## 1. Files Covered

| File | Role |
|------|------|
| `services/results-service/src/db.ts` | Schema migrations, `projects` table, `findOrCreateProject` |
| `services/results-service/src/app.ts` | Project-scoped query filter pattern, API key hook |
| `services/api-service/src/index.ts` | API key hook |
| `packages/shared/src/index.ts` | `TestRequest.projectId`, `TestResult.projectId` |
| `services/results-service/src/__tests__/auth.test.ts` | Integration tests for session + project isolation |
| `services/results-service/src/__tests__/api.test.ts` | Integration tests for all REST endpoints |

---

## 2. `projects` Table Schema

**File:** `services/results-service/src/db.ts:162-168` (migration version 5)

```sql
CREATE TABLE IF NOT EXISTS projects (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | PK, auto-generated |
| `name` | TEXT | NOT NULL, UNIQUE |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() |

**No foreign keys referencing other tables.** Projects are self-contained.

**Name uniqueness:** enforced at DB level. `UNIQUE(name)` constraint at line 166.

---

## 3. `project_id` FK — Tables Carrying It

Added by migration version 5 (`projects_and_project_id`), `db.ts:159-177`.

| Table | Migration SQL line | Index created |
|-------|-------------------|---------------|
| `test_results` | `db.ts:169` | Yes — `idx_test_results_project_id` (`db.ts:175`) |
| `test_scripts` | `db.ts:170` | Yes — `idx_test_scripts_project_id` (`db.ts:176`) |
| `test_presets` | `db.ts:171` | No |
| `schedules` | `db.ts:172` | No |
| `webhooks` | `db.ts:173` | No |
| `log_sources` | `db.ts:174` | No |

**Total: 6 tables carry `project_id`.**

All FK columns are: `UUID REFERENCES projects(id)` with no `ON DELETE` clause (i.e., default `NO ACTION`). Added via `ADD COLUMN IF NOT EXISTS` — nullable by default (no `NOT NULL` constraint). Lines 169-174.

**UNKNOWN:** `live_metrics` does NOT have a `project_id` column. Live metric points are accessible via `test_id` lookup only; no project-level isolation on `live_metrics`. This is confirmed by reading all migrations in `db.ts:22-177`.

---

## 4. Function: `findOrCreateProject`

**File:** `services/results-service/src/db.ts:209-215`

### Signature
```typescript
export const findOrCreateProject = async (name: string, p: Pool = pool): Promise<string>
```

### Behavior
1. Executes an upsert:
   ```sql
   INSERT INTO projects (name) VALUES ($1)
   ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
   RETURNING id
   ```
   Line 210-213. The `DO UPDATE SET name = EXCLUDED.name` is a no-op update used to trigger `RETURNING` on conflict.
2. Input `name` is `name.trim().toLowerCase()` — applied by the caller in `app.ts:84` (`projectName.trim()`) and `app.ts:85` (`projectName.trim().toLowerCase()` in payload). The function itself does not lowercase; it stores exactly what is passed.
3. Returns the UUID string from `rows[0].id`. Line 214.

**ASSUMPTION:** The lowercase normalization is enforced by the caller (`app.ts:84-85`), not by `findOrCreateProject` itself. If called directly with a mixed-case name, it would store that name.

### Callers
- `services/results-service/src/app.ts:84` — `POST /auth/login` handler, called with `projectName.trim()` (the payload value at line 85 is lowercased separately).

**UNKNOWN:** The `findOrCreateProject` upsert uses `DO UPDATE SET name = EXCLUDED.name`. This means a conflict on `name` still performs a write (UPDATE) in PostgreSQL. On high-concurrency login this generates unnecessary WAL. No test covers concurrent login for the same project name.

### Default Pool Parameter
The second parameter `p: Pool = pool` defaults to the primary write pool (`pool` from `db.ts:7`). This is consistent — project creation is always a write operation.

---

## 5. The `($N::uuid IS NULL OR project_id = $N::uuid)` Filter Pattern

This is the core isolation predicate. Used in every resource query in `app.ts`.

### Meaning
- `$N` is bound to `request.projectId ?? null`.
- When `SESSION_SECRET` is empty (dev mode), `request.projectId` is `undefined`, so `$N` is `null`.
- `($N::uuid IS NULL OR ...)` evaluates to `TRUE` for any row when `$N` is `null` — **all projects visible in dev mode**.
- When `$N` is a UUID string, only rows where `project_id = $N` are returned.

### Complete List of Occurrences in `app.ts`

| Endpoint | HTTP method | Table | app.ts line |
|----------|-------------|-------|-------------|
| `GET /results` | GET | `test_results` | 263 |
| `GET /results/active` | GET | `test_results` | 307 |
| `GET /results/:testId` | GET | `test_results` | 327 |
| `GET /results/compare` | GET | `test_results` | 472 |
| `GET /results/trend` | GET | `test_results` | 492 |
| `GET /results/suggest-thresholds` | GET | `test_results` | 811 |
| `GET /results/suggest-settings` | GET | `test_results` | 668 |
| `GET /results/:testId/diagnose` | GET | `test_results` | 871 |
| `GET /scripts` | GET | `test_scripts` | 343 |
| `GET /scripts/:id` | GET | `test_scripts` | 359 |
| `DELETE /scripts/:id` | DELETE | `test_scripts` | 413 |
| `GET /webhooks` | GET | `webhooks` | 519 |
| `DELETE /webhooks/:id` | DELETE | `webhooks` | 532 |
| `POST /webhooks` | POST (insert) | `webhooks` | 509 (projectId in INSERT) |
| `GET /log-sources` | GET | `log_sources` | 939 |
| `DELETE /log-sources/:id` | DELETE | `log_sources` | 988 |
| `PUT /log-sources/:id` | PUT | `log_sources` | 976 |
| `POST /log-sources` | POST (insert) | `log_sources` | 953 (projectId in INSERT) |
| `GET /schedules` | GET | `schedules` | 997 |
| `DELETE /schedules/:id` | DELETE | `schedules` | 1048 |
| `PUT /schedules/:id` | PUT | `schedules` | 1037 |
| `POST /schedules/:id/run` | POST | `schedules` | 1059 |
| `GET /presets` | GET | `test_presets` | 1083 |
| `GET /presets/:id` | GET | `test_presets` | 1109 |
| `DELETE /presets/:id` | DELETE | `test_presets` | 1121 |
| `POST /presets` | POST (insert) | `test_presets` | 1096 (projectId in INSERT) |

**Endpoints that do NOT use the project filter:**

**Correction note (updated alongside the `original-code-specs-auth-tenancy.md` staleness pass — see that doc's Section A.6):** the four rows below marked **RESOLVED** were re-verified against current `services/results-service/src/routes/results.ts` and now DO apply the project filter — the isolation gaps this table originally flagged for them have been fixed. They're kept in the table (rather than deleted) so the "why was this ever a gap" history isn't lost, but the `[UNKNOWN]`/`[INCONSISTENCY]` callouts below the table that treated them as open gaps no longer apply to those four.

| Endpoint | Reason |
|----------|--------|
| `POST /results/pending` | Internal (exempt from auth); accepts `projectId` in body and stores it directly — `routes/results.ts:79-92` |
| `POST /results/:testId/message` | Internal suffix exempt — no project filter |
| `POST /results/:testId/fail` | Internal suffix exempt — no project filter |
| `POST /results/:testId/running` | Internal suffix exempt — no project filter |
| `POST /results/:testId/cancel` | Internal suffix exempt — no project filter |
| `POST /results/:testId/baseline` | **RESOLVED** — now filtered on `project_id`, `routes/results.ts:368-391` |
| `DELETE /results/:testId/baseline` | **RESOLVED** — now filtered, `routes/results.ts:394-403` |
| `GET /results/:testId/live` | **RESOLVED** — now filtered via a join to `test_results.project_id` (the `live_metrics` table itself still has no `project_id` column), `routes/results.ts:325-343` |
| `POST /results/:testId/live` | No project filter (internal suffix) — correct, this is the worker's internal push, not a read |
| `GET /results/:testId/report.pdf` | **RESOLVED** — now filtered, `routes/results.ts:407-420` |
| `GET /webhooks (secret)` | `secret` column excluded from SELECT — returns only `id, url, events, format, created_at` |

**Still an open gap, not covered by the table above:** `GET /system/ai-status` (`routes/system.ts:42-59`) queries `test_results` across all teams with no `project_id` filter.

---

## 6. `project_id` Propagation Path (Cross-Service)

**Correction note:** `SessionPayload` no longer exists — see `original-code-specs-auth-tenancy.md` Sections A.4/A.9/G.3. Sessions are now DB-backed opaque tokens resolved server-side; the value that ends up in `request.projectId` (both services) is the caller's *current team ID*, resolved via `getSession`/`getApiSession` rather than decoded from the cookie.

Summary: `project_id` originates at login/register (the session's current team, resolved server-side via `getSession`/`getApiSession` — not a client-decodable `SessionPayload` anymore), is attached to the request by api-service's `onRequest` hook, injected into `EnrichedTestRequest`, carried through `POST /results/pending` and the RabbitMQ `test-results` message, and stored on `test_results.project_id` by the results-service consumer.

**(see `docs/original-code-specs-service-tenancy-gaps.md` for the full pipeline trace, including the worker-client gap where `projectId` is dropped before publishing to `test-results`.)**

**UNKNOWN:** `test_scripts.project_id` is never explicitly set by the current write paths visible in `db.ts` and `app.ts`. The `test_scripts` table gets `project_id = null` for all rows inserted by `worker-backend` (which calls `saveScript` without session context). This means the `GET /scripts` filter `($1::uuid IS NULL OR project_id = $1::uuid)` would return NO scripts when a project session is active (all scripts have `null` project_id). This is a likely isolation gap for the scripts table.

---

## 7. Migration Registry

**File:** `services/results-service/src/db.ts:22-178`

| Version | Name | Auth-relevant changes |
|---------|------|-----------------------|
| 1 | `initial_schema` | Creates `test_scripts`, `test_results`, `schedules`, `test_presets`, `webhooks`, `log_sources`, `live_metrics`. No `project_id` columns. |
| 2 | `add_column_extensions` | Adds `is_baseline`, `duration_seconds`, `step_metrics`, `description`, `status_message`, `steps`, `test_data`. No auth changes. |
| 3 | `log_sources_metrics_endpoint` | Adds `metrics_endpoint_template`, `auth_header` to `log_sources`. No auth changes. |
| 4 | `webhooks_format` | Adds `format` column to `webhooks`. No auth changes. |
| 5 | `projects_and_project_id` | **Creates `projects` table. Adds `project_id` FK to 6 tables. Creates 2 indexes.** Lines 159-177. |

### Migration Engine (`createSchema`)

**File:** `services/results-service/src/db.ts:183-202`

```typescript
export const createSchema = async (p: Pool): Promise<void>
```

1. Creates `schema_migrations` table with `(version INTEGER PRIMARY KEY, name TEXT, applied_at TIMESTAMPTZ)`. Lines 184-190.
2. Queries all applied versions into a `Set<number>`. Lines 192-193.
3. Iterates `MIGRATIONS` array in order; skips versions already in the set; applies remaining; records each. Lines 195-201.
4. **Idempotent** — safe to run on every startup. All DDL uses `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`.

---

## 8. API Key Authentication

**Correction note (updated alongside the `original-code-specs-auth-tenancy.md` staleness pass):** api-service no longer has a separate, conditionally-registered API key hook — it was merged into the same always-registered `onRequest` hook that also does per-team API key lookup and session auth. Line numbers below and the "Difference" callout are updated accordingly; see `docs/original-code-specs-auth-tenancy.md` Sections A.3 and B.3 for the full current behavior (both hooks now also support a per-team `team_api_keys` credential and, on results-service, org/role resolution — out of scope for this doc).

Both api-service and results-service support a global `API_KEYS` env var (comma-split, trimmed, filtered for empties at startup) checked against the `x-api-key` header. For the exact code, see `docs/original-code-specs-auth-tenancy.md`: Section B.3 for the api-service hook (`services/api-service/src/index.ts:89-149`), and Section A.3 for the results-service check (`services/results-service/src/app.ts:77-183`).

**Difference (updated):** both services now run their API key check(s) inline inside a single always-registered `onRequest` hook, rather than api-service using a separate conditionally-registered hook as before. api-service's hook still only exempts `/health`; results-service's hook still exempts a much larger set (all `/auth/*` routes, `/health`, `/system/ai-status`, `/ws`, and the internal worker-callback paths/suffixes).

**UNKNOWN (still accurate):** in both services, the API key check(s) run inside the same `onRequest` hook as the session check, API key first. If `API_KEYS` (and, on results-service, no per-team key matches) is empty/absent, the API key block is skipped entirely and the session check runs.

---

## 9. Shared Types — Auth-Related Fields

**File:** `packages/shared/src/index.ts`

### `TestRequest.projectId`
```typescript
projectId?: string;  // set by api-service from session; filters DB scope
```
Line 64. Optional. Populated by api-service from `request.projectId` when session auth is active.

### `TestResult.projectId`
```typescript
projectId?: string;  // set by workers from test.projectId; consumer saves it to test_results.project_id
```
Line 124. Optional. Workers copy from `test.projectId` field on the enriched request.

### `EnrichedTestRequest` (extends `TestRequest`)
**File:** `packages/shared/src/index.ts:190-197`

No additional auth-specific fields beyond those inherited from `TestRequest`.

---

## 10. Test Coverage Summary

### `auth.test.ts` — Project Isolation Tests

- **Project creation/reuse:** `auth.test.ts:91-97` — two logins with the same `projectName` produce exactly one row in `projects` and return the same `projectId`.
- **Session middleware exemptions:** `auth.test.ts:149-189` — confirms `/health`, `/results/pending`, `/results/:testId/cancel` are exempt.

**Coverage gap:** No test in `auth.test.ts` verifies that a user from project A cannot read results from project B (cross-project data isolation). The session middleware tests only verify authentication, not authorization/isolation.

### `api.test.ts` — Endpoint Coverage

**File:** `services/results-service/src/__tests__/api.test.ts` (64 tests)

- Tests all REST endpoints against a real PostgreSQL Testcontainers instance.
- Auth is disabled in most tests (no `SESSION_SECRET` set in test setup), so `request.projectId` is `undefined` and the `IS NULL` branch of the filter fires — all rows are visible.

**Coverage gap:** No test in `api.test.ts` verifies cross-project isolation (project A user cannot see project B resources). The `($N::uuid IS NULL OR project_id = $N::uuid)` filter correctness in the non-null branch is untested at the integration level.

---

## 11. Unknowns and Assumptions

| ID | Type | Description |
|----|------|-------------|
| U1 | **Resolved (2026-07-06)** | Originally: `test_scripts.project_id` was always `null` for scripts inserted by `worker-backend`, breaking `GET /scripts`'s project filter. Verified fixed — `worker-backend/src/index.ts:70-71`'s `saveScript` upsert now does `project_id = COALESCE(test_scripts.project_id, EXCLUDED.project_id)`, preserving the `project_id` set by the originating api-service request instead of overwriting it with the worker's own null context. Already documented in `docs/ARCHITECTURE.md`'s Security Architecture section; this reference doc was the one place still describing the old behavior. | `services/worker-backend/src/index.ts:70-71` |
| U2 | Unknown | `POST /results/:testId/baseline` and `DELETE /results/:testId/baseline` do not apply the `project_id` filter. Cross-project baseline manipulation is possible. |
| U3 | Unknown | `GET /results/:testId/report.pdf` does not apply the `project_id` filter. Any authenticated user can download any report. |
| U4 | Unknown | `live_metrics` table has no `project_id` column. Live metric data is not project-isolated. |
| U5 | Assumption | `findOrCreateProject` name normalization (`trim().toLowerCase()`) is applied by the caller (`app.ts:84-85`), not inside the function. Direct calls without normalization would store mixed-case names. |
| U6 | Unknown | The `ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name` upsert performs a write even on conflict, generating unnecessary WAL. No performance testing covers this. |
| U7 | Unknown | No explicit `CASCADE` or `SET NULL` on `project_id` FK columns. If a project row is deleted from `projects`, the FK constraint (`NO ACTION`) would prevent deletion if any resource rows reference it. No `DELETE /projects` endpoint exists, so this is currently moot but relevant for future cleanup. |
| U8 | Resolved | `api-service/src/index.ts` — `POST /tests` enforces `steps.length > 20` (returns 400 above that limit), confirmed in the current code. This is not an inconsistency: `docs/ARCHITECTURE.md`'s Security Architecture section explains that the FlowBuilder recording/HAR-import UI separately allows up to 50 steps for review and trimming, and only warns/blocks the client-side "Run Test" action once `steps.length > 20`. The 20-step API limit and the 50-step UI review limit are two different, intentional caps for two different purposes, not a doc/code mismatch. |
| U9 | Assumption | Both services parse `API_KEYS` using `split(',').map(k => k.trim()).filter(Boolean)`. Keys with internal spaces would pass the trim (only leading/trailing trimmed) and be treated as a single key. |
