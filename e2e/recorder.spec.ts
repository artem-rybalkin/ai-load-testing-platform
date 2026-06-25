import { test, expect } from '@playwright/test';

/**
 * Flow recorder journey: launch a real recording session via recorder-service,
 * verify the viewer tab opens with the expected control panel, then stop the
 * recording from both ends (FlowBuilder button and viewer tab) and confirm the
 * session lifecycle completes cleanly.
 *
 * Requires: docker compose up (recorder-service on :3007, noVNC on :6080).
 *
 * Note: this does NOT drive the recorded browser itself — noVNC is a remote
 * framebuffer (canvas), not a DOM Playwright can interact with. These tests
 * verify the orchestration: session creation, viewer UI, polling, and the
 * stop/import lifecycle (with zero captured requests, since nothing is
 * navigated inside the recording browser).
 */
test.describe('Flow Recorder', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /^flow$/i }).click();
  });

  test('starts a recording session and opens the viewer tab', async ({ page, context }) => {
    // Clicking Record launches a Puppeteer session in recorder-service and
    // opens its /viewer/:id control panel in a new tab.
    const [viewerPage] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('button', { name: /🔴 record/i }).click(),
    ]);

    await viewerPage.waitForLoadState();
    await expect(viewerPage).toHaveURL(/\/viewer\/[0-9a-f-]{8}/);
    await expect(viewerPage.getByRole('heading', { name: /recording in progress/i })).toBeVisible();
    await expect(viewerPage.getByText(/requests captured/i)).toBeVisible();
    await expect(viewerPage.getByRole('link', { name: /open browser \(novnc\)/i })).toBeVisible();

    // Back in the FlowBuilder tab, the Record button becomes "Stop Recording (N)"
    await expect(page.getByRole('button', { name: /stop recording/i })).toBeVisible({ timeout: 15_000 });

    await viewerPage.close();
  });

  test('stopping from the FlowBuilder returns to idle once correlation finishes', async ({ page, context }) => {
    const [viewerPage] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('button', { name: /🔴 record/i }).click(),
    ]);
    await viewerPage.waitForLoadState();

    const stopBtn = page.getByRole('button', { name: /stop recording/i });
    await expect(stopBtn).toBeVisible({ timeout: 15_000 });
    await stopBtn.click();

    // While the AI correlation request is in flight, the button shows "Processing…"
    // and a "✕ Skip" escape hatch appears.
    await expect(page.getByRole('button', { name: /processing/i })).toBeVisible({ timeout: 5_000 });

    // Once /recordings/:id/stop resolves, FlowBuilder clears recording state and
    // returns to the idle "🔴 Record" button (no captured requests → no steps imported).
    await expect(stopBtn).not.toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole('button', { name: /🔴 record/i })).toBeVisible();

    await viewerPage.close();
  });

  test('stopping from the viewer tab marks the session as stopped and FlowBuilder syncs via polling', async ({ page, context }) => {
    const [viewerPage] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('button', { name: /🔴 record/i }).click(),
    ]);
    await viewerPage.waitForLoadState();
    await expect(page.getByRole('button', { name: /stop recording/i })).toBeVisible({ timeout: 15_000 });

    // Stop from the viewer's own control panel — this also opens noVNC in a popup,
    // which we let happen but don't interact with.
    await viewerPage.getByRole('button', { name: /stop recording & import steps/i }).click();

    await expect(viewerPage.getByText(/recording stopped/i)).toBeVisible({ timeout: 120_000 });
    await expect(viewerPage.getByRole('button', { name: /done — you can close this tab/i })).toBeVisible();

    // FlowBuilder's poll (or visibilitychange handler) detects 'completed' and
    // resets to the idle Record button.
    await expect(page.getByRole('button', { name: /stop recording/i })).not.toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /🔴 record/i })).toBeVisible();
  });

  test('ignore-list patterns are sent when starting a recording', async ({ page, context }) => {
    // Add an ignore pattern before recording
    await page.getByRole('button', { name: /🚫 ignore/i }).click();
    const ignoreInput = page.locator('input[placeholder*="analytics.google.com"]');
    await ignoreInput.fill('analytics.google.com');
    await ignoreInput.press('Enter');
    await expect(page.getByRole('button', { name: /🚫 ignore \(1\)/i })).toBeVisible();

    const startRequest = page.waitForRequest(req =>
      req.url().includes('/recordings/start') && req.method() === 'POST'
    );

    const [viewerPage] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('button', { name: /🔴 record/i }).click(),
    ]);

    const req = await startRequest;
    const body = req.postDataJSON() as { ignorePatterns?: string[] };
    expect(body.ignorePatterns).toContain('analytics.google.com');

    await viewerPage.waitForLoadState();
    await viewerPage.close();
    await page.getByRole('button', { name: /stop recording/i }).click();
    await expect(page.getByRole('button', { name: /🔴 record/i })).toBeVisible({ timeout: 120_000 });
  });

  test('shows AI ignore-pattern suggestions, duplicate-step warnings, and {{varName}} correlation from a mocked stop result', async ({ page, context }) => {
    // Mocking recorder-service avoids depending on a real recording + Gemini call
    // (correlation/ignore-pattern suggestions consume the 20/day free-tier quota
    // and require a multi-request chain that's impractical to drive via noVNC).
    const sessionId = 'mock-session-1234';
    const stopResult = {
      id: sessionId,
      status: 'completed',
      noVncUrl: 'http://localhost:6080/vnc.html',
      stepCount: 2,
      suggestedIgnore: ['analytics.google.com', '/\\.hot-update\\.json$/'],
      duplicates: [{ indices: [0, 1], suggestion: 'Steps 1 and 2 look like duplicates — consider merging.' }],
      steps: [
        {
          name: 'Login',
          url: 'https://example.com/api/login',
          method: 'POST',
          body: '{"username":"admin"}',
          headers: {},
          extract: { access_token: { source: 'jsonpath', expression: '$.access_token' } },
        },
        {
          name: 'Submit Order',
          url: 'https://example.com/api/orders',
          method: 'POST',
          body: '{"token":"{{access_token}}","item":"sku123"}',
          headers: {},
          extract: {},
        },
      ],
    };

    await context.route('**/recordings/**', async route => {
      const req = route.request();
      const url = req.url();
      if (req.method() === 'POST' && url.endsWith('/recordings/start')) {
        await route.fulfill({ json: { id: sessionId, status: 'active', noVncUrl: stopResult.noVncUrl, stepCount: 0 } });
      } else if (req.method() === 'POST' && url.endsWith('/stop')) {
        await route.fulfill({ json: stopResult });
      } else {
        await route.fulfill({ json: { id: sessionId, status: 'active', noVncUrl: stopResult.noVncUrl, stepCount: 0 } });
      }
    });
    await context.route('**/viewer/**', async route => {
      await route.fulfill({ contentType: 'text/html', body: '<html><body>mock viewer</body></html>' });
    });

    const [viewerPage] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('button', { name: /🔴 record/i }).click(),
    ]);
    await viewerPage.waitForLoadState();

    await expect(page.getByRole('button', { name: /stop recording/i })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: /stop recording/i }).click();

    // AI-suggested ignore patterns panel
    await expect(page.getByText(/suggested ignore patterns for next recording/i)).toBeVisible();
    await expect(page.getByText('analytics.google.com')).toBeVisible();
    await expect(page.getByText('/\\.hot-update\\.json$/')).toBeVisible();

    // Duplicate-step warning panel
    await expect(page.getByText(/duplicate steps detected/i)).toBeVisible();
    await expect(page.getByText(/steps 1 and 2 look like duplicates/i)).toBeVisible();

    // Imported steps — step 1 carries the jsonpath extract rule for access_token
    await expect(page.locator('input[placeholder="https://api.example.com/endpoint"]').nth(0)).toHaveValue(/\/api\/login$/);
    await expect(page.locator('input[placeholder="varName"]').first()).toHaveValue('access_token');
    await expect(page.locator('input[placeholder="$.data.token"]').first()).toHaveValue('$.access_token');

    // Step 2's body references the {{varName}} placeholder produced by correlation
    await expect(page.locator('textarea[placeholder*="Request body"]').nth(1)).toHaveValue(/\{\{access_token\}\}/);

    await viewerPage.close();
  });

  // ── Driving the recorded browser through noVNC ───────────────────────────────
  //
  // This is the only spec in the suite that interacts with the *remote* browser
  // (the one recorder-service launches via Puppeteer + Xvfb), via its noVNC
  // canvas. There is no DOM/accessibility tree for that browser — only pixels —
  // so we avoid coordinate-dependent clicks (e.g. "click the address bar at
  // x,y") by using the Ctrl+L browser-chrome shortcut, which works regardless
  // of where the toolbar is rendered or how noVNC scales the canvas.
  //
  // This test is inherently more fragile/slow than the others (real browser
  // launch + VNC handshake + frame rendering + remote navigation), hence the
  // generous timeouts and test.slow().
  test('drives the recorded browser via noVNC and captures a real request', async ({ page, context }) => {
    test.slow();

    const [viewerPage] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('button', { name: /🔴 record/i }).click(),
    ]);

    // The viewer's inline script opens noVNC in its own popup as soon as it loads.
    const vncPagePromise = context.waitForEvent('page');
    await viewerPage.waitForLoadState();
    const vncPage = await vncPagePromise;
    await vncPage.waitForLoadState();

    // Wait for the noVNC canvas to be created and the RFB connection to render
    // its first frame (autoconnect=true is set on NOVNC_URL).
    const canvas = vncPage.locator('canvas').first();
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    await vncPage.waitForTimeout(3_000);

    // Click into the remote desktop to give it focus, then jump to the address
    // bar with Ctrl+L (works no matter where the toolbar is on screen) and
    // navigate to a same-network service that returns a small JSON response —
    // captured by recorder-service as a single network request/step.
    await canvas.click({ position: { x: 640, y: 400 } });
    await vncPage.keyboard.press('Control+l');
    await vncPage.waitForTimeout(300);
    await vncPage.keyboard.type('http://api-service:3000/health', { delay: 50 });
    await vncPage.keyboard.press('Enter');

    // The viewer polls /recordings/:id every second and updates the step counter
    // once recorder-service's CDP listener captures the request.
    await expect(viewerPage.getByText(/^[1-9]\d* requests? captured$/)).toBeVisible({ timeout: 30_000 });

    await viewerPage.getByRole('button', { name: /stop recording & import steps/i }).click();
    await expect(viewerPage.getByText(/recording stopped/i)).toBeVisible({ timeout: 120_000 });

    // The captured request should land back in FlowBuilder as a step.
    await expect(page.locator('input[placeholder="https://api.example.com/endpoint"]').first())
      .toHaveValue(/api-service:3000\/health/, { timeout: 15_000 });
  });
});
