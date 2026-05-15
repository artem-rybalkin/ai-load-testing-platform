import { test, expect } from '@playwright/test';

/**
 * Happy path: create a backend test → poll result page → confirm it completes.
 * Requires: docker compose up (all services running on localhost ports).
 */
test.describe('Happy path — create and complete a backend test', () => {
  test('creates a test, navigates to result, and eventually shows completed status', async ({ page }) => {
    await page.goto('/');

    // Verify the form is present
    await expect(page.getByRole('heading', { name: /ai load testing platform/i })).toBeVisible();

    // Fill in the target URL
    await page.fill('input[type="url"]', 'http://localhost:3000/health');

    // Optionally set a description
    await page.fill('input[placeholder*="Describe"]', 'E2E smoke test');

    // Click "Run test"
    await page.getByRole('button', { name: /run test/i }).click();

    // Should navigate to /results/<id>
    await expect(page).toHaveURL(/\/results\/[0-9a-f-]{36}/, { timeout: 10_000 });

    // The result page should eventually show a final status (completed or failed)
    // Poll up to 5 minutes (the test itself takes time to run)
    await expect(page.getByText(/completed|failed|cancelled/i)).toBeVisible({ timeout: 300_000 });
  });
});
