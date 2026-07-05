import { describe, it, expect, vi } from 'vitest';
import type { Browser } from 'puppeteer';
import { createBrowserPool } from '../browserPool';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockFn = ReturnType<typeof vi.fn<(...args: any[]) => any>>;

type FakeBrowser = Browser & { connected: boolean };

function makeFakeBrowser(overrides: { connected?: boolean; pages?: unknown[] } = {}): FakeBrowser {
  return {
    connected:          overrides.connected ?? true,
    close:              vi.fn().mockResolvedValue(undefined),
    removeAllListeners: vi.fn(),
    pages:              vi.fn().mockResolvedValue(overrides.pages ?? []),
  } as unknown as FakeBrowser;
}

function makeFakePage() {
  return { close: vi.fn().mockResolvedValue(undefined) };
}

describe('createBrowserPool', () => {
  it('launches a fresh browser when the pool is empty', async () => {
    const browser = makeFakeBrowser();
    const launch = vi.fn().mockResolvedValue(browser);
    const pool = createBrowserPool(launch as unknown as MockFn);

    const acquired = await pool.acquire();

    expect(launch).toHaveBeenCalledOnce();
    expect(acquired).toBe(browser);
  });

  it('returns a released, still-connected browser on the next acquire instead of launching', async () => {
    const browser = makeFakeBrowser();
    const launch = vi.fn().mockResolvedValue(browser);
    const pool = createBrowserPool(launch as unknown as MockFn);

    const first = await pool.acquire();
    await pool.release(first);
    const second = await pool.acquire();

    expect(second).toBe(first);
    expect(launch).toHaveBeenCalledOnce();
  });

  it('closes all pages and removes the targetcreated listener on release', async () => {
    const page1 = makeFakePage();
    const page2 = makeFakePage();
    const browser = makeFakeBrowser({ pages: [page1, page2] });
    const launch = vi.fn().mockResolvedValue(browser);
    const pool = createBrowserPool(launch as unknown as MockFn);

    const acquired = await pool.acquire();
    await pool.release(acquired);

    expect(page1.close).toHaveBeenCalledOnce();
    expect(page2.close).toHaveBeenCalledOnce();
    expect(browser.removeAllListeners).toHaveBeenCalledWith('targetcreated');
  });

  it('does not close the browser itself on a normal release', async () => {
    const browser = makeFakeBrowser();
    const launch = vi.fn().mockResolvedValue(browser);
    const pool = createBrowserPool(launch as unknown as MockFn);

    await pool.release(await pool.acquire());

    expect(browser.close).not.toHaveBeenCalled();
  });

  it('does not re-pool a disconnected browser — the next acquire launches fresh', async () => {
    const deadBrowser = makeFakeBrowser({ connected: false });
    const freshBrowser = makeFakeBrowser();
    const launch = vi.fn().mockResolvedValueOnce(deadBrowser).mockResolvedValueOnce(freshBrowser);
    const pool = createBrowserPool(launch as unknown as MockFn);

    const acquired = await pool.acquire();
    await pool.release(acquired); // acquired.connected === false — skipped

    const next = await pool.acquire();

    expect(next).toBe(freshBrowser);
    expect(launch).toHaveBeenCalledTimes(2);
    // release() bailed before touching pages/listeners on a dead browser.
    expect(deadBrowser.pages).not.toHaveBeenCalled();
    expect(deadBrowser.removeAllListeners).not.toHaveBeenCalled();
  });

  it('discards an idle browser that disconnected while sitting in the pool', async () => {
    const idleBrowser = makeFakeBrowser();
    const freshBrowser = makeFakeBrowser();
    const launch = vi.fn().mockResolvedValueOnce(idleBrowser).mockResolvedValueOnce(freshBrowser);
    const pool = createBrowserPool(launch as unknown as MockFn);

    const acquired = await pool.acquire();
    await pool.release(acquired);
    idleBrowser.connected = false; // crashed while sitting idle

    const next = await pool.acquire();

    expect(next).toBe(freshBrowser);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('closes (does not pool) a released browser once maxIdle is already reached', async () => {
    const idle1 = makeFakeBrowser();
    const idle2 = makeFakeBrowser();
    const overflow = makeFakeBrowser();
    const launch = vi.fn()
      .mockResolvedValueOnce(idle1)
      .mockResolvedValueOnce(idle2)
      .mockResolvedValueOnce(overflow);
    const pool = createBrowserPool(launch as unknown as MockFn, 2); // maxIdle = 2

    const a = await pool.acquire();
    const b = await pool.acquire();
    const c = await pool.acquire();
    await pool.release(a);
    await pool.release(b); // idle is now full (2/2)
    await pool.release(c); // overflow — should be closed, not pooled

    expect(overflow.close).toHaveBeenCalledOnce();
    expect(idle1.close).not.toHaveBeenCalled();
    expect(idle2.close).not.toHaveBeenCalled();
  });

  it('is a no-op (never throws) releasing an already-disconnected browser', async () => {
    const browser = makeFakeBrowser({ connected: false });
    const pool = createBrowserPool(vi.fn() as unknown as MockFn);

    await expect(pool.release(browser)).resolves.toBeUndefined();
    expect(browser.close).not.toHaveBeenCalled();
  });
});
