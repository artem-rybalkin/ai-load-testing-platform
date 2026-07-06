// @vitest-environment jsdom
/**
 * Regression tests for TODO findings #1, #2, #3.
 *
 * Root cause shared by all three: the lib/api/* functions call fetch (via
 * the shared `f()` helper in core.ts) but do not check `res.ok` before
 * calling `res.json()` or returning.  A non-2xx response is therefore
 * indistinguishable from a successful one.
 *
 * cancelTest/setBaseline/clearBaseline (finding #1) are fixed as of
 * 2026-07-06 — those three now run as plain `it()`. compareResults
 * (#2) and createWebhook (#3) are still open and remain `it.fails`
 * until they get the same treatment:
 *   - When the bug is PRESENT  → the function resolves silently, the
 *     `.rejects.toThrow()` assertion fails → `it.fails` reports PASS (CI green).
 *   - When the bug is FIXED    → the function rejects, the assertion passes
 *     → `it.fails` flips to red, signalling that the wrapper should be
 *     removed and the test promoted to a plain `it`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cancelTest, setBaseline, clearBaseline, compareResults, createWebhook } from '@/lib/api';

// ---------------------------------------------------------------------------
// fetch stub factory
// ---------------------------------------------------------------------------

/**
 * Returns a fetch mock that resolves with a minimal Response-like object
 * whose `ok` flag matches the given status code.
 */
const makeErrorFetch = (status: number, body: unknown = { error: `HTTP ${status}` }) =>
  vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response);

beforeEach(() => {
  // Default stub: 403 Forbidden — covers finding #1 tests.
  vi.stubGlobal('fetch', makeErrorFetch(403));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Finding #1 (High) — cancelTest / setBaseline / clearBaseline fail silently
// on a non-2xx response.
//
// Affected code: services/ui/lib/api/tests.ts lines 157-167
// Functions return `void` and never inspect `res.ok` or `res.status`.
// ---------------------------------------------------------------------------

describe('Finding #1 — void-return actions silently ignore HTTP errors', () => {
  it(
    'cancelTest: should reject when the server returns 403',
    async () => {
      // Bug: cancelTest resolves (returns undefined) even on 403.
      // Fix: add res.ok check and throw on non-2xx.
      await expect(cancelTest('test-id-abc')).rejects.toThrow();
    },
  );

  it(
    'setBaseline: should reject when the server returns 403',
    async () => {
      await expect(setBaseline('test-id-abc')).rejects.toThrow();
    },
  );

  it(
    'clearBaseline: should reject when the server returns 403',
    async () => {
      await expect(clearBaseline('test-id-abc')).rejects.toThrow();
    },
  );
});

// ---------------------------------------------------------------------------
// Finding #2 (Medium) — compareResults resolves with the error body instead
// of throwing on a 404 response.
//
// Affected code: services/ui/lib/api/tests.ts lines 169-172
// The page then destructures `resultA` / `resultB` from `undefined` and
// crashes during render with no ErrorBoundary to catch it.
// ---------------------------------------------------------------------------

describe('Finding #2 — compareResults resolves with error body instead of throwing on 404', () => {
  it(
    'compareResults: should reject when the server returns 404',
    async () => {
      // Stub returns { error: "Not found" } — a 404 body, not a results pair.
      // Bug: compareResults returns { error: "Not found" } which the page's
      //      then() handler passes to setResults, later causing a crash on
      //      `resultA.type` (resultA is undefined).
      // Fix: check res.ok and throw so the .catch() handler can surface the error.
      vi.stubGlobal('fetch', makeErrorFetch(404, { error: 'Not found' }));
      await expect(compareResults('id-a', 'id-b')).rejects.toThrow();
    },
  );
});

// ---------------------------------------------------------------------------
// Finding #3 (Medium) — createWebhook resolves silently on a non-2xx,
// causing the form to reset as if the webhook was saved.
//
// Affected code: services/ui/lib/api/webhooks.ts lines 17-24
// The caller's catch branch is never reached.
// ---------------------------------------------------------------------------

describe('Finding #3 — createWebhook resolves with error body instead of throwing on non-2xx', () => {
  it(
    'createWebhook: should reject when the server returns 422',
    async () => {
      // Bug: createWebhook returns the 422 body as { webhook: ... } which
      //      makes handleAdd() silently reset the form and reload the list.
      // Fix: check res.ok and throw so handleAdd()'s catch branch fires.
      vi.stubGlobal('fetch', makeErrorFetch(422, { error: 'Validation failed' }));
      await expect(
        createWebhook('https://hook.example.com', ['failed'], 'generic'),
      ).rejects.toThrow();
    },
  );
});
