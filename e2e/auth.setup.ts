import { test as setup, expect } from '@playwright/test';

/**
 * Authenticates once and saves the session cookie to disk so all other specs
 * can reuse it via `storageState` (see playwright.config.ts `chromium` project).
 * Required because results-service now always runs with SESSION_SECRET set
 * (cookie-session auth is on by default, including local dev).
 *
 * The current LoginPage is email/password based with an optional register
 * mode (email + password + team name [+ name]). We try to register a fixed
 * e2e account; if it already exists from a previous run ("Email already
 * registered"), we fall back to logging in with the same credentials.
 */
const authFile = 'e2e/.auth/user.json';

const EMAIL = 'e2e-runner@example.com';
const PASSWORD = 'e2e-password-123';
const TEAM_NAME = 'e2e-team';
const NAME = 'e2e-runner';

setup('authenticate', async ({ page }) => {
  await page.goto('/login');

  // Switch to register mode
  await page.getByRole('button', { name: /don't have an account\? create one/i }).click();

  await page.locator('input[type="email"]').fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('input[placeholder="your name"]').fill(NAME);
  await page.locator('input[placeholder="my-team"]').fill(TEAM_NAME);
  await page.getByRole('button', { name: /create account/i }).click();

  // If the account/team already exists from a previous run, fall back to login.
  const alreadyRegistered = page.getByText(/already registered|already taken/i);
  const registrationFailed = await alreadyRegistered
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (registrationFailed) {
    await page.getByRole('button', { name: /already have an account\? sign in/i }).click();
    await page.getByRole('button', { name: /^sign in$/i }).click();
  }

  await expect(page).toHaveURL('/');

  await page.context().storageState({ path: authFile });
});
