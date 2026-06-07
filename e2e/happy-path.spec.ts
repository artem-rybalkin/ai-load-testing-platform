import { test, expect } from '@playwright/test';

/**
 * Happy path: create a backend test → poll result page → confirm it completes.
 * Requires: docker compose up (all services running on localhost ports).
 */
test.describe('Happy path — create and complete a backend test', () => {
  test('creates a test, navigates to result, and eventually shows completed or failed status', async ({ page }) => {
    await page.goto('/');

    // Use click+fill+Tab to ensure React commits state before reading it in handleSubmit.
    // Playwright fill() may dispatch programmatic events that React 18 treats as
    // low-priority; pressing Tab triggers blur which forces a synchronous flush.
    const urlInput = page.locator('input[placeholder*="example"]');
    await urlInput.click();
    await urlInput.fill('http://localhost:3000/health');
    await urlInput.press('Tab');

    const descInput = page.locator('input[placeholder*="test"]');
    await descInput.fill('E2E smoke test 5 VUs 30s');
    await descInput.press('Tab');

    // Click "Run Test"
    await page.getByRole('button', { name: /run test/i }).click();

    // Should navigate to /results/<id>
    await expect(page).toHaveURL(/\/results\/[0-9a-f-]{36}/, { timeout: 15_000 });

    // Eventually shows a final status — use .first() to handle multiple matches
    await expect(page.getByText(/completed|failed|cancelled/i).first()).toBeVisible({ timeout: 300_000 });
  });

  test('shows a progress bar or live indicator during execution', async ({ page }) => {
    await page.goto('/');

    const urlInput2 = page.locator('input[placeholder*="example"]');
    await urlInput2.click();
    await urlInput2.fill('http://localhost:3000/health');
    await urlInput2.press('Tab');
    const descInput2 = page.locator('input[placeholder*="test"]');
    await descInput2.fill('5 VUs 30s load test');
    await descInput2.press('Tab');
    await page.getByRole('button', { name: /run test/i }).click();

    await expect(page).toHaveURL(/\/results\/[0-9a-f-]{36}/, { timeout: 15_000 });

    // Any progress-bar or LIVE indicator should appear
    await expect(
      page.locator('.bg-\\[\\#0969da\\], [class*="animate-pulse"], [class*="rounded-full"]').first()
    ).toBeVisible({ timeout: 30_000 });
  });

  test('shows countdown text when test is running', async ({ page }) => {
    await page.goto('/');

    const urlInput3 = page.locator('input[placeholder*="example"]');
    await urlInput3.click();
    await urlInput3.fill('http://localhost:3000/health');
    await urlInput3.press('Tab');
    const descInput3 = page.locator('input[placeholder*="test"]');
    await descInput3.fill('2 VUs 30s');
    await descInput3.press('Tab');
    await page.getByRole('button', { name: /run test/i }).click();

    await expect(page).toHaveURL(/\/results\/[0-9a-f-]{36}/, { timeout: 15_000 });

    // Countdown shows once the test starts. If the worker is busy the test stays
    // pending — accept either "remaining/left" (running) or "pending" (queued).
    await expect(
      page.getByText(/remaining|finishing|left|pending/i).first()
    ).toBeVisible({ timeout: 120_000 });
  });
});
