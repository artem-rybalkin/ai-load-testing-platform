/**
 * Real-browser coverage for the Web Vitals / resource-breakdown logic inside
 * runClientTest's page.evaluate() callbacks (runner.ts:191-266).
 *
 * That logic runs inside Chromium via Puppeteer's page.evaluate() — the
 * function is serialized and executed in the browser process, never in the
 * Node process running Vitest. Mocking page.evaluate() (as runner.test.ts
 * does, for speed) can NEVER exercise those lines: V8's coverage
 * instrumentation only sees code that actually runs in this Node process.
 * The only way to cover this logic at all is a real browser navigating a
 * real page, which is what this file does.
 *
 * Requires a real Chromium — this only runs where PUPPETEER_EXECUTABLE_PATH
 * (or bundled Chromium) is available, e.g. inside the worker-client Docker
 * image. Skipped automatically otherwise.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import puppeteer from 'puppeteer';
import type { TestRequest } from '@alt/shared';
import { runClientTest } from '../runner';
import { createBrowserPool } from '../browserPool';
import { log } from '../logger';

vi.mock('../logger', () => ({
  log: {
    child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  },
}));

// The vi.mock(...) factory above only runs once — with the project's global
// mockReset: true, log.child's .mockReturnValue() is cleared before every
// test, so it must be re-established here (same pattern as runner.test.ts).
beforeEach(() => {
  vi.mocked(log.child).mockReturnValue({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  } as unknown as ReturnType<typeof log.child>);
});

// 1x1 transparent PNG.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const JS_BODY = '/* padding */\n'.repeat(400); // ~5.5KB
const CSS_BODY = '/* padding */\n'.repeat(200); // ~2.7KB
const HTML_BODY = `<!DOCTYPE html>
<html><head><link rel="stylesheet" href="/style.css"></head>
<body><h1>Fixture page for coverage</h1>
<img src="/image.png" width="200" height="200">
<script src="/app.js"></script>
</body></html>`;

const hasRealChromium = !!(process.env['PUPPETEER_EXECUTABLE_PATH'] || process.env['CI_HAS_CHROMIUM']);

describe.skipIf(!hasRealChromium)('runClientTest — real browser (Web Vitals + resource breakdown)', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/style.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); res.end(CSS_BODY); return; }
      if (req.url === '/app.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(JS_BODY); return; }
      if (req.url === '/image.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(TINY_PNG); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(HTML_BODY);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}/`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('collects real Web Vitals and a resource breakdown that classifies JS/CSS/image sizes correctly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    const test: TestRequest = {
      id: 'real-browser-test-1',
      type: 'client-side',
      targetUrl: baseUrl,
      description: 'real browser fixture test',
      options: { sessions: 1, duration: '30s', collectWebVitals: true },
      createdAt: new Date().toISOString(),
    };

    const launchBrowser = puppeteer.launch.bind(puppeteer);
    const { metrics } = await runClientTest(test, {
      maxDurationMs: 30_000,
      navTimeoutMs: 15_000,
      resultsUrl: 'http://unused.invalid',
      runningBrowsers: new Map(),
      postLogLines: vi.fn().mockResolvedValue(undefined),
      launchBrowser,
      browserPool: createBrowserPool(launchBrowser),
      // Skip the real Lighthouse audit — orthogonal to what's being covered
      // here and adds significant runtime; already covered by mocked tests.
      runLighthouse: vi.fn().mockResolvedValue({
        lhr: { categories: {}, audits: {} },
      }) as unknown as typeof import('lighthouse').default,
    });

    // Web Vitals (runner.ts:191-243) — real PerformanceObserver output.
    expect(metrics.fcp).toBeGreaterThan(0);
    expect(metrics.lcp).toBeGreaterThan(0);

    // Resource breakdown (runner.ts:245-266) — real classification by initiatorType.
    const breakdown = metrics.resourceBreakdown;
    expect(breakdown).toBeDefined();
    // style.css + app.js + image.png, plus Chrome's own auto favicon.ico request —
    // >= 3 rather than an exact count since favicon-fetch behavior isn't a
    // contract of this code and shouldn't make the test brittle.
    expect(breakdown!.requestCount).toBeGreaterThanOrEqual(3);
    expect(breakdown!.jsSize).toBeGreaterThan(3);
    expect(breakdown!.jsSize).toBeLessThan(10);
    expect(breakdown!.cssSize).toBeGreaterThan(1);
    expect(breakdown!.cssSize).toBeLessThan(6);
    expect(breakdown!.imageSize).toBeGreaterThan(0);
    expect(breakdown!.xhrSize).toBe(0);
    expect(breakdown!.totalSize).toBeGreaterThanOrEqual(breakdown!.jsSize + breakdown!.cssSize + breakdown!.imageSize);
  }, 60_000);
});
