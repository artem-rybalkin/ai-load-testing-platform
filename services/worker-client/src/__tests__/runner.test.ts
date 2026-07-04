/**
 * Unit tests for worker-client runClientTest orchestration (H3).
 * Puppeteer and Lighthouse are injected via ClientRunnerContext overrides —
 * no real browser is launched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Browser } from 'puppeteer';
import type { TestRequest, ResourceBreakdown } from '@alt/shared';
import { runClientTest } from '../runner';

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
} = {}) {
  const initialPages = opts.initialPages ?? [];
  const wsEndpoint = opts.wsEndpoint ?? 'ws://127.0.0.1:9222/devtools/browser/test-uuid';
  const makeNewPage = typeof opts.newPageResult === 'function'
    ? opts.newPageResult
    : () => opts.newPageResult ?? makeMockPage();

  const newPageMock = vi.fn().mockImplementation(makeNewPage);

  return {
    wsEndpoint: vi.fn().mockReturnValue(wsEndpoint),
    pages:      vi.fn().mockResolvedValue(initialPages),
    close:      vi.fn().mockResolvedValue(undefined),
    on:         vi.fn(),
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

  it('always closes the browser in the finally block', async () => {
    const { ctx, browser } = makeCtx();
    await runClientTest(BASE_TEST, ctx);
    expect(browser.close).toHaveBeenCalled();
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

  it('still closes the browser on error', async () => {
    const page = makeMockPage({ gotoError: new Error('page crash') });
    const browser = makeMockBrowser({ newPageResult: page });
    const { ctx } = makeCtx({ browser });

    await runClientTest(BASE_TEST, ctx).catch(() => {});
    expect(browser.close).toHaveBeenCalled();
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
