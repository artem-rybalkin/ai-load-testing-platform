# Reference Code Specs — Cookie Session Auth

Factual specification of the cookie session mechanism, auth endpoints, and Fastify auth middleware.
No generalizations, no recommendations. Every claim is cited to file:line.

---

## 1. Files Covered

| File | Role |
|------|------|
| `services/results-service/src/session.ts` | HMAC session sign/verify — primary implementation |
| `services/api-service/src/session.ts` | Exact byte-for-byte copy of the above (duplicate module) |
| `services/results-service/src/app.ts` | Auth endpoints + `onRequest` middleware |
| `services/results-service/src/__tests__/session.test.ts` | Unit tests for session module |
| `services/results-service/src/__tests__/auth.test.ts` | Integration tests for auth endpoints and middleware |

**UNKNOWN / ASSUMPTION:** `services/api-service/src/session.ts` is a verbatim copy of `results-service/src/session.ts` (identical source code, verified by reading both). There is no shared import — the duplication appears intentional to avoid a cross-service import dependency. Risk: drift if one is patched.

---

## 2. Interface: `SessionPayload`

**File:** `services/results-service/src/session.ts:3-7`

```typescript
export interface SessionPayload {
  projectId: string;   // UUID from the projects table
  username: string;    // provided by user at login; not validated against any store
  projectName: string; // lowercased project name; returned as-is from DB row
}
```

The same interface is re-declared identically in `services/api-service/src/session.ts:3-7`.

---

## 3. Function: `signSession`

**File:** `services/results-service/src/session.ts:12-16`

### Signature
```typescript
export const signSession = (payload: SessionPayload, secret: string): string
```

### Behavior
1. `encode(payload)` — JSON-serializes `payload`, converts bytes to **base64url** string (`Buffer.toString('base64url')`). Line 9.
2. Computes `HMAC-SHA256(data, secret)` and encodes result as hex (`digest('hex')`). Line 14.
3. Returns `"<base64url_data>.<hex_sig>"` — a single dot-separated string. Line 15.

### Callers
- `services/results-service/src/app.ts:86` — `POST /auth/login` route, after `findOrCreateProject` returns.
- No other callers in codebase (confirmed by reading all auth and session files).

### Edge Cases (from tests)
- Different secrets produce different tokens for the same payload — `session.test.ts:28-33`.
- The base64url-encoded data is the first dot-delimited segment and can be decoded independently — `session.test.ts:21-27`.

---

## 4. Function: `verifySession`

**File:** `services/results-service/src/session.ts:18-31`

### Signature
```typescript
export const verifySession = (cookie: string | undefined, secret: string): SessionPayload | null
```

### Behavior
1. Returns `null` if `cookie` is falsy (undefined, empty string). Line 19.
2. Finds the **last** dot in the cookie string (`lastIndexOf('.')`). Line 20. Returns `null` if no dot found.
3. Splits on last dot: `data = cookie.slice(0, dot)`, `sig = cookie.slice(dot + 1)`. Lines 22-23.
4. Recomputes `HMAC-SHA256(data, secret)` as hex. Line 24.
5. **Length check first:** returns `null` if `sig.length !== expected.length`. Line 26.
6. **Constant-time comparison:** XOR-accumulates char code differences; returns `null` if `diff !== 0`. Lines 27-29.
7. **Decode with try/catch:** calls `decode(data)` inside try/catch; returns `null` on any JSON/base64 parse error. Line 30.

### Return Value
- `SessionPayload` on success, `null` on any failure.

### Callers
- `services/results-service/src/app.ts:62` — `onRequest` hook, reads `request.cookies['alt_session']`.
- `services/results-service/src/app.ts:106` — `GET /auth/me` handler.
- `services/api-service/src/index.ts:76` — `onRequest` hook, reads `request.cookies?.['alt_session']`.

### Edge Cases (from tests — `session.test.ts`)
| Case | Expected | Test line |
|------|----------|-----------|
| `undefined` cookie | `null` | 42-44 |
| Empty string cookie | `null` | 46-48 |
| No dot separator | `null` | 50-52 |
| Last 4 chars replaced with `"xxxx"` | `null` (tamper) | 54-58 |
| Signed with different secret | `null` | 60-62 |
| Data portion is `"!!!invalid!!!"` (not valid base64url JSON) | `null` | 64-68 |
| Sig is `"short"` (length differs from expected 64-char hex) | `null` | 70-75 |

**Note:** The length check at line 26 uses `sig.length !== expected.length` (not `===`). This means a sig padded to exactly 64 chars with wrong chars would still pass the length check and fail the XOR comparison. The short-sig test (`"short"` is 5 chars vs 64-char hex) exercises the length mismatch branch.

**UNKNOWN:** There is no expiry/`iat`/`exp` claim in the payload. Sessions are valid until the `maxAge` cookie attribute (30 days, set at `app.ts:92`) expires on the client side. Server-side session revocation is not possible without additional storage.

---

## 5. Auth Routes — `POST /auth/login`

**File:** `services/results-service/src/app.ts:73-97`

