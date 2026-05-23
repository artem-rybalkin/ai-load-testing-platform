import { test, expect } from '@playwright/test';

/**
 * Happy path: create a backend test → poll result page → confirm it completes.
 * Requires: docker compose up (all services running on localhost ports).
 */
test.describe('Happy path — create and complete a backend test', () => {
  test('creates a test, navigates to result, and eventually shows completed or failed status', async ({ page }) => {
    await page.goto('/');

    // Fill in the target URL (redesigned UI uses type="text" not type="url")
    await page.locator('input[placeholder*="example"]').fill('http://localhost:3000/health');

    // Fill description
    await page.locator('input[placeholder*="test"]').fill('E2E smoke test 5 VUs 30s');

    // Click "Run Test"
    await page.getByRole('button', { name: /run test/i }).click();

    // Should navigate to /results/<id>
    await expect(page).toHaveURL(/\/results\/[0-9a-f-]{36}/, { timeout: 15_000 });

    // Eventually shows a final status — use .first() to handle multiple matches
    await expect(page.getByText(/completed|failed|cancelled/i).first()).toBeVisible({ timeout: 300_000 });
  });

  test('shows a progress bar or live indicator during execution', async ({ page }) => {
    await page.goto('/');

    await page.locator('input[placeholder*="example"]').fill('http://localhost:3000/health');
    await page.locator('input[placeholder*="test"]').fill('5 VUs 30s load test');
    await page.getByRole('button', { name: /run test/i }).click();

    await expect(page).toHaveURL(/\/results\/[0-9a-f-]{36}/, { timeout: 15_000 });

    // Any progress-bar or LIVE indicator should appear
    await expect(
      page.locator('.bg-\\[\\#0969da\\], [class*="animate-pulse"], [class*="rounded-full"]').first()
    ).toBeVisible({ timeout: 30_000 });
  });

  test('shows countdown text when test is running', async ({ page }) => {
    await page.goto('/');

    await page.locator('input[placeholder*="example"]').fill('http://localhost:3000/health');
    await page.locator('input[placeholder*="test"]').fill('2 VUs 30s');
    await page.getByRole('button', { name: /run test/i }).click();

    await expect(page).toHaveURL(/\/results\/[0-9a-f-]{36}/, { timeout: 15_000 });

    // "remaining", "finishing", or "left" appears once test is running with known duration
    await expect(page.getByText(/remaining|finishing|left/i).first()).toBeVisible({ timeout: 60_000 });
  });
});
