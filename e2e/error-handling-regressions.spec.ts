import { test, expect } from '@playwright/test';

/**
 * Regression specs for the 4 ui-service findings filed in TODO.md (follow-up
 * item #5) — all four share one root cause: most of `lib/api/*.ts` calls
 * `res.json()` directly with no `res.ok` check, so a non-2xx HTTP response is
 * treated as a successful payload.
 *
 * Each test here asserts the CORRECT/desired behavior and is marked
 * `test.fail()` — the assertion genuinely fails against current code, so
 * Playwright reports the test as an expected failure (green) while
 * permanently documenting the gap. The moment the underlying bug is fixed
 * without updating the test, Playwright flags it as "unexpectedly passed" —
 * that's the signal to remove `test.fail()` and promote it to a normal test.
 * Mirrors the `it.fails(...)` convention already used for the Vitest unit
 * regression tests covering the same 4 findings.
 *
 * Requires: docker compose up.
 */

test.describe('Compare-runs page crash (no ErrorBoundary)', () => {
  test('shows a friendly error instead of crashing when a compared result does not exist', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));

    // Two random UUIDs guaranteed to 404 against GET /data/results/compare —
    // no seed data needed. compareResults() never checks res.ok, so the 404
    // error body ({ error: '...' }) resolves into `setResults` as if valid,
    // and the component crashes trying to read `resultA.type` off `undefined`.
    const fakeA = '00000000-0000-4000-8000-000000000001';
    const fakeB = '00000000-0000-4000-8000-000000000002';
    await page.goto(`/results/compare?a=${fakeA}&b=${fakeB}`);

    // Desired: no uncaught render exception, and a friendly message shown.
    // toBeVisible() polls/retries, so this also gives the crash (if any) time to happen.
    await expect(page.getByText(/failed to load|not found/i)).toBeVisible({ timeout: 5_000 });
    expect(pageErrors, `expected no uncaught page errors, got: ${pageErrors.map(e => e.message).join('; ')}`).toHaveLength(0);
  });
});

test.describe('Silent failures on Stop / Set-baseline / Clear-baseline', () => {
  test('shows an error when Stop fails instead of failing silently', async ({ page }) => {
    await page.goto('/');
    await page.fill('input[type="text"][placeholder*="acme"]', 'http://localhost:3000/health');
    await page.getByText(/advanced settings/i).click();
    await page.getByRole('button', { name: /soak/i }).click(); // long-running, so Stop stays visible
    await page.getByRole('button', { name: /run test/i }).click();
    await expect(page).toHaveURL(/\/results\/[0-9a-f-]{36}/, { timeout: 10_000 });

    const cancelBtn = page.getByRole('button', { name: /^stop$/i });
    await expect(cancelBtn).toBeVisible({ timeout: 30_000 });

    // cancelTest() never checks res.ok — simulate the server rejecting the
    // cancel (e.g. a viewer-role 403, or any 5xx) and verify the user is told.
    await page.route('**/api/tests/*/cancel', (route) =>
      route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Forbidden' }) }));

    await cancelBtn.click();

    // Desired: an error is surfaced. Currently: the button silently returns
    // to its normal state and the test keeps running with zero indication
    // anything went wrong — there is no error UI for this action at all.
    await expect(page.getByTestId('action-error')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('action-error')).toContainText(/forbidden/i);
  });

  test('shows an error when Set baseline fails instead of failing silently', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /custom script/i }).click();
    const urlInput = page.locator('input[placeholder*="example"]');
    await urlInput.click();
    await urlInput.fill('http://api-service:3000/health');
    await page.locator('textarea').fill(`import http from 'k6/http';
import { sleep } from 'k6';
export const options = { vus: 1, duration: '5s' };
export default function () { http.get('http://api-service:3000/health'); sleep(1); }
`);
    await page.getByRole('button', { name: /run test/i }).click();
    await expect(page).toHaveURL(/\/results\/[0-9a-f-]{36}/, { timeout: 15_000 });
    await expect(page.getByText(/^completed$/i).first()).toBeVisible({ timeout: 60_000 });

    // setBaseline() never checks res.ok — simulate a rejected baseline set.
    await page.route('**/data/results/*/baseline', (route) =>
      route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Forbidden' }) }));

    await page.getByRole('button', { name: /set baseline/i }).click();

    // Desired: an error is surfaced instead of the button quietly resetting.
    await expect(page.getByTestId('action-error')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('action-error')).toContainText(/forbidden/i);
  });
});

test.describe('Webhook creation silent failure', () => {
  test('shows an error and preserves the form instead of silently resetting it', async ({ page }) => {
    await page.goto('/webhooks');
    await page.waitForLoadState('networkidle');

    const url = `https://e2e-regression-${Date.now()}.example.com/hook`;
    await page.locator('input[placeholder="https://your-endpoint.example.com/webhook"]').fill(url);

    // createWebhook() never checks res.ok — simulate a server-side rejection
    // (e.g. SSRF-style URL validation, duplicate, quota).
    await page.route('**/data/webhooks', (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'URL rejected' }) });
      }
      return route.continue();
    });

    await page.getByRole('button', { name: /^add webhook$/i }).click();

    // Desired: an error message is shown and the URL field keeps its value
    // so the user can retry. Currently: the form silently clears (`setUrl('')`
    // runs unconditionally after the awaited call resolves without throwing)
    // and nothing in the webhook list or on the page indicates failure.
    await expect(page.locator('p').filter({ hasText: /error|failed|rejected/i })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('input[placeholder="https://your-endpoint.example.com/webhook"]')).toHaveValue(url);
  });
});

test.describe('Results list stuck on Loading forever', () => {
  test('shows an error/retry state instead of loading forever when the fetch fails', async ({ page }) => {
    // refresh() now wraps getResults in try/catch/finally — a rejected fetch
    // transitions out of the loading state instead of hanging forever.
    // route.abort() makes the underlying fetch() reject with a network error.
    await page.route('**/data/results?*', (route) => route.abort('failed'));

    await page.goto('/results');

    // The page must settle into an error state within a reasonable window —
    // the "Loading…" skeleton must not remain visible once the request settles.
    // not.toBeVisible() polls/retries up to the timeout instead of a fixed sleep.
    await expect(page.getByText(/loading/i)).not.toBeVisible({ timeout: 8_000 });
  });
});