### Handler Signature (Fastify)
```typescript
app.post<{ Body: { username: string; projectName: string } }>(
  '/auth/login',
  async (request, reply) => { ... }
)
```

### Behavior
1. Reads `username` and `projectName` from request body.
2. Returns HTTP 400 with `{ error: 'username and projectName are required' }` if either is falsy after `.trim()`. Lines 77-79.
3. **Dev mode** (when `sessionSecret === ''`): returns `{ projectId: 'dev', username: username.trim(), projectName: projectName.trim() }` with no cookie. Lines 80-83.
4. **Auth mode:** calls `findOrCreateProject(projectName.trim(), pool)` to get/create the UUID. Line 84.
5. Builds `SessionPayload` — note: `projectName` is stored as `projectName.trim().toLowerCase()` in the payload. Line 85.
6. Calls `signSession(payload, sessionSecret)` → cookie value. Line 86.
7. Sets cookie `alt_session` with: `httpOnly: true`, `sameSite: 'strict'`, `path: '/'`, `secure` only when `NODE_ENV === 'production'`, `maxAge: 30 * 24 * 60 * 60` (30 days). Lines 87-94.
8. If `process.env.DOMAIN` is set, adds `domain: '.${DOMAIN}'`. Line 93.
9. Returns `payload` as JSON body. Line 95.

### Exemption from middleware
The `onRequest` hook explicitly skips `/auth/login` by URL check at `app.ts:49`.

### Tests covering this route (`auth.test.ts`)
- Returns 400 on missing `username` — line 51.
- Returns 400 on missing `projectName` — line 56.
- Returns 400 when both are whitespace — line 61.
- Returns 200 with payload on success — line 67.
- Sets `HttpOnly` `alt_session` cookie — line 80.
- Project created once, reused on second login with same `projectName` — line 91.

---

## 6. Auth Routes — `POST /auth/logout`

**File:** `services/results-service/src/app.ts:99-102`

### Behavior
1. Calls `reply.clearCookie('alt_session', { path: '/' })`.
2. Returns `{ ok: true }`.

### Tests
- Returns 200 with `ok: true` — `auth.test.ts:103`.
- `set-cookie` header clears `alt_session` (empty value or `Max-Age=0`) — `auth.test.ts:109`.

---

## 7. Auth Routes — `GET /auth/me`

**File:** `services/results-service/src/app.ts:104-109`

### Behavior
1. **Dev mode** (`sessionSecret === ''`): returns `{ projectId: 'dev', username: 'dev', projectName: 'dev' }`.
2. **Auth mode:** calls `verifySession(request.cookies?.['alt_session'], sessionSecret)`.
   - Returns `null` → HTTP 401 `{ error: 'Not authenticated' }`.
   - Returns payload → HTTP 200 with payload.

### Tests
- 401 with no cookie — `auth.test.ts:121`.
- 200 with valid cookie obtained from login — `auth.test.ts:127`.
- 401 with tampered cookie (`alt_session=data.badsignature`) — `auth.test.ts:141`.
- Dev mode: 200 with static `{ username: 'dev' }`, no cookie required — `auth.test.ts:216`.

---

## 8. `onRequest` Middleware — results-service

**File:** `services/results-service/src/app.ts:47-70`

### Exemption Logic

Two sets of exempt paths, evaluated before any auth check:

**Always exempt (auth routes):**
```typescript
if (url === '/auth/login' || url === '/auth/logout' || url === '/auth/me') return;
```
Line 49.

**Internal paths set** (`internalPaths`, line 41):
```typescript
const internalPaths = new Set(['/health', '/system/ai-status', '/results/pending', '/ws'])
```

**Internal suffixes** (`internalSuffixes`, line 42):
```typescript
['/running', '/fail', '/message', '/live', '/cancel']
```

`isInternal(url)` returns true if the path (stripped of query string) is in `internalPaths` OR ends with any `internalSuffixes` entry. Lines 43-45.

### API Key Check (when `apiKeys.length > 0`)
- Reads `request.headers['x-api-key']`.
- If missing or not in the `apiKeys` array → HTTP 401 `{ error: 'Unauthorized' }`. Lines 53-57.
- `apiKeys` is parsed from `process.env.API_KEYS` comma-split at startup. Line 38.

### Session Check (when `sessionSecret !== ''`)
- Calls `verifySession(request.cookies['alt_session'], sessionSecret)`.
- Null → HTTP 401 `{ error: 'Not authenticated' }`. Line 63.
- Non-null → sets `request.session = session` and `request.projectId = session.projectId`. Lines 64-65.

### Dev mode (both secrets empty)
- Sets `request.session = null`, `request.projectId = undefined`. Lines 67-68.

**IMPORTANT:** Both API key auth and session auth run in the **same** `onRequest` hook. API key is checked first. Session is checked second. Either can independently reject the request.

---

## 9. `onRequest` Middleware — api-service

**File:** `services/api-service/src/index.ts:59-82`

### API Key Hook (conditional registration)
```typescript
if (apiKeys.length > 0) {
  app.addHook('onRequest', async (request, reply) => { ... })
}
```
Lines 60-68. Only registers when `API_KEYS` is non-empty.

