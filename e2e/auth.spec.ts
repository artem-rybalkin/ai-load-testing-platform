import { test, expect } from '@playwright/test';

/**
 * Auth journeys: login validation, redirect-when-unauthenticated, session
 * persistence, and logout. These run in a *fresh* (unauthenticated) browser
 * context — the shared `storageState` from auth.setup.ts is intentionally
 * not used here, since we need to exercise the logged-out state.
 * Requires: docker compose up.
 */
test.describe('Auth', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('redirects an unauthenticated visitor from a protected page to /login', async ({ page }) => {
    await page.goto('/results');
    await expect(page).toHaveURL('/login');
    await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
  });

  test('requires email and password before submitting', async ({ page }) => {
    await page.goto('/login');

    const submit = page.getByRole('button', { name: /sign in/i });
    await submit.click();

    // Native HTML5 "required" validation blocks submission — still on /login
    await expect(page).toHaveURL('/login');

    await page.locator('input[type="email"]').fill('e2e-auth-user@example.com');
    await submit.click();
    await expect(page).toHaveURL('/login');
  });

  test('registers a new account, lands on the home page, and persists the session across reloads', async ({ page }) => {
    const email = `e2e-auth-user-${Date.now()}@example.com`;

    await page.goto('/login');
    await page.getByRole('button', { name: /don't have an account\? create one/i }).click();
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill('e2e-password-123');
    await page.locator('input[placeholder="your name"]').fill('e2e-auth-user');
    await page.locator('input[placeholder="my-team"]').fill(`e2e-auth-team-${Date.now()}`);
    await page.getByRole('button', { name: /create account/i }).click();

    await expect(page).toHaveURL('/');

    // Reload — session cookie should keep the user logged in (no bounce to /login)
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL('/');
    await expect(page.getByText(email, { exact: false })).toBeVisible({ timeout: 10_000 });
  });

  test('logs out and redirects back to /login on next protected navigation', async ({ page }) => {
    const email = `e2e-logout-user-${Date.now()}@example.com`;

    await page.goto('/login');
    await page.getByRole('button', { name: /don't have an account\? create one/i }).click();
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill('e2e-password-123');
    await page.locator('input[placeholder="your name"]').fill('e2e-logout-user');
    await page.locator('input[placeholder="my-team"]').fill(`e2e-logout-team-${Date.now()}`);
    await page.getByRole('button', { name: /create account/i }).click();
    await expect(page).toHaveURL('/');

    // Wait for the authenticated shell to actually render (not just the URL to change) —
    // AuthGate renders nothing while `loading` is true, so asserting on the sign-out
    // button's *visibility* (rather than just its presence) avoids racing that state.
    const signOutBtn = page.getByRole('button', { name: /sign out/i });
    await expect(signOutBtn).toBeVisible({ timeout: 30_000 });
    await signOutBtn.click();

    await expect(page).toHaveURL('/login', { timeout: 10_000 });

    // Direct navigation to a protected page should now bounce back to /login
    await page.goto('/results');
    await expect(page).toHaveURL('/login');
  });

  test('two different accounts create isolated sessions (no cross-account bleed)', async ({ browser }) => {
    // Run sequentially (one context/page at a time) rather than two concurrent
    // contexts in the same browser — two simultaneous renderer processes against
    // the dev server reliably produced a blank, never-painted page here.
    const emailA = `e2e-user-a-${Date.now()}@example.com`;
    const emailB = `e2e-user-b-${Date.now()}@example.com`;

    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await pageA.goto('/login');
    await pageA.getByRole('button', { name: /don't have an account\? create one/i }).click();
    await pageA.locator('input[type="email"]').fill(emailA);
    await pageA.locator('input[type="password"]').fill('e2e-password-123');
    await pageA.locator('input[placeholder="your name"]').fill('user-a');
    await pageA.locator('input[placeholder="my-team"]').fill(`proj-a-${Date.now()}`);
    await pageA.getByRole('button', { name: /create account/i }).click();
    await expect(pageA).toHaveURL('/');

    // Wait for the authenticated shell to render before reading the email
    // (AuthGate shows nothing while session state is still resolving post-login).
    await expect(pageA.getByText(emailA, { exact: false })).toBeVisible({ timeout: 30_000 });
    const storageStateA = await ctxA.storageState();
    await ctxA.close();

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await pageB.goto('/login');
    await pageB.getByRole('button', { name: /don't have an account\? create one/i }).click();
    await pageB.locator('input[type="email"]').fill(emailB);
    await pageB.locator('input[type="password"]').fill('e2e-password-123');
    await pageB.locator('input[placeholder="your name"]').fill('user-b');
    await pageB.locator('input[placeholder="my-team"]').fill(`proj-b-${Date.now()}`);
    await pageB.getByRole('button', { name: /create account/i }).click();
    await expect(pageB).toHaveURL('/');
    await expect(pageB.getByText(emailB, { exact: false })).toBeVisible({ timeout: 30_000 });
    await ctxB.close();

    // Restore account A's session in a fresh context — it should still show
    // user A, never user B's data (no cross-account bleed).
    const ctxA2 = await browser.newContext({ storageState: storageStateA });
    const pageA2 = await ctxA2.newPage();
    await pageA2.goto('/');
    await expect(pageA2.getByText(emailA, { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(pageA2.getByText(emailB, { exact: false })).not.toBeVisible();
    await ctxA2.close();
  });
});
