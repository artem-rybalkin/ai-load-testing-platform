/**
 * Pure Puppeteer orchestration logic extracted from index.ts for testability.
 * The AMQP consumer in index.ts calls runClientTest(); tests inject ctx overrides.
 */

declare global {
  interface LayoutShift extends PerformanceEntry {
    value: number;
    hadRecentInput: boolean;
  }

  interface ExtendedPerformanceEventTiming extends PerformanceEventTiming {
    processingStart: number;
  }
}

import puppeteer, { Browser, KnownDevices } from 'puppeteer';
import lighthouse from 'lighthouse';
import { TestRequest, ClientMetrics, LighthouseScore, ResourceBreakdown, stripAnsi, internalHeaders, createBatcher } from '@alt/shared';
import { log } from './logger';
import { createBrowserPool, BrowserPool } from './browserPool';

// Web Vitals without the optional lighthouse field (for per-session accumulation)
type WebVitalsSnapshot = Omit<ClientMetrics, 'type' | 'lighthouseScore'>;

export const avgNum = (
  snapshots: WebVitalsSnapshot[],
  key: 'lcp' | 'fid' | 'cls' | 'ttfb' | 'fcp' | 'inp' | 'longTaskCount'
): number => {
  if (snapshots.length === 0) return 0;
  const sum = snapshots.reduce((s, m) => s + (m[key] ?? 0), 0);
  return Math.round((sum / snapshots.length) * 100) / 100;
};

export const avgResourceBreakdown = (snapshots: WebVitalsSnapshot[]): ResourceBreakdown | undefined => {
  const valid = snapshots.filter(s => s.resourceBreakdown);
  if (!valid.length) return undefined;
  const keys: Array<keyof ResourceBreakdown> = ['jsSize', 'cssSize', 'imageSize', 'fontSize', 'xhrSize', 'totalSize', 'requestCount'];
  const result = {} as ResourceBreakdown;
  for (const k of keys) {
    const sum = valid.reduce((s, m) => s + (m.resourceBreakdown?.[k] ?? 0), 0);
    result[k] = Math.round((sum / valid.length) * 10) / 10;
  }
  return result;
};

export interface ClientRunnerContext {
  maxDurationMs: number;
  navTimeoutMs: number;
  resultsUrl: string;
  runningBrowsers: Map<string, Browser>;
  postLogLines: (testId: string, lines: Array<{ level: string; line: string }>) => Promise<void>;
  /** Override for testing — defaults to puppeteer.launch */
  launchBrowser?: typeof puppeteer.launch;
  /** Override for testing — defaults to lighthouse */
  runLighthouse?: typeof lighthouse;
  /** Shared across invocations in the same worker process so idle browsers get
   *  reused instead of relaunched — pass the same pool instance for every
   *  runClientTest call in a worker. Defaults to a fresh single-use pool
   *  (no reuse) when not provided, e.g. in tests that don't care about it. */
  browserPool?: BrowserPool;
}

const MAX_LOG_LINES = 5000;
const MAX_LOG_BYTES = 100 * 1024;

const NAME_POLYFILL =
  'globalThis.__name = globalThis.__name || ((fn, value) => { try { Object.defineProperty(fn, "name", { value, configurable: true }); } catch { /* ignore */ } return fn; });';

