/**
 * Reuses idle Puppeteer browser processes across sequential test runs on the
 * same worker instead of paying Chrome's ~1-3s launch cost on every dequeue.
 *
 * Deliberately pools whole browser *processes*, not just pages/contexts: a
 * client-side test's Lighthouse audit needs a browser's CDP port to itself
 * (it enumerates and closes every open page via browser.pages()), so sharing
 * one browser across concurrently-running tests would let one test's
 * Lighthouse pass tear down another's in-flight pages. Each pooled browser is
 * checked out to exactly one test at a time — the same exclusivity the
 * previous launch-per-test code already had — so this changes nothing about
 * concurrency, only whether the process is closed or reused between tests.
 */
import puppeteer, { Browser } from 'puppeteer';

export interface BrowserPool {
  acquire(): Promise<Browser>;
  /**
   * Called unconditionally in the caller's `finally` block, whether the test
   * succeeded, failed, or was cancelled. If the browser is still connected,
   * its pages/listeners are reset and it's returned to the idle pool (up to
   * `maxIdle`); a disconnected browser (killed by cancel, the max-duration
   * timer, or a real crash) is simply dropped — there's nothing to reuse.
   */
  release(browser: Browser): Promise<void>;
}

const LAUNCH_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

export function createBrowserPool(
  launchBrowser: typeof puppeteer.launch = puppeteer.launch.bind(puppeteer),
  maxIdle = 4,
): BrowserPool {
  const idle: Browser[] = [];

  const acquire = async (): Promise<Browser> => {
    while (idle.length > 0) {
      const candidate = idle.pop() as Browser;
      if (candidate.connected) return candidate;
      // Stale/disconnected browser sitting in the idle list (e.g. crashed
      // while idle) — discard it and try the next one, or launch fresh.
    }
    return launchBrowser({ headless: true, args: LAUNCH_ARGS });
  };

  const release = async (browser: Browser): Promise<void> => {
    if (!browser.connected) return;

    // runClientTest attaches a fresh 'targetcreated' listener on every call —
    // without removing it here, listeners would accumulate on every reuse.
    browser.removeAllListeners('targetcreated');
    const pages = await browser.pages().catch(() => []);
    await Promise.all(pages.map(p => p.close().catch(() => {})));

    if (idle.length >= maxIdle) {
      await browser.close().catch(() => {});
      return;
    }
    idle.push(browser);
  };

  return { acquire, release };
}