**Exemption:** `request.url === '/health'` — line 63.

**Reject condition:** key missing or not in `apiKeys` array → HTTP 401. Lines 64-66.

### Session Hook (always registered, second hook)
```typescript
app.addHook('onRequest', async (request, reply) => { ... })
```
Lines 73-82.

**Exemption:** `request.url === '/health'` — line 74.

**Dev mode** (`sessionSecret === ''`): sets `request.projectId = undefined`. Line 80.

**Auth mode:** calls `verifySession(request.cookies?.['alt_session'], sessionSecret)` (note optional chaining on `.cookies`). Line 76.
- Null → HTTP 401 `{ error: 'Not authenticated' }`. Line 77.
- Non-null → sets `request.projectId = session.projectId`. Line 78.

**Difference from results-service:** api-service session hook does NOT set `request.session`, only `request.projectId`. The `FastifyRequest` augmentation only declares `projectId: string | undefined` (line 13), not `session`.

---

## 10. Fastify Module Augmentation

**results-service** (`app.ts:14-19`):
```typescript
declare module 'fastify' {
  interface FastifyRequest {
    session: SessionPayload | null;
    projectId: string | undefined;
  }
}
```
Both `session` and `projectId` are attached.

**api-service** (`index.ts:12-14`):
```typescript
declare module 'fastify' {
  interface FastifyRequest { projectId: string | undefined; }
}
```
Only `projectId` is attached.

---

## 11. Cookie Configuration Summary

Set in `POST /auth/login` handler (`app.ts:87-94`):

| Attribute | Value | Notes |
|-----------|-------|-------|
| Name | `alt_session` | Hard-coded |
| `httpOnly` | `true` | Not accessible via JS |
| `sameSite` | `'strict'` | No cross-site send |
| `path` | `'/'` | All paths |
| `secure` | `process.env.NODE_ENV === 'production'` | HTTP allowed in dev |
| `maxAge` | `2592000` (30 days, in seconds) | Client-side expiry only |
| `domain` | `.${DOMAIN}` if `DOMAIN` env set | Subdomain sharing |

---

## 12. Test Coverage Summary

### `session.test.ts` — 11 unit tests

| Suite | Count | What is covered |
|-------|-------|-----------------|
| `signSession` | 3 | Format (2 parts), base64url decodable, different secrets differ |
| `verifySession` | 8 | Valid token, undefined, empty string, no dot, tampered sig, wrong secret, invalid base64, short sig length |

**Coverage gap:** No test for a payload with special characters or Unicode in fields.

### `auth.test.ts` — 18 integration tests (real PostgreSQL via Testcontainers)

| Suite | Count | What is covered |
|-------|-------|-----------------|
| `POST /auth/login` | 6 | Missing fields, whitespace, success, HttpOnly cookie, project reuse |
| `POST /auth/logout` | 2 | 200 ok, cookie cleared |
| `GET /auth/me` | 3 | 401 no cookie, 200 valid cookie, 401 tampered |
| `Session middleware` | 5 | 401 no cookie on /results, /health exempt, /results/pending exempt, /cancel exempt, valid cookie allows |
| `Dev mode` | 3 | Login no cookie, /auth/me static dev response, /results accessible |

**Notable: cancel path exemption.** `auth.test.ts:169` confirms `POST /results/:testId/cancel` is exempt from session auth — classified as an internal suffix (`/cancel`).

---

## 13. Unknowns and Assumptions

| ID | Type | Description |
|----|------|-------------|
| U1 | Unknown | Session revocation is not implemented. No server-side token store. Tokens are valid until client cookie expires (30 days). |
| U2 | Unknown | `projectName` is lowercased in `findOrCreateProject` (via `name.trim().toLowerCase()` in `db.ts:213`) and also lowercased in the `SessionPayload` built in `app.ts:85`. The `username` field is NOT lowercased — stored as provided. |
| U3 | Unknown | No test exercises `secure: true` cookie behavior (only runs in `NODE_ENV === 'production'`). |
| U4 | Unknown | api-service uses `request.cookies?.['alt_session']` (optional chaining) while results-service uses `request.cookies['alt_session']` (no optional chaining). The behavior is the same since `verifySession` accepts `undefined`, but the inconsistency is noted. |
| U5 | Assumption | The `session.ts` duplication between api-service and results-service is intentional to avoid a cross-service import boundary. This is unconfirmed — there is no comment explaining the choice. |
| U6 | Unknown | `GET /auth/me` in dev mode returns hardcoded `{ projectId: 'dev', username: 'dev', projectName: 'dev' }` regardless of any cookie present. This means a legitimate session cookie in dev mode is silently ignored. |
| U7 | Unknown | The `onRequest` hook in results-service checks API key AND session in sequence. It is possible to configure `API_KEYS` without `SESSION_SECRET` or vice versa. The combined behavior: API key fails → 401 immediately; API key passes (or not configured) → session check runs. No test covers the mixed case (API key set + session set simultaneously). |
