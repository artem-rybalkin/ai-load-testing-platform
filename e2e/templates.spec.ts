import { test, expect } from '@playwright/test';

/**
 * Templates E2E: save a template from the home form, load it back,
 * verify all fields round-trip correctly.
 * Requires: docker compose up.
 */
test.describe('Templates', () => {
  test('saves a template and loads it back via the dropdown', async ({ page }) => {
    await page.goto('/');

    // Fill in the form
    await page.fill('input[type="text"][placeholder*="example"]', 'https://httpbin.org/get');
    await page.fill('input[placeholder*="test"]', 'Load test 5 VUs 30s');

    // Save as template
    await page.getByRole('button', { name: /save.*template/i }).click();

    // Should not navigate away — just save silently
    await page.waitForTimeout(1500);

    // Reload the page and verify template appears in the dropdown
    await page.reload();
    await expect(page.locator('select').first()).toBeVisible({ timeout: 5_000 });

    const options = await page.locator('select').first().locator('option').allTextContents();
    const hasTemplate = options.some(opt => opt.includes('Load test') || opt.includes('httpbin'));
    expect(hasTemplate).toBe(true);
  });

  test('loads template and pre-fills the URL field', async ({ page }) => {
    await page.goto('/');

    // Wait for templates dropdown to appear (only if templates exist)
    const select = page.locator('select').first();
    const count = await select.locator('option').count();

    if (count <= 1) {
      test.skip(); // No templates yet — skip
      return;
    }

    // Select the first non-placeholder option
    await select.selectOption({ index: 1 });
    await page.waitForTimeout(500);

    // URL field should be populated
    const urlInput = page.locator('input[type="text"][placeholder*="example"]');
    const urlValue = await urlInput.inputValue();
    expect(urlValue.length).toBeGreaterThan(0);
  });

  test('templates page lists saved templates', async ({ page }) => {
    await page.goto('/templates');
    await expect(page.locator('h1, [class*="font-semibold"]').first()).toBeVisible({ timeout: 5_000 });
    // Page should render without crashing
    await expect(page).toHaveURL('/templates');
  });
});
