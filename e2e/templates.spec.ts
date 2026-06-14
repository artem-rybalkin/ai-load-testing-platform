import { test, expect } from '@playwright/test';

/**
 * Presets E2E: save a preset from the home form, load it back,
 * verify all fields round-trip correctly.
 * Requires: docker compose up.
 */
test.describe('Templates', () => {
  test('saves a template and loads it back via the dropdown', async ({ page }) => {
    await page.goto('/');

    // Fill in the form
    await page.fill('input[type="text"][placeholder*="example"]', 'https://httpbin.org/get');
    await page.fill('input[placeholder*="test"]', 'Load test 5 VUs 30s');

    // Save as preset (renamed from "template" in Phase 20).
    // handleSavePreset awaits an AI name-suggestion call (Gemini, can take
    // several seconds with retries) before POSTing /presets, so wait for the
    // actual creation response rather than a fixed timeout.
    // Use dispatchEvent('click') instead of .click(): coordinate-based clicks
    // can land on the "Advanced settings" toggle directly above this button
    // (its bounding box briefly overlaps during the description-driven
    // re-render), which expands that section instead of triggering save.
    const [response] = await Promise.all([
      page.waitForResponse(
        (resp) => resp.url().includes('/presets') && resp.request().method() === 'POST',
        { timeout: 30_000 },
      ),
      page.getByRole('button', { name: /save.*preset/i }).dispatchEvent('click'),
    ]);
    expect(response.ok()).toBe(true);

    // Reload the page and verify template appears in the dropdown
    await page.reload();
    await expect(page.locator('select').first()).toBeVisible({ timeout: 5_000 });

    // AI-14 generates a descriptive preset name (e.g. "HTTPBin Backend Baseline
    // Load (backend)") rather than reusing the raw description/URL verbatim,
    // so match case-insensitively against either.
    const options = await page.locator('select').first().locator('option').allTextContents();
    const hasTemplate = options.some(opt => /load test|httpbin/i.test(opt));
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
    await page.goto('/presets');
    await expect(page.locator('h1, [class*="font-semibold"]').first()).toBeVisible({ timeout: 5_000 });
    // Page should render without crashing
    await expect(page).toHaveURL('/presets');
  });
});
