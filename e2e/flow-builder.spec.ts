import { test, expect } from '@playwright/test';

/**
 * Flow Builder journey: build a multi-step flow by hand, manage steps,
 * extract-variable rules, and the ignore-list — all pure client-side
 * interactions that don't require the recorder-service's live browser.
 * Requires: docker compose up.
 */
test.describe('Flow Builder', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /multi-step flow/i }).click();
  });

  test('adds, edits, reorders, and removes steps', async ({ page }) => {
    const addStep = page.getByRole('button', { name: /\+ add step/i });

    // Two fresh steps
    await addStep.click();
    await addStep.click();
    await expect(page.locator('input[placeholder="Step name (e.g. Login)"]')).toHaveCount(2);

    // Fill in step 1
    const names = page.locator('input[placeholder="Step name (e.g. Login)"]');
    const urls  = page.locator('input[placeholder="https://api.example.com/endpoint"]');
    await names.nth(0).fill('Login');
    await urls.nth(0).fill('https://api.example.com/login');
    await names.nth(1).fill('Get profile');
    await urls.nth(1).fill('https://api.example.com/profile');

    // Reorder: move step 2 up — it should now be first
    await page.locator('button:has-text("↑")').first().click();
    await expect(names.nth(0)).toHaveValue('Get profile');
    await expect(names.nth(1)).toHaveValue('Login');

    // Remove the first step — only "Login" should remain
    await page.locator('button:has-text("✕")').first().click();
    await expect(names).toHaveCount(1);
    await expect(names.first()).toHaveValue('Login');
  });

  test('shows a request body field only for POST/PUT/PATCH methods', async ({ page }) => {
    await page.getByRole('button', { name: /\+ add step/i }).click();

    const bodyField = page.locator('textarea[placeholder*="Request body"]');
    await expect(bodyField).not.toBeVisible();

    await page.locator('select').filter({ hasText: 'GET' }).first().selectOption('POST');
    await expect(bodyField).toBeVisible();

    await bodyField.fill('{"username":"alice"}');
    await expect(bodyField).toHaveValue('{"username":"alice"}');
  });

  test('adds and removes an extract-variable rule', async ({ page }) => {
    await page.getByRole('button', { name: /\+ add step/i }).click();

    // Scope to the step card itself — "+ add" also matches the env-vars and
    // data-table sections' own "+ add"/"+ add row" buttons elsewhere on the page.
    const stepCard = page.locator('div.border.border-gray-200.rounded-xl').filter({ has: page.locator('input[placeholder="Step name (e.g. Login)"]') });
    await stepCard.getByRole('button', { name: '+ add' }).click();
    await expect(page.locator('input[placeholder="varName"]')).toBeVisible();

    await page.locator('input[placeholder="varName"]').fill('authToken');
    await page.locator('select').filter({ hasText: 'body' }).first().selectOption('header');
    await expect(page.locator('input[placeholder="varName"]')).toHaveValue('authToken');

    // Remove the rule
    await page.locator('input[placeholder="varName"]').locator('xpath=../..').locator('button:has-text("✕")').click();
    await expect(page.locator('input[placeholder="varName"]')).not.toBeVisible();
  });

  test('manages the ignore-list (add, remove, clear)', async ({ page }) => {
    await page.getByRole('button', { name: /🚫 ignore/i }).click();

    const ignoreInput = page.locator('input[placeholder*="analytics.google.com"]');
    await expect(ignoreInput).toBeVisible();

    await ignoreInput.fill('analytics.google.com');
    await ignoreInput.press('Enter');
    await expect(page.getByText('analytics.google.com', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: /🚫 ignore \(1\)/i })).toBeVisible();

    await ignoreInput.fill('/hotjar|segment/i');
    await page.getByRole('button', { name: /^add$/i }).click();
    await expect(page.getByRole('button', { name: /🚫 ignore \(2\)/i })).toBeVisible();

    // Clear the whole list
    await page.getByRole('button', { name: /clear all/i }).click();
    await expect(page.getByRole('button', { name: /🚫 ignore$/i })).toBeVisible();
  });

  test('"Clear all" steps prompts for confirmation and empties the list', async ({ page }) => {
    await page.getByRole('button', { name: /\+ add step/i }).click();
    await page.getByRole('button', { name: /\+ add step/i }).click();
    await expect(page.locator('input[placeholder="Step name (e.g. Login)"]')).toHaveCount(2);

    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: /^clear all$/i }).click();

    await expect(page.locator('input[placeholder="Step name (e.g. Login)"]')).toHaveCount(0);
  });

  test('toggles between k6 and Puppeteer Browser flow runners', async ({ page }) => {
    await page.getByRole('button', { name: /\+ add step/i }).click();

    const k6Btn = page.getByRole('button', { name: /⚡ k6 http/i });
    const browserBtn = page.getByRole('button', { name: /🌐 puppeteer browser/i });
    await expect(k6Btn).toBeVisible();
    await expect(browserBtn).toBeVisible();

    await browserBtn.click();
    await expect(page.getByText(/launches a real chromium browser/i)).toBeVisible();

    await k6Btn.click();
    await expect(page.getByText(/launches a real chromium browser/i)).not.toBeVisible();
  });
});