export const runClientTest = async (
  test: TestRequest,
  ctx: ClientRunnerContext,
): Promise<{ metrics: ClientMetrics; executionLog: string }> => {
  const { maxDurationMs, navTimeoutMs, resultsUrl, runningBrowsers, postLogLines } = ctx;
  const launchBrowser = ctx.launchBrowser ?? puppeteer.launch.bind(puppeteer);
  const runLighthouse = ctx.runLighthouse ?? lighthouse;
  const browserPool = ctx.browserPool ?? createBrowserPool(launchBrowser);

  const testLog = log.child({ testId: test.id, targetUrl: test.targetUrl });
  testLog.info('Acquiring browser');

  const postMessage = (message: string): Promise<Response | void> =>
    fetch(`${resultsUrl}/results/${test.id}/message`, {
      method: 'POST',
      headers: internalHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ message }),
    }).catch((err: Error) => testLog.debug({ err: err.message }, 'postMessage delivery failed'));

  const logLines: string[] = [];
  let logBytes = 0;
  const logBatcher = createBatcher<{ level: string; line: string }>(
    batch => { postLogLines(test.id, batch).catch(() => {}); },
  );
  const addLog = (level: string, text: string): void => {
    const clean = stripAnsi(text).trimEnd();
    if (!clean || logLines.length >= MAX_LOG_LINES || logBytes >= MAX_LOG_BYTES) return;
    logLines.push(`[${level}] ${clean}`);
    logBytes += level.length + Buffer.byteLength(clean, 'utf8') + 3;
    logBatcher.push({ level, line: clean });
  };

  addLog('INFO', `Starting browser test: ${test.targetUrl}`);

  let pageLoadCount = 0;

  const browser = await browserPool.acquire();

  runningBrowsers.set(test.id, browser);
  let killTimerFired = false;
  const killTimer = setTimeout(() => {
    void (async (): Promise<void> => {
      killTimerFired = true;
      log.warn({ testId: test.id, maxMs: maxDurationMs }, 'Puppeteer test exceeded max duration, closing browser');
      await browser.close().catch(() => {});
    })();
  }, maxDurationMs);

  browser.on('targetcreated', (target) => {
    void (async (): Promise<void> => {
      const newPage = await (target as { page(): Promise<{ evaluateOnNewDocument(s: string): Promise<void> } | null> })
        .page().catch(() => null);
      if (newPage) await newPage.evaluateOnNewDocument(NAME_POLYFILL).catch(() => {});
    })();
  });
  for (const existingPage of await browser.pages()) {
    await existingPage.evaluateOnNewDocument(NAME_POLYFILL).catch(() => {});
  }

  try {
    const snapshots: WebVitalsSnapshot[] = [];
    const options = test.options as { sessions: number; duration: string; headers?: Record<string, string>; device?: string };
    const sessions = options.sessions || 1;

    let totalJsErrors = 0;
    let sessionsFailed = 0;

    // ── Puppeteer sessions: collect Web Vitals ───────────────────────────────
    // Each session's body is isolated in its own try/catch — a transient failure
    // (e.g. a navigation timeout) in session 3 of 10 used to throw out of the whole
    // loop, discarding sessions 4-10 and whatever 1-2 already collected. Now it's
    // logged and skipped; snapshots/avgNum below already tolerate a shorter array.
    for (let i = 0; i < sessions; i++) {
      testLog.info({ session: i + 1, sessions }, 'Running session');
      await postMessage(`Running browser session ${i + 1} of ${sessions}…`);
      const page = await browser.newPage();
      try {
        addLog('INFO', `[session ${i + 1}/${sessions}] Navigating to ${test.targetUrl}`);

        let sessionJsErrors = 0;
        page.on('pageerror', (err) => {
          sessionJsErrors++;
          addLog('ERROR', `[session ${i + 1}] pageerror: ${err.message}`);
        });
        page.on('console', (msg: { type(): string; text(): string }) => {
          const t = msg.type();
          const level = t === 'error' ? 'ERROR' : t === 'warn' ? 'WARN' : 'DEBUG';
          addLog(level, `[session ${i + 1}] [browser] ${msg.text()}`);
        });

        const cdp = await page.createCDPSession();
        await (cdp as { send(cmd: string): Promise<void> }).send('Performance.enable');

        if (options.headers && Object.keys(options.headers).length > 0) {
          await page.setExtraHTTPHeaders(options.headers);
        }

        // Opt-in mobile emulation (viewport + UA + touch) via Puppeteer's built-in
        // device presets. Unrecognized names are logged and ignored rather than
        // failing the session — matches this codebase's non-fatal-fallback convention.
        // KnownDevices is typed as Readonly<Record<'<a fixed literal union of ~130
        // device names>', Device>> — options.device is a plain string (validated
        // only at runtime, not by TS), so the lookup needs an explicit cast to a
        // generic string-keyed record; the `if (device)` below is the real check.
        if (options.device) {
          const device = (KnownDevices as Record<string, typeof KnownDevices[keyof typeof KnownDevices] | undefined>)[options.device];
          if (device) {
            await page.emulate(device);
          } else {
            addLog('WARN', `[session ${i + 1}/${sessions}] Unknown device "${options.device}" — ignoring, using default desktop viewport`);
          }
        }

        await page.goto(test.targetUrl, { waitUntil: 'networkidle2', timeout: navTimeoutMs });
        pageLoadCount++;

        const ttfb = await page.evaluate(() => {
          const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
          return nav ? Math.round(nav.responseStart - nav.requestStart) : 0;
        });

        const webVitals = await page.evaluate(() => {
          return new Promise<{ lcp: number; fid: number; cls: number; fcp: number; inp: number; longTaskCount: number }>((resolve) => {
            let lcp = 0;
            let fid = 0;
            let cls = 0;
            let fcp = 0;
            let inp = 0;
            let longTaskCount = 0;

            new PerformanceObserver((list) => {
              const entries = list.getEntries();
              lcp = entries[entries.length - 1]!.startTime; // PerformanceObserver only invokes the callback with a non-empty entry list
            }).observe({ type: 'largest-contentful-paint', buffered: true });

            new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                const e = entry as ExtendedPerformanceEventTiming;
                fid = e.processingStart - e.startTime;
              }
            }).observe({ type: 'first-input', buffered: true });

            new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                const e = entry as LayoutShift;
                if (!e.hadRecentInput) cls += e.value;
              }
            }).observe({ type: 'layout-shift', buffered: true });

            new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                if (entry.name === 'first-contentful-paint') fcp = entry.startTime;
              }
            }).observe({ type: 'paint', buffered: true });

            try {
              new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                  const e = entry as ExtendedPerformanceEventTiming;
                  const duration = e.processingStart - e.startTime;
                  if (duration > inp) inp = duration;
                }
              }).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
            } catch { /* event type unsupported */ }

            try {
              new PerformanceObserver((list) => {
                longTaskCount += list.getEntries().length;
              }).observe({ type: 'longtask', buffered: true });
            } catch { /* longtask type unsupported */ }

            setTimeout(() => resolve({ lcp, fid, cls, fcp, inp, longTaskCount }), 3000);
          });
        });

        const resourceBreakdown = await page.evaluate((): ResourceBreakdown => {
          const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
          const bd = { jsSize: 0, cssSize: 0, imageSize: 0, fontSize: 0, xhrSize: 0, totalSize: 0, requestCount: entries.length };
          for (const e of entries) {
            const kb = (e.transferSize || 0) / 1024;
            bd.totalSize += kb;
            if (e.initiatorType === 'script') bd.jsSize += kb;
            else if (e.initiatorType === 'link' || e.initiatorType === 'css') bd.cssSize += kb;
            else if (e.initiatorType === 'img') bd.imageSize += kb;
            else if (e.initiatorType === 'font' || /\.(woff2?|ttf|otf|eot)/i.test(e.name)) bd.fontSize += kb;
            else if (e.initiatorType === 'xmlhttprequest' || e.initiatorType === 'fetch') bd.xhrSize += kb;
          }
          return {
            jsSize: Math.round(bd.jsSize * 10) / 10,
            cssSize: Math.round(bd.cssSize * 10) / 10,
            imageSize: Math.round(bd.imageSize * 10) / 10,
            fontSize: Math.round(bd.fontSize * 10) / 10,
            xhrSize: Math.round(bd.xhrSize * 10) / 10,
            totalSize: Math.round(bd.totalSize * 10) / 10,
            requestCount: bd.requestCount,
          };
        });

        totalJsErrors += sessionJsErrors;
        snapshots.push({ lcp: webVitals.lcp, fid: webVitals.fid, cls: webVitals.cls, ttfb, fcp: webVitals.fcp, inp: webVitals.inp, longTaskCount: webVitals.longTaskCount, resourceBreakdown });
        testLog.info({ session: i + 1, metrics: snapshots[snapshots.length - 1] }, 'Session complete');
        addLog('INFO', `[session ${i + 1}/${sessions}] Complete — LCP ${Math.round(webVitals.lcp)}ms FCP ${Math.round(webVitals.fcp)}ms TTFB ${ttfb}ms CLS ${webVitals.cls.toFixed(3)}${sessionJsErrors > 0 ? ` jsErrors=${sessionJsErrors}` : ''}`);
      } catch (err) {
        sessionsFailed++;
        testLog.warn({ session: i + 1, err: (err as Error).message }, 'Session failed — recording as skipped and continuing');
        addLog('WARN', `[session ${i + 1}/${sessions}] Failed (skipped): ${(err as Error).message}`);
      } finally {
        await page.close().catch(() => {});
      }
    }

    if (sessionsFailed > 0) {
      addLog('WARN', `${sessionsFailed} of ${sessions} session(s) failed and were skipped`);
    }
    // Every session failed — nothing to report. Matches the pre-existing "throw on
    // no usable data" behavior this replaced (a single-session failure used to
    // throw out of the whole loop unconditionally).
    if (snapshots.length === 0) {
      throw new Error(`All ${sessions} session(s) failed — no Web Vitals collected`);
    }

    // ── Lighthouse audit — reuses the same Chrome instance via CDP port ──────
    let lighthouseScore: LighthouseScore | undefined;
    let lhTbt: number | undefined;
    let lhTti: number | undefined;
    let lhInp: number | undefined;
    let lhDomNodes: number | undefined;
    try {
      // Close all remaining pages so Lighthouse gets a clean state
      const openPages = await browser.pages();
      await Promise.all(openPages.map((p) => p.close()));

      const wsEndpoint = browser.wsEndpoint();
      const port = parseInt(new URL(wsEndpoint).port, 10);

      testLog.info({ port }, 'Running Lighthouse');
      await postMessage('Running Lighthouse audit…');

      pageLoadCount++;
      const lhResult = await runLighthouse(test.targetUrl, {
        port,
        output: 'json' as const,
        logLevel: 'silent' as const,
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
        // Lighthouse defaults to formFactor:'mobile' + simulated 4G + 4x CPU
        // slowdown — calibrated for a phone on a mobile connection, not this
        // datacenter worker. Without this override every score this platform
        // reports is a synthetic-mobile number, not a measure of the actual
        // site/server performance being load-tested.
        formFactor: 'desktop' as const,
        screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
        throttling: { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1, requestLatencyMs: 0, uploadThroughputKbps: 0, downloadThroughputKbps: 0 },
      });

      if (lhResult?.lhr?.categories) {
        const cats = lhResult.lhr.categories;
        lighthouseScore = {
          performance:   Math.round((cats['performance']?.score   ?? 0) * 100),
          accessibility: Math.round((cats['accessibility']?.score ?? 0) * 100),
          bestPractices: Math.round((cats['best-practices']?.score ?? 0) * 100),
          seo:           Math.round((cats['seo']?.score           ?? 0) * 100),
        };
      }
      if (lhResult?.lhr?.audits) {
        const a = lhResult.lhr.audits as Record<string, { numericValue?: number }>;
        lhTbt      = a['total-blocking-time']?.numericValue      != null ? Math.round(a['total-blocking-time'].numericValue)      : undefined;
        lhTti      = a['interactive']?.numericValue              != null ? Math.round(a['interactive'].numericValue)              : undefined;
        lhInp      = a['interaction-to-next-paint']?.numericValue != null ? Math.round(a['interaction-to-next-paint'].numericValue) : undefined;
        lhDomNodes = a['dom-size']?.numericValue                 != null ? Math.round(a['dom-size'].numericValue)                 : undefined;
      }
      testLog.info({ lighthouseScore, lhTbt, lhTti, lhInp, lhDomNodes }, 'Lighthouse complete');
      if (lighthouseScore) {
        addLog('INFO', `Lighthouse complete — perf=${lighthouseScore.performance} a11y=${lighthouseScore.accessibility} bp=${lighthouseScore.bestPractices} seo=${lighthouseScore.seo}${lhTbt != null ? ` TBT=${lhTbt}ms` : ''}${lhInp != null ? ` INP=${lhInp}ms` : ''}`);
      }
    } catch (err) {
      testLog.error({ err: (err as Error).message }, 'Lighthouse audit failed (non-fatal)');
      addLog('WARN', `Lighthouse audit failed (non-fatal): ${(err as Error).message}`);
      // If the kill timer fired while Lighthouse was running, the browser close
      // caused the Lighthouse rejection.  Re-throw as a hard failure so the
      // result is not mistakenly published as 'completed' (bug #3 fix).
      if (killTimerFired) {
        throw err;
      }
    }

    // ── Average Web Vitals across sessions ───────────────────────────────────
    const avgInp = avgNum(snapshots, 'inp');
    const inpValue = lhInp ?? (avgInp > 0 ? avgInp : undefined);
    const avgLongTaskCount = avgNum(snapshots, 'longTaskCount');

    // Coalesce 0 → undefined for metrics whose PerformanceObserver (or navigation
    // timing API) may never have fired, so the result exposes "unavailable" rather
    // than a spurious perfect score. Mirrors the existing pattern for
    // jsErrors / longTaskCount / inp in this same block.
    const avgLcp  = avgNum(snapshots, 'lcp');
    const avgFcp  = avgNum(snapshots, 'fcp');
    const avgCls  = avgNum(snapshots, 'cls');
    const avgTtfb = avgNum(snapshots, 'ttfb');

    return {
      metrics: {
        type: 'client',
        lcp:              avgLcp  > 0 ? avgLcp  : undefined,
        fid:              avgNum(snapshots, 'fid'),
        cls:              avgCls  > 0 ? avgCls  : undefined,
        ttfb:             avgTtfb > 0 ? avgTtfb : undefined,
        fcp:              avgFcp  > 0 ? avgFcp  : undefined,
        inp:              inpValue,
        tbt:              lhTbt,
        tti:              lhTti,
        jsErrors:         totalJsErrors > 0 ? totalJsErrors : undefined,
        longTaskCount:    avgLongTaskCount > 0 ? Math.round(avgLongTaskCount) : undefined,
        domNodeCount:     lhDomNodes,
        pageLoadCount,
        resourceBreakdown: avgResourceBreakdown(snapshots),
        lighthouseScore,
      },
      executionLog: logLines.join('\n'),
    };
  } catch (err) {
    (err as Error & { partialLog?: string }).partialLog = logLines.join('\n');
    throw err;
  } finally {
    logBatcher.flush();
    clearTimeout(killTimer);
    runningBrowsers.delete(test.id);
    await browserPool.release(browser);
  }
};
