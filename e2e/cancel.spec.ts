import { test, expect } from '@playwright/test';

/**
 * Cancel flow: create a test, wait for it to appear as running/pending,
 * then cancel it and verify the status becomes "cancelled".
 * Requires: docker compose up.
 */
test.describe('Cancel flow', () => {
  test('cancels a running test and shows cancelled status', async ({ page }) => {
    await page.goto('/');

    await page.fill('input[type="text"][placeholder*="acme"]', 'http://localhost:3000/health');

    // Open Advanced settings to access load profile (now hidden by default)
    const advancedBtn = page.getByText(/advanced settings/i);
    await advancedBtn.click();

    // Use soak profile so the test runs long enough to cancel
    await page.getByRole('button', { name: /soak/i }).click();

    await page.getByRole('button', { name: /run test/i }).click();

    // Wait to land on the result detail page
    await expect(page).toHaveURL(/\/results\/[0-9a-f-]{36}/, { timeout: 10_000 });

    // Wait for the Cancel button to appear (only visible for pending/running tests)
    const cancelBtn = page.getByRole('button', { name: /cancel/i });
    await expect(cancelBtn).toBeVisible({ timeout: 30_000 });

    await cancelBtn.click();

    // Status should update to "cancelled" (use first() to handle multiple matches)
    await expect(page.getByText(/cancelled/i).first()).toBeVisible({ timeout: 15_000 });
  });
});
