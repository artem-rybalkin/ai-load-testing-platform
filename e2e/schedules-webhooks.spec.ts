import { test, expect } from '@playwright/test';

/**
 * Admin CRUD journeys: schedules (create, run-now, pause/enable, delete) and
 * webhooks (create, delete). These are pure REST-backed CRUD flows against
 * results-service — no test execution required, so they run fast.
 * Requires: docker compose up.
 */
test.describe('Schedules', () => {
  const name = `E2E schedule ${Date.now()}`;

  test('creates a schedule, runs it, pauses/enables it, then deletes it', async ({ page }) => {
    await page.goto('/schedules');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: /\+ new schedule/i }).click();

    await page.locator('input[placeholder="Hourly smoke test"]').fill(name);
    await page.locator('input[placeholder="0 * * * *"]').fill('0 0 * * *');
    await page.locator('input[placeholder="https://example.com"]').fill('http://localhost:3000/health');

    await page.getByRole('button', { name: /^create schedule$/i }).click();

    // Each schedule row carries the `border-border-3` separator class, which is
    // unique to data rows (the header row above it uses plain `border-border`) —
    // scope to that so it includes both the name and the cron <code>
    // (a plain `div.filter({hasText}).last()` picks an inner wrapper that excludes the buttons).
    const row = page.locator('div.border-border-3').filter({ hasText: name });
    await expect(row.getByText(name)).toBeVisible({ timeout: 10_000 });
    await expect(row.getByText('active')).toBeVisible();
    await expect(row.getByText('backend')).toBeVisible();
    await expect(row.locator('code', { hasText: '0 0 * * *' })).toBeVisible();

    // Run now — fire-and-forget, just confirm no error is thrown
    await row.getByRole('button', { name: /run now/i }).click();

    // Pause → status flips to "paused"
    await row.getByRole('button', { name: /^pause$/i }).click();
    await expect(row.getByText('paused')).toBeVisible({ timeout: 10_000 });

    // Enable → flips back to "active"
    await row.getByRole('button', { name: /^enable$/i }).click();
    await expect(row.getByText('active')).toBeVisible({ timeout: 10_000 });

    // Delete — confirm() dialog must be accepted
    page.once('dialog', dialog => dialog.accept());
    await row.getByRole('button', { name: /^delete$/i }).click();
    await expect(page.getByText(name)).not.toBeVisible({ timeout: 10_000 });
  });

  test('validates required fields before creating a schedule', async ({ page }) => {
    await page.goto('/schedules');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: /\+ new schedule/i }).click();
    await page.getByRole('button', { name: /^create schedule$/i }).click();

    await expect(page.getByText(/name, url and cron are required/i)).toBeVisible();
  });

  test('switching test type to Browser swaps Virtual users for Sessions', async ({ page }) => {
    await page.goto('/schedules');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: /\+ new schedule/i }).click();

    await expect(page.locator('label:has-text("Virtual users")')).toBeVisible();
    await expect(page.locator('label:has-text("Sessions")')).not.toBeVisible();

    await page.locator('select').filter({ has: page.locator('option', { hasText: 'Backend / API' }) }).selectOption('client-side');

    await expect(page.locator('label:has-text("Sessions")')).toBeVisible();
    await expect(page.locator('label:has-text("Virtual users")')).not.toBeVisible();
  });
});

test.describe('Webhooks', () => {
  const url = `https://e2e-webhook-${Date.now()}.example.com/hook`;

  test('requires a URL before saving', async ({ page }) => {
    await page.goto('/webhooks');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: /^add webhook$/i }).click();
    await expect(page.getByText(/url is required/i)).toBeVisible();
  });

  test('creates a webhook with selected trigger events and a format, then removes it', async ({ page }) => {
    await page.goto('/webhooks');
    await page.waitForLoadState('networkidle');

    await page.locator('input[placeholder="https://your-endpoint.example.com/webhook"]').fill(url);

    // "failed" + "degraded" are checked by default — toggle "degraded" off
    const degradedCheckbox = page.locator('label').filter({ hasText: 'degraded' }).locator('input[type="checkbox"]');
    await expect(degradedCheckbox).toBeChecked();
    await degradedCheckbox.uncheck();
    await expect(degradedCheckbox).not.toBeChecked();

    // Pick the Slack format
    await page.locator('label[title*="Slack Incoming Webhooks"]').locator('input[type="radio"]').check();
    await expect(page.getByText(/slack incoming webhooks/i)).toBeVisible();

    await page.getByRole('button', { name: /^add webhook$/i }).click();

    const row = page.locator('p.font-mono', { hasText: url });
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Remove it
    await page.locator('div').filter({ hasText: url }).getByRole('button', { name: /remove/i }).first().click();
    await expect(row).not.toBeVisible({ timeout: 10_000 });
  });
});
