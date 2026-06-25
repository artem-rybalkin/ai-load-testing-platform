import { test, expect, Page } from '@playwright/test';

/**
 * Compare flow: seed two completed results via the API, navigate to the
 * results list, select both, and verify the compare view loads correctly.
 * Requires: docker compose up.
 */

const API_URL = 'http://localhost:3000';
const RESULTS_URL = 'http://localhost:3004';

// Bypasses AI script generation (which fails in CI — no real GEMINI_API_KEY —
// and leaves the result `status: 'failed'`, hiding the compare checkboxes
// that only render for `status === 'completed'`).
const CUSTOM_SCRIPT = `import http from 'k6/http';
import { sleep } from 'k6';

export const options = { vus: 1, duration: '10s' };

export default function () {
  http.get('http://api-service:3000/health');
  sleep(1);
}
`;

async function createAndWaitForResult(page: Page): Promise<string> {
  const res = await page.request.post(`${API_URL}/tests`, {
    data: {
      type: 'backend',
      // Must be reachable from inside the worker-backend container (not "localhost",
      // which resolves to the worker itself, not api-service) so the test completes.
      targetUrl: 'http://api-service:3000/health',
      description: 'compare E2E test',
      options: { vus: 1, duration: '10s' },
      customScript: CUSTOM_SCRIPT,
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

    // Select both via checkboxes — rows are CSS-grid divs (not <tr>), identified
    // by the `cursor-pointer` class unique to data rows (the table wrapper/header
    // above them don't carry it), containing the testId link.
    const rowA = main.locator('div.cursor-pointer').filter({ has: page.locator(`a[href="/results/${idA}"]`) }).first();
    const rowB = main.locator('div.cursor-pointer').filter({ has: page.locator(`a[href="/results/${idB}"]`) }).first();

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
