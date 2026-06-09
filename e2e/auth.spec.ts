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

  test('requires both username and project before submitting', async ({ page }) => {
    await page.goto('/login');

    const submit = page.getByRole('button', { name: /sign in/i });
    await submit.click();

    // Native HTML5 "required" validation blocks submission — still on /login
    await expect(page).toHaveURL('/login');

    await page.locator('input[placeholder="your name"]').fill('e2e-auth-user');
    await submit.click();
    await expect(page).toHaveURL('/login');
  });

  test('logs in, lands on the home page, and persists the session across reloads', async ({ page }) => {
    await page.goto('/login');
    await page.locator('input[placeholder="your name"]').fill('e2e-auth-user');
    await page.locator('input[placeholder="my-project"]').fill('e2e-auth-project');
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page).toHaveURL('/');

    // Reload — session cookie should keep the user logged in (no bounce to /login)
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL('/');
    await expect(page.getByText('e2e-auth-user', { exact: false })).toBeVisible({ timeout: 10_000 });
  });

  test('logs out and redirects back to /login on next protected navigation', async ({ page }) => {
    await page.goto('/login');
    await page.locator('input[placeholder="your name"]').fill('e2e-logout-user');
    await page.locator('input[placeholder="my-project"]').fill('e2e-logout-project');
    await page.getByRole('button', { name: /sign in/i }).click();
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

  test('two different project names create isolated sessions (no cross-project bleed)', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await pageA.goto('/login');
    await pageA.locator('input[placeholder="your name"]').fill('user-a');
    await pageA.locator('input[placeholder="my-project"]').fill(`proj-a-${Date.now()}`);
    await pageA.getByRole('button', { name: /sign in/i }).click();
    await expect(pageA).toHaveURL('/');

    await pageB.goto('/login');
    await pageB.locator('input[placeholder="your name"]').fill('user-b');
    await pageB.locator('input[placeholder="my-project"]').fill(`proj-b-${Date.now()}`);
    await pageB.getByRole('button', { name: /sign in/i }).click();
    await expect(pageB).toHaveURL('/');

    // Wait for the authenticated shell to render before reading the username
    // (AuthGate shows nothing while session state is still resolving post-login).
    await expect(pageA.getByText('user-a', { exact: false })).toBeVisible({ timeout: 30_000 });
    await expect(pageB.getByText('user-b', { exact: false })).toBeVisible({ timeout: 30_000 });

    await ctxA.close();
    await ctxB.close();
  });
});
