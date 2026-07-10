/**
 * Unit tests for worker-client runClientTest orchestration (H3).
 * Puppeteer and Lighthouse are injected via ClientRunnerContext overrides —
 * no real browser is launched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Browser } from 'puppeteer';
import type { TestRequest, ResourceBreakdown } from '@alt/shared';
import { runClientTest } from '../runner';
import { createBrowserPool } from '../browserPool';
import { log } from '../logger';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../logger', () => ({
  log: {
    child: vi.fn().mockReturnValue({
      info:  vi.fn(),
      warn:  vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// The vi.mock(...) factory above only runs once — with the project's global
// mockReset: true, every mock's implementation (including log.child's
// .mockReturnValue()) is cleared before each test, so it must be
// re-established here rather than relying on the one-time factory setup.
beforeEach(() => {
  vi.mocked(log.child).mockReturnValue({
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as ReturnType<typeof log.child>);
});

vi.mock('@alt/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alt/shared')>();
  return {
    ...actual,
    stripAnsi: (s: string) => s,
    internalHeaders: vi.fn(() => ({ 'Content-Type': 'application/json' })),
  };
});

// ─── Test builders ────────────────────────────────────────────────────────────

const BASE_TEST: TestRequest = {
  id: 'test-id-1',
  type: 'client-side',
  targetUrl: 'http://example.com',
  description: 'browser test',
  options: { sessions: 1, duration: '30s', collectWebVitals: true },
  createdAt: new Date().toISOString(),
};

const EMPTY_BREAKDOWN: ResourceBreakdown = {
  jsSize: 0, cssSize: 0, imageSize: 0, fontSize: 0,
  xhrSize: 0, totalSize: 0, requestCount: 0,
};

function makeWebVitals(overrides: Partial<{ lcp: number; fid: number; cls: number; fcp: number; inp: number; longTaskCount: number }> = {}) {
  return { lcp: 1200, fid: 0, cls: 0.01, fcp: 800, inp: 0, longTaskCount: 0, ...overrides };
}

function makeMockPage(overrides: {
  ttfb?: number;
  webVitals?: ReturnType<typeof makeWebVitals>;
  breakdown?: ResourceBreakdown;
  gotoError?: Error;
} = {}) {
  const { ttfb = 120, webVitals = makeWebVitals(), breakdown = EMPTY_BREAKDOWN } = overrides;
  const evaluateMock = overrides.gotoError
    ? vi.fn()
    : vi.fn()
        .mockResolvedValueOnce(ttfb)
        .mockResolvedValueOnce(webVitals)
        .mockResolvedValueOnce(breakdown);
  return {
    on:                    vi.fn(),
    close:                 vi.fn().mockResolvedValue(undefined),
    createCDPSession:      vi.fn().mockResolvedValue({ send: vi.fn().mockResolvedValue(undefined) }),
    setExtraHTTPHeaders:   vi.fn().mockResolvedValue(undefined),
    goto:                  overrides.gotoError
      ? vi.fn().mockRejectedValue(overrides.gotoError)
      : vi.fn().mockResolvedValue(undefined),
    evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
    evaluate:              evaluateMock,
  };
}

function makeMockBrowser(opts: {
  initialPages?: ReturnType<typeof makeMockPage>[];
  newPageResult?: ReturnType<typeof makeMockPage> | (() => ReturnType<typeof makeMockPage>);
  wsEndpoint?: string;
  connected?: boolean;
} = {}) {
  const initialPages = opts.initialPages ?? [];
  const wsEndpoint = opts.wsEndpoint ?? 'ws://127.0.0.1:9222/devtools/browser/test-uuid';
  const makeNewPage = typeof opts.newPageResult === 'function'
    ? opts.newPageResult
    : () => opts.newPageResult ?? makeMockPage();

  const newPageMock = vi.fn().mockImplementation(makeNewPage);

  return {
    wsEndpoint:         vi.fn().mockReturnValue(wsEndpoint),
    pages:              vi.fn().mockResolvedValue(initialPages),
    close:              vi.fn().mockResolvedValue(undefined),
    removeAllListeners: vi.fn(),
    connected:          opts.connected ?? true,
    on:                 vi.fn(),
    newPage:    newPageMock,
  };
}

function makeLighthouseMock(overrides: {
  performance?: number;
  accessibility?: number;
  bestPractices?: number;
  seo?: number;
  tbt?: number;
  inp?: number;
  tti?: number;
  domSize?: number;
} = {}) {
  const {
    performance = 85, accessibility = 95, bestPractices = 90, seo = 92,
    tbt = 150, inp = 200, tti = 3200, domSize = 1200,
  } = overrides;
  return vi.fn().mockResolvedValue({
    lhr: {
      categories: {
        performance:     { score: performance / 100 },
        accessibility:   { score: accessibility / 100 },
        'best-practices': { score: bestPractices / 100 },
        seo:             { score: seo / 100 },
      },
      audits: {
        'total-blocking-time':      { numericValue: tbt },
        'interaction-to-next-paint': { numericValue: inp },
        interactive:                { numericValue: tti },
        'dom-size':                 { numericValue: domSize },
      },
    },
  });
}

function makeCtx(overrides: {
  browser?: ReturnType<typeof makeMockBrowser>;
  lighthouse?: ReturnType<typeof makeLighthouseMock>;
  maxDurationMs?: number;
  navTimeoutMs?: number;
  runningBrowsers?: Map<string, Browser>;
} = {}) {
  const runningBrowsers = overrides.runningBrowsers ?? new Map<string, Browser>();
  const browser = overrides.browser ?? makeMockBrowser({ newPageResult: makeMockPage() });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  return {
    ctx: {
      maxDurationMs:  overrides.maxDurationMs ?? 300_000,
      navTimeoutMs:   overrides.navTimeoutMs ?? 60_000,
      resultsUrl:     'http://results-service:3004',
      runningBrowsers,
      postLogLines:   vi.fn().mockResolvedValue(undefined),
      launchBrowser:  vi.fn().mockResolvedValue(browser) as unknown as typeof import('puppeteer').default.launch,
      runLighthouse:  (overrides.lighthouse ?? makeLighthouseMock()) as unknown as typeof import('lighthouse').default,
    },
    browser,
    runningBrowsers,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runClientTest — basic session flow', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('launches a browser and returns client metrics', async () => {
    const { ctx } = makeCtx();
    const result = await runClientTest(BASE_TEST, ctx);

    expect(result.metrics.type).toBe('client');
    expect(result.metrics.lcp).toBe(1200);
    expect(result.metrics.fcp).toBe(800);
    expect(result.metrics.ttfb).toBe(120);
    expect(result.metrics.cls).toBeCloseTo(0.01, 4);
  });

  it('includes an executionLog string', async () => {
    const { ctx } = makeCtx();
    const result = await runClientTest(BASE_TEST, ctx);
    expect(typeof result.executionLog).toBe('string');
    expect(result.executionLog).toContain('Starting browser test');
  });

  it('uses the launchBrowser override instead of real puppeteer', async () => {
    const { ctx } = makeCtx();
    await runClientTest(BASE_TEST, ctx);
    expect(ctx.launchBrowser).toHaveBeenCalledOnce();
  });

  it('calls page.goto with the test targetUrl', async () => {
    const page = makeMockPage();
    const browser = makeMockBrowser({ newPageResult: page });
    const { ctx } = makeCtx({ browser });
    await runClientTest(BASE_TEST, ctx);
    expect(page.goto).toHaveBeenCalledWith(BASE_TEST.targetUrl, expect.objectContaining({ waitUntil: 'networkidle2' }));
  });

  it('closes the page after each session', async () => {
    const page = makeMockPage();
    const browser = makeMockBrowser({ newPageResult: page });
    const { ctx } = makeCtx({ browser });
    await runClientTest(BASE_TEST, ctx);
    expect(page.close).toHaveBeenCalled();
  });

  it('does not close a still-connected browser — returns it to the pool for reuse', async () => {
    const { ctx, browser } = makeCtx();
    await runClientTest(BASE_TEST, ctx);
    expect(browser.close).not.toHaveBeenCalled();
    expect(browser.removeAllListeners).toHaveBeenCalledWith('targetcreated');
  });

  it('reuses the same browser instance across two runClientTest calls sharing a pool', async () => {
    const browser = makeMockBrowser({ newPageResult: () => makeMockPage() });
    const launchBrowser = vi.fn().mockResolvedValue(browser);
    const browserPool = createBrowserPool(launchBrowser as unknown as typeof import('puppeteer').default.launch);
    const { ctx: ctx1 } = makeCtx({ browser });
    const { ctx: ctx2 } = makeCtx({ browser });

    await runClientTest(BASE_TEST, { ...ctx1, browserPool });
    await runClientTest({ ...BASE_TEST, id: 'test-id-2' }, { ...ctx2, browserPool });

    expect(launchBrowser).toHaveBeenCalledOnce();
    expect(browser.close).not.toHaveBeenCalled();
  });

  it('does not attempt to re-pool a browser that disconnected during the test (e.g. killed by cancel/timeout)', async () => {
    const browser = makeMockBrowser({ newPageResult: makeMockPage() });
    const launchBrowser = vi.fn().mockResolvedValue(browser);
    const browserPool = createBrowserPool(launchBrowser as unknown as typeof import('puppeteer').default.launch);
    const { ctx } = makeCtx({ browser });

    // Simulate the browser dying partway through (cancel/max-duration kill it directly).
    (browser as unknown as { connected: boolean }).connected = false;

    await runClientTest(BASE_TEST, { ...ctx, browserPool });

    // A disconnected browser is never re-pooled: the next acquire() must launch fresh.
    await browserPool.acquire();
    expect(launchBrowser).toHaveBeenCalledTimes(2);
  });

  it('defaults sessions to 1 when options.sessions is not set', async () => {
    const { ctx, browser } = makeCtx();
    // cast needed: ClientTestOptions requires sessions, but the runtime defaults to 1 if missing
    const test = { ...BASE_TEST, options: { duration: '30s', collectWebVitals: true } as unknown as TestRequest['options'] };
    await runClientTest(test, ctx);
    expect(browser.newPage).toHaveBeenCalledTimes(1);
  });
});

describe('runClientTest — multiple sessions', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('runs multiple sessions and averages metrics', async () => {
    const page1 = makeMockPage({ ttfb: 100, webVitals: makeWebVitals({ lcp: 1000 }) });
    const page2 = makeMockPage({ ttfb: 200, webVitals: makeWebVitals({ lcp: 2000 }) });
    let callCount = 0;
    const browser = makeMockBrowser({
      newPageResult: () => callCount++ === 0 ? page1 : page2,
    });
    const { ctx } = makeCtx({ browser });
    const test = { ...BASE_TEST, options: { sessions: 2, duration: '30s', collectWebVitals: true } as TestRequest['options'] };

    const result = await runClientTest(test, ctx);

    expect(browser.newPage).toHaveBeenCalledTimes(2);
    expect(result.metrics.lcp).toBe(1500); // (1000 + 2000) / 2
    expect(result.metrics.ttfb).toBe(150); // (100 + 200) / 2
  });

  it('one failed session does not abort the rest — returns metrics averaged over the survivors', async () => {
    const failingPage = makeMockPage({ gotoError: new Error('transient navigation timeout') });
    const page2 = makeMockPage({ ttfb: 100, webVitals: makeWebVitals({ lcp: 1000 }) });
    const page3 = makeMockPage({ ttfb: 300, webVitals: makeWebVitals({ lcp: 3000 }) });
    let callCount = 0;
    const pagesInOrder = [failingPage, page2, page3];
    const browser = makeMockBrowser({
      newPageResult: () => pagesInOrder[callCount++],
    });
    const { ctx } = makeCtx({ browser });
    const test = { ...BASE_TEST, options: { sessions: 3, duration: '30s', collectWebVitals: true } as TestRequest['options'] };

    const result = await runClientTest(test, ctx);

    expect(browser.newPage).toHaveBeenCalledTimes(3);
    // Failed session's page is still closed (cleanup happens regardless of outcome).
    expect(failingPage.close).toHaveBeenCalled();
    // Averaged over only the 2 surviving sessions, not all 3.
    expect(result.metrics.lcp).toBe(2000); // (1000 + 3000) / 2
    expect(result.metrics.ttfb).toBe(200); // (100 + 300) / 2
    expect(result.executionLog).toContain('Failed (skipped)');
  });

  it('throws if every session fails — nothing usable to report', async () => {
    const page = makeMockPage({ gotoError: new Error('connection refused') });
    const browser = makeMockBrowser({ newPageResult: page });
    const { ctx } = makeCtx({ browser });
    const test = { ...BASE_TEST, options: { sessions: 2, duration: '30s', collectWebVitals: true } as TestRequest['options'] };

    const err = await runClientTest(test, ctx).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('All 2 session(s) failed');
  });
});

describe('runClientTest — Lighthouse integration', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('includes lighthouse scores in the returned metrics', async () => {
    const lh = makeLighthouseMock({ performance: 90, tbt: 100, inp: 180 });
    const { ctx } = makeCtx({ lighthouse: lh });
    const result = await runClientTest(BASE_TEST, ctx);

    expect(result.metrics.lighthouseScore?.performance).toBe(90);
    expect(result.metrics.tbt).toBe(100);
    expect(result.metrics.tti).toBe(3200);
    expect(result.metrics.domNodeCount).toBe(1200);
  });

  it('prefers Lighthouse INP over PerformanceObserver INP', async () => {
    const page = makeMockPage({ webVitals: makeWebVitals({ inp: 500 }) });
    const browser = makeMockBrowser({ newPageResult: page });
    const lh = makeLighthouseMock({ inp: 150 });
    const { ctx } = makeCtx({ browser, lighthouse: lh });
    const result = await runClientTest(BASE_TEST, ctx);

    // Lighthouse INP (150) wins over PerformanceObserver (500)
    expect(result.metrics.inp).toBe(150);
  });

  it('falls back to PerformanceObserver INP when Lighthouse has no INP audit', async () => {
    const page = makeMockPage({ webVitals: makeWebVitals({ inp: 250 }) });
    const browser = makeMockBrowser({ newPageResult: page });
    const lh = vi.fn().mockResolvedValue({
      lhr: {
        categories: { performance: { score: 0.85 }, accessibility: { score: 0.95 }, 'best-practices': { score: 0.90 }, seo: { score: 0.92 } },
        audits: { 'total-blocking-time': { numericValue: 100 } }, // no INP audit
      },
    });
    const { ctx } = makeCtx({ browser, lighthouse: lh as unknown as ReturnType<typeof makeLighthouseMock> });
    const result = await runClientTest(BASE_TEST, ctx);

    expect(result.metrics.inp).toBe(250);
  });

  it('is non-fatal when Lighthouse throws — session metrics still returned', async () => {
    const lh = vi.fn().mockRejectedValue(new Error('chrome crashed'));
    const { ctx } = makeCtx({ lighthouse: lh as unknown as ReturnType<typeof makeLighthouseMock> });
    const result = await runClientTest(BASE_TEST, ctx);

    expect(result.metrics.type).toBe('client');
    expect(result.metrics.lighthouseScore).toBeUndefined();
    expect(result.executionLog).toContain('Lighthouse audit failed');
  });

  it('calls runLighthouse with the correct port from wsEndpoint', async () => {
    const lh = makeLighthouseMock();
    const browser = makeMockBrowser({
      newPageResult: makeMockPage(),
      wsEndpoint: 'ws://127.0.0.1:9222/devtools/browser/test-uuid',
    });
    const { ctx } = makeCtx({ browser, lighthouse: lh });
    await runClientTest(BASE_TEST, ctx);

    expect(lh).toHaveBeenCalledWith(
      BASE_TEST.targetUrl,
      expect.objectContaining({ port: 9222 }),
    );
  });

  it('runs Lighthouse with desktop emulation, not the mobile/4G default', async () => {
    const lh = makeLighthouseMock();
    const { ctx } = makeCtx({ lighthouse: lh });
    await runClientTest(BASE_TEST, ctx);

    expect(lh).toHaveBeenCalledWith(
      BASE_TEST.targetUrl,
      expect.objectContaining({
        formFactor: 'desktop',
        screenEmulation: expect.objectContaining({ mobile: false }),
        throttling: expect.objectContaining({ cpuSlowdownMultiplier: 1 }),
      }),
    );
  });
});

describe('runClientTest — runningBrowsers tracking', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('adds the browser to runningBrowsers while the test runs', async () => {
    const runningBrowsers = new Map<string, Browser>();
    let capturedDuringRun = false;

    // Page that checks the map before closing
    const page = {
      ...makeMockPage(),
      close: vi.fn().mockImplementation(async () => {
        capturedDuringRun = runningBrowsers.has(BASE_TEST.id);
      }),
    };
    const browser = makeMockBrowser({ newPageResult: page });
    const { ctx } = makeCtx({ browser, runningBrowsers });
    await runClientTest(BASE_TEST, ctx);

    expect(capturedDuringRun).toBe(true);
  });

  it('removes the browser from runningBrowsers after completion', async () => {
    const runningBrowsers = new Map<string, Browser>();
    const { ctx } = makeCtx({ runningBrowsers });
    await runClientTest(BASE_TEST, ctx);
    expect(runningBrowsers.has(BASE_TEST.id)).toBe(false);
  });
});

describe('runClientTest — error handling', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('attaches partialLog to the thrown error when a session fails', async () => {
    const page = makeMockPage({ gotoError: new Error('navigation timeout') });
    const browser = makeMockBrowser({ newPageResult: page });
    const { ctx } = makeCtx({ browser });

    const err = await runClientTest(BASE_TEST, ctx).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { partialLog?: string }).partialLog).toContain('Starting browser test');
  });

  it('still deletes browser from runningBrowsers on error', async () => {
    const runningBrowsers = new Map<string, Browser>();
    const page = makeMockPage({ gotoError: new Error('connection refused') });
    const browser = makeMockBrowser({ newPageResult: page });
    const { ctx } = makeCtx({ browser, runningBrowsers });

    await runClientTest(BASE_TEST, ctx).catch(() => {});
    expect(runningBrowsers.has(BASE_TEST.id)).toBe(false);
  });

  it('still releases the browser (back to the pool, not closed) on a page-level error', async () => {
    const page = makeMockPage({ gotoError: new Error('page crash') });
    const browser = makeMockBrowser({ newPageResult: page });
    const { ctx } = makeCtx({ browser });

    await runClientTest(BASE_TEST, ctx).catch(() => {});
    // A page-level failure (nav timeout, target crash) doesn't mean the whole
    // browser process is unhealthy — release() still reclaims it for reuse.
    expect(browser.close).not.toHaveBeenCalled();
    expect(browser.removeAllListeners).toHaveBeenCalledWith('targetcreated');
  });
});

describe('runClientTest — custom headers', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('calls setExtraHTTPHeaders when options.headers is set', async () => {
    const page = makeMockPage();
    const browser = makeMockBrowser({ newPageResult: page });
    const { ctx } = makeCtx({ browser });
    const test = {
      ...BASE_TEST,
      options: { sessions: 1, duration: '30s', collectWebVitals: true, headers: { 'X-Auth': 'token123' } } as TestRequest['options'],
    };
    await runClientTest(test, ctx);
    expect(page.setExtraHTTPHeaders).toHaveBeenCalledWith({ 'X-Auth': 'token123' });
  });

  it('does not call setExtraHTTPHeaders when no headers provided', async () => {
    const page = makeMockPage();
    const browser = makeMockBrowser({ newPageResult: page });
    const { ctx } = makeCtx({ browser });
    await runClientTest(BASE_TEST, ctx);
    expect(page.setExtraHTTPHeaders).not.toHaveBeenCalled();
  });
});

describe('runClientTest — execution log', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('postLogLines is called with a batch of { level, line } entries', async () => {
    const { ctx } = makeCtx();
    await runClientTest(BASE_TEST, ctx);
    expect(ctx.postLogLines).toHaveBeenCalled();
    const firstCall = (ctx.postLogLines as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstCall[0]).toBe(BASE_TEST.id); // testId
    const batch = firstCall[1] as Array<{ level: string; line: string }>;
    expect(Array.isArray(batch)).toBe(true);
    expect(batch.length).toBeGreaterThan(0);
    expect(typeof batch[0].level).toBe('string');
    expect(typeof batch[0].line).toBe('string');
  });

  it('executionLog contains session completion message', async () => {
    const { ctx } = makeCtx();
    const result = await runClientTest(BASE_TEST, ctx);
    expect(result.executionLog).toContain('Complete');
  });
});

// ─── Regression: bug #1 ───────────────────────────────────────────────────────
// LCP/FCP/CLS/TTFB report `0` instead of `undefined` when PerformanceObserver
// callbacks never fire (e.g. non-paintable or redirected responses).
// runner.ts initialises lcp/fcp/cls/fcp to 0 inside the page.evaluate closure
// and never reassigns them when the PerformanceObserver callbacks don't fire
// within the 3 s window. Unlike jsErrors / longTaskCount (runner.ts:314-315)
// which correctly coalesce to `undefined` when absent, these become real zeros.
// Expected fix: treat a 0 value for these metrics the same way jsErrors/
// longTaskCount are treated — coalesce to undefined.
describe('runClientTest — web-vitals zero-to-undefined (bug #1 regression)', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it(
    'lcp/fcp/cls should be undefined — not 0 — when PerformanceObserver callbacks never fire',
    async () => {
      // Simulate a non-paintable response: the PerformanceObserver callbacks for
      // LCP, FCP, and CLS never fire, so page.evaluate resolves with the initial
      // zero values after the 3 s timeout.  TTFB nav-timing also returns 0 (no
      // navigation entry, e.g. a redirect or data: URL).
      const page = makeMockPage({
        ttfb: 0,
        webVitals: makeWebVitals({ lcp: 0, fcp: 0, cls: 0 }),
      });
      const browser = makeMockBrowser({ newPageResult: page });
      // Lighthouse is non-fatal; its absence keeps the test focused on Web Vitals.
      const lh = vi.fn().mockRejectedValue(new Error('no chrome debug port'));
      const { ctx } = makeCtx({
        browser,
        lighthouse: lh as unknown as ReturnType<typeof makeLighthouseMock>,
      });

      const result = await runClientTest(BASE_TEST, ctx);

      // "Never fired" metrics → undefined, not 0 (fixed 2026-07-06).
      expect(result.metrics.lcp).toBeUndefined();
      expect(result.metrics.fcp).toBeUndefined();
      expect(result.metrics.cls).toBeUndefined();
    },
  );
});

// ─── Regression: bug #3 ───────────────────────────────────────────────────────
// A max-duration kill mid-Lighthouse-audit is reported as a normal "completed"
// result.  When the kill timer fires during runLighthouse(), Lighthouse's own
// try/catch (runner.ts:293-296) swallows the error and logs it as "non-fatal",
// allowing runClientTest to return normally with status:'completed'.  The
// identical timer firing during the sessions loop correctly propagates as a hard
// failure.  Expected fix: after the Lighthouse catch block, detect that the kill
// timer already fired (or that the browser is no longer connected) and re-throw.
describe('runClientTest — max-duration kill during Lighthouse (bug #3 regression)', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it(
    'runClientTest should reject when the kill timer fires mid-Lighthouse-audit',
    async () => {
      // Wire browser.close() (triggered by the kill timer) → lighthouse rejection,
      // simulating what happens in production when Chrome closes under Lighthouse.
      let rejectLighthouse: ((err: Error) => void) | undefined;
      const lh = vi.fn().mockImplementation(
        () => new Promise<never>((_, reject) => { rejectLighthouse = reject; }),
      );

      const browser = makeMockBrowser({ newPageResult: makeMockPage() });
      // Override close: when the kill timer calls browser.close(), relay the
      // disconnect to the hanging Lighthouse promise (mirrors real Chrome behaviour).
      browser.close.mockImplementation(async () => {
        rejectLighthouse?.(new Error('Protocol error: Connection closed. Target closed.'));
      });

      const { ctx } = makeCtx({
        browser: browser as unknown as ReturnType<typeof makeMockBrowser>,
        lighthouse: lh as unknown as ReturnType<typeof makeLighthouseMock>,
        // Very short — will fire after the synchronous mock sessions complete
        // but while the hanging runLighthouse() promise is still pending.
        maxDurationMs: 50,
      });

      // Desired: runClientTest should reject because the kill timer fired.
      // Currently it resolves normally (Lighthouse error swallowed as non-fatal)
      // → assertion fails → it.fails passes (bug confirmed).
      await expect(runClientTest(BASE_TEST, ctx)).rejects.toThrow();
    },
  );
});
