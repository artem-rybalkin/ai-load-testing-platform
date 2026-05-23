import { test, expect } from '@playwright/test';

/**
 * Navigation smoke tests: verify all main pages render without errors.
 * Requires: docker compose up.
 */
test.describe('Page navigation', () => {
  const pages = [
    { path: '/',           name: 'Home / New Test' },
    { path: '/results',    name: 'Results list' },
    { path: '/schedules',  name: 'Schedules' },
    { path: '/templates',  name: 'Templates' },
    { path: '/webhooks',   name: 'Webhooks' },
  ];

  for (const { path, name } of pages) {
    test(`${name} page renders without JS errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', err => errors.push(err.message));

      await page.goto(path);
      await page.waitForLoadState('networkidle');

      // No uncaught JS errors
      expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0);

      // Page has content
      const bodyText = await page.locator('body').textContent();
      expect(bodyText!.length).toBeGreaterThan(10);
    });
  }

  test('sidebar navigation links work', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Click Results in sidebar
    await page.getByRole('link', { name: /results/i }).first().click();
    await expect(page).toHaveURL('/results', { timeout: 5_000 });

    // Click Schedules
    await page.getByRole('link', { name: /schedules/i }).first().click();
    await expect(page).toHaveURL('/schedules', { timeout: 5_000 });
  });

  test('no error banners shown when all services are up', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // The amber system health error strip (issues detected) should NOT be visible
    // WorkerHealth strip (compact resource bars) is fine and may be shown
    await expect(page.getByText(/system issues detected/i)).not.toBeVisible();
  });
});
