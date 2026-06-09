import { test, expect } from '@playwright/test';

/**
 * Result detail journey: create one backend test, wait for it to complete,
 * then exercise the actions that only appear on a completed result —
 * baseline set/clear, PDF report download link, and re-run from the list.
 * Tests run serially and share the same completed result to avoid paying
 * the ~30-300s test-completion cost multiple times.
 * Requires: docker compose up.
 */
test.describe.serial('Result detail — completed test actions', () => {
  let testId: string;

  test('creates a backend test and waits for it to complete', async ({ page }) => {
    await page.goto('/');

    const urlInput = page.locator('input[placeholder*="example"]');
    await urlInput.click();
    await urlInput.fill('http://localhost:3000/health');
    await urlInput.press('Tab');

    const descInput = page.locator('input[placeholder*="test"]');
    await descInput.fill('E2E result-detail test 3 VUs 20s');
    await descInput.press('Tab');

    await page.getByRole('button', { name: /run test/i }).click();

    await expect(page).toHaveURL(/\/results\/[0-9a-f-]{36}/, { timeout: 15_000 });
    testId = page.url().split('/results/')[1];
    expect(testId).toMatch(/^[0-9a-f-]{36}$/);

    await expect(page.getByText(/completed|failed/i).first()).toBeVisible({ timeout: 300_000 });
  });

  test('shows "Set baseline" / "Clear baseline" toggle and persists across reload', async ({ page }) => {
    await page.goto(`/results/${testId}`);
    await page.waitForLoadState('networkidle');

    // Skip gracefully if the run failed — baseline/PDF only render for completed results
    const isCompleted = await page.getByText(/^completed$/i).first().isVisible().catch(() => false);
    test.skip(!isCompleted, 'Test did not complete — baseline/PDF actions are not rendered');

    const setBaselineBtn = page.getByRole('button', { name: /set baseline/i });
    await expect(setBaselineBtn).toBeVisible({ timeout: 10_000 });

    await setBaselineBtn.click();
    await expect(page.getByRole('button', { name: /clear baseline/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('baseline', { exact: true })).toBeVisible();

    // Persists after reload
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('button', { name: /clear baseline/i })).toBeVisible({ timeout: 10_000 });

    // Clean up — clear it again so the badge doesn't linger for other specs
    await page.getByRole('button', { name: /clear baseline/i }).click();
    await expect(page.getByRole('button', { name: /set baseline/i })).toBeVisible({ timeout: 10_000 });
  });

  test('exposes a PDF report download link pointing at the results-service', async ({ page }) => {
    await page.goto(`/results/${testId}`);
    await page.waitForLoadState('networkidle');

    const isCompleted = await page.getByText(/^completed$/i).first().isVisible().catch(() => false);
    test.skip(!isCompleted, 'Test did not complete — PDF link is not rendered');

    const pdfLink = page.getByRole('link', { name: /pdf/i });
    await expect(pdfLink).toBeVisible();
    await expect(pdfLink).toHaveAttribute('href', new RegExp(`/results/${testId}/report\\.pdf$`));
    await expect(pdfLink).toHaveAttribute('target', '_blank');
  });

  test('shows the generated script with a working download button', async ({ page }) => {
    await page.goto(`/results/${testId}`);
    await page.waitForLoadState('networkidle');

    const scriptBlock = page.locator('pre').filter({ hasText: /import|http|export/i }).first();
    if (!(await scriptBlock.isVisible().catch(() => false))) {
      test.skip(true, 'No generated script attached to this result (e.g. reused/cached path)');
    }

    const downloadBtn = page.getByRole('button', { name: /download \.js/i });
    await expect(downloadBtn).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadBtn.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^script-[0-9a-f]{8}\.js$/);
  });

  test('"Re-run" from the results list pre-fills the home form and navigates there', async ({ page }) => {
    await page.goto('/results');
    await page.waitForLoadState('networkidle');

    const row = page.locator(`a[href="/results/${testId}"]`).first();
    await expect(row).toBeVisible({ timeout: 10_000 });

    // The re-run control sits alongside the row — click the first one visible
    const rerunBtn = page.getByRole('link', { name: /re-run/i })
      .or(page.getByRole('button', { name: /re-run/i }))
      .first();

    await rerunBtn.click();
    await expect(page).toHaveURL(new RegExp(`/\\?rerun=${testId}`));

    // Form should be pre-filled with the original target URL
    const urlInput = page.locator('input[placeholder*="example"]');
    await expect(urlInput).toHaveValue(/localhost:3000\/health/, { timeout: 10_000 });
  });
});
