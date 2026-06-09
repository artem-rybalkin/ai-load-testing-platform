import { test as setup, expect } from '@playwright/test';

/**
 * Authenticates once and saves the session cookie to disk so all other specs
 * can reuse it via `storageState` (see playwright.config.ts `chromium` project).
 * Required because results-service now always runs with SESSION_SECRET set
 * (cookie-session auth is on by default, including local dev).
 */
const authFile = 'e2e/.auth/user.json';

setup('authenticate', async ({ page }) => {
  await page.goto('/login');

  await page.locator('input[placeholder="your name"]').fill('e2e-runner');
  await page.locator('input[placeholder="my-project"]').fill('e2e-project');
  await page.getByRole('button', { name: /sign in/i }).click();

  await expect(page).toHaveURL('/');

  await page.context().storageState({ path: authFile });
});
