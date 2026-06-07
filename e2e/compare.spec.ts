import { test, expect, Page } from '@playwright/test';

/**
 * Compare flow: seed two completed results via the API, navigate to the
 * results list, select both, and verify the compare view loads correctly.
 * Requires: docker compose up.
 */

const API_URL = 'http://localhost:3000';
const RESULTS_URL = 'http://localhost:3004';

async function createAndWaitForResult(page: Page): Promise<string> {
  const res = await page.request.post(`${API_URL}/tests`, {
    data: {
      type: 'backend',
      targetUrl: 'http://localhost:3000/health',
      description: 'compare E2E test',
      options: { vus: 1, duration: '10s' },
    },
  });
  const { test: created } = await res.json();
  const testId: string = created.id;

  // Poll until completed or failed (max 90 seconds)
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const r = await page.request.get(`${RESULTS_URL}/results/${testId}`);
    const { result } = await r.json();
    if (result?.status === 'completed' || result?.status === 'failed') break;
    await page.waitForTimeout(3000);
  }

  return testId;
}

test.describe('Compare flow', () => {
  test('selects two results and opens the compare view', async ({ page }) => {
    // Create two tests and wait for both to complete
    // WORKER_CONCURRENCY≥2 required on worker-backend for parallel execution
    const [idA, idB] = await Promise.all([
      createAndWaitForResult(page),
      createAndWaitForResult(page),
    ]);

    // Navigate to results list
    await page.goto('/results');
    await page.waitForLoadState('networkidle');

    // Scope to main content — avoids matching links in the ActiveTests header strip
    const main = page.locator('main');

    // Both tests should appear in the results table
    await expect(main.locator(`a[href="/results/${idA}"]`).first()).toBeVisible({ timeout: 15_000 });
    await expect(main.locator(`a[href="/results/${idB}"]`).first()).toBeVisible({ timeout: 5_000 });

    // Select both via checkboxes (table row containing the testId link)
    const rowA = main.locator(`tr:has(a[href="/results/${idA}"])`).first();
    const rowB = main.locator(`tr:has(a[href="/results/${idB}"])`).first();

    await rowA.locator('input[type="checkbox"]').click();
    await rowB.locator('input[type="checkbox"]').click();

    // Compare button should appear
    const compareBtn = page.getByRole('button', { name: /compare selected/i });
    await expect(compareBtn).toBeVisible({ timeout: 5_000 });
    await compareBtn.click();

    // Should navigate to compare page with both IDs
    await expect(page).toHaveURL(/\/results\/compare\?a=.+&b=.+/, { timeout: 10_000 });

    // The compare page should show metrics for both results
    await expect(page.getByText(/result a/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/result b/i)).toBeVisible({ timeout: 5_000 });
  });
});
