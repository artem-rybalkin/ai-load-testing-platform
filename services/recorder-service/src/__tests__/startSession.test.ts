/**
 * Unit tests for startSession/stopSession and the CDP event pipeline (L1).
 *
 * puppeteer-core itself can't run in the Vitest Node environment (native binary
 * dep, launches a real Chromium), so puppeteer.launch() is mocked to return a
 * fake Browser/Page/CDPSession. The CDPSession is a real EventEmitter, so the
 * event-driven request/response assembly logic in recorder.ts (the actual
 * "CDP pipeline" this gap refers to) runs for real — only the browser process
 * itself is faked out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const mockLaunch = vi.hoisted(() => vi.fn());
vi.mock('puppeteer-core', () => ({ default: { launch: mockLaunch } }));

import { startSession, stopSession } from '../recorder';

// ─── Fakes ────────────────────────────────────────────────────────────────────

/** A real EventEmitter so `cdp.on('Network.xxx', ...)` handlers registered by
 *  recorder.ts fire exactly as they would against a real CDPSession. */
class FakeCDPSession extends EventEmitter {
  send = vi.fn(async (method: string, params?: { requestId?: string }) => {
    if (method === 'Network.getResponseBody') {
      return { body: this.responseBodies.get(params?.requestId ?? '') ?? '' };
    }
    return undefined;
  });
  detach = vi.fn().mockResolvedValue(undefined);
  responseBodies = new Map<string, string>();
}

function makeFakeBrowser() {
  const cdp = new FakeCDPSession();
  const page = {
    setViewport: vi.fn().mockResolvedValue(undefined),
    setRequestInterception: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    createCDPSession: vi.fn().mockResolvedValue(cdp),
  };
  const browser = {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { browser, page, cdp };
}

/** Emits the 3-event CDP sequence for one request/response exchange. */
async function emitExchange(
  cdp: FakeCDPSession,
  opts: {
    requestId?: string;
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    postData?: string;
    status?: number;
    responseHeaders?: Record<string, string>;
    mimeType?: string;
    responseBody?: string;
  } = {},
): Promise<void> {
  const requestId = opts.requestId ?? 'req-1';
  cdp.emit('Network.requestWillBeSent', {
    requestId,
    request: {
      url: opts.url ?? 'https://api.example.com/users',
      method: opts.method ?? 'GET',
      headers: opts.headers ?? { 'x-request-id': 'abc' },
      postData: opts.postData,
    },
  });
  cdp.emit('Network.responseReceived', {
    requestId,
    response: {
      url: opts.url ?? 'https://api.example.com/users',
      status: opts.status ?? 200,
      headers: opts.responseHeaders ?? { 'content-type': 'application/json' },
      mimeType: opts.mimeType ?? 'application/json',
    },
  });
  if (opts.responseBody !== undefined) cdp.responseBodies.set(requestId, opts.responseBody);
  cdp.emit('Network.loadingFinished', { requestId });
  // loadingFinished's handler is async (awaits getResponseBody) — flush microtasks.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  mockLaunch.mockReset();
});

// ─── startSession — CDP event pipeline ────────────────────────────────────────

describe('startSession — CDP request/response assembly', () => {
  it('assembles a complete exchange into session.completed after requestWillBeSent + responseReceived + loadingFinished', async () => {
    const { browser, cdp } = makeFakeBrowser();
    mockLaunch.mockResolvedValue(browser);
    const onStep = vi.fn();

    const session = await startSession('sess-1', onStep);
    await emitExchange(cdp, { requestId: 'r1', url: 'https://api.example.com/login', method: 'POST', postData: '{"u":"a"}' });

    expect(session.completed).toHaveLength(1);
    expect(session.completed[0]).toMatchObject({
      requestId: 'r1',
      url: 'https://api.example.com/login',
      method: 'POST',
      body: '{"u":"a"}',
      responseStatus: 200,
    });
  });

  it('calls onStep exactly once per completed exchange', async () => {
    const { browser, cdp } = makeFakeBrowser();
    mockLaunch.mockResolvedValue(browser);
    const onStep = vi.fn();

    await startSession('sess-2', onStep);
    await emitExchange(cdp, { requestId: 'r1' });
    await emitExchange(cdp, { requestId: 'r2' });

    expect(onStep).toHaveBeenCalledTimes(2);
  });

  it('updates stepCount and lastActivityAt as requests complete', async () => {
    const { browser, cdp } = makeFakeBrowser();
    mockLaunch.mockResolvedValue(browser);
    const session = await startSession('sess-3', vi.fn());

    expect(session.stepCount).toBe(0);
    const before = session.lastActivityAt;
    await new Promise(r => setTimeout(r, 5));
    await emitExchange(cdp, { requestId: 'r1' });

    expect(session.stepCount).toBe(1);
    expect(session.lastActivityAt).toBeGreaterThan(before);
  });

  it('fetches the response body via Network.getResponseBody for JSON content-type', async () => {
    const { browser, cdp } = makeFakeBrowser();
    mockLaunch.mockResolvedValue(browser);
    const session = await startSession('sess-4', vi.fn());

    await emitExchange(cdp, { requestId: 'r1', mimeType: 'application/json', responseBody: '{"token":"xyz"}' });

    expect(cdp.send).toHaveBeenCalledWith('Network.getResponseBody', { requestId: 'r1' });
    expect(session.completed[0]!.responseBody).toBe('{"token":"xyz"}');
  });

  it('does NOT fetch the response body for non-JSON content-type', async () => {
    const { browser, cdp } = makeFakeBrowser();
    mockLaunch.mockResolvedValue(browser);
    const session = await startSession('sess-5', vi.fn());

    await emitExchange(cdp, { requestId: 'r1', mimeType: 'text/html' });

    expect(cdp.send).not.toHaveBeenCalledWith('Network.getResponseBody', expect.anything());
    expect(session.completed[0]!.responseBody).toBeUndefined();
  });

  it('does not crash and leaves responseBody undefined when getResponseBody throws (body unavailable)', async () => {
    const { browser, cdp } = makeFakeBrowser();
    mockLaunch.mockResolvedValue(browser);
    cdp.send = vi.fn(async (method: string) => {
      if (method === 'Network.getResponseBody') throw new Error('No resource with given identifier');
      return undefined;
    });
    const session = await startSession('sess-6', vi.fn());

    await emitExchange(cdp, { requestId: 'r1', mimeType: 'application/json' });

    expect(session.completed).toHaveLength(1);
    expect(session.completed[0]!.responseBody).toBeUndefined();
  });

  it('never adds a request to the exchange when loadingFinished fires with no prior requestWillBeSent/responseReceived', async () => {
    const { browser, cdp } = makeFakeBrowser();
    mockLaunch.mockResolvedValue(browser);
    const onStep = vi.fn();
    const session = await startSession('sess-7', onStep);

    cdp.emit('Network.loadingFinished', { requestId: 'orphan' });
    await Promise.resolve();
    await Promise.resolve();

    expect(session.completed).toHaveLength(0);
    expect(onStep).not.toHaveBeenCalled();
  });
});

// ─── startSession — shouldSkip filtering wired through CDP events ────────────

describe('startSession — skip filtering during capture', () => {
  it('never tracks a request matching SKIP_EXTENSIONS (e.g. .png) — requestWillBeSent drops it', async () => {
    const { browser, cdp } = makeFakeBrowser();
    mockLaunch.mockResolvedValue(browser);
    const session = await startSession('sess-8', vi.fn());

    await emitExchange(cdp, { requestId: 'r1', url: 'https://cdn.example.com/logo.png' });

    expect(session.completed).toHaveLength(0);
  });

  it('never tracks a chrome-extension:/data:/blob: scheme URL', async () => {
    const { browser, cdp } = makeFakeBrowser();
    mockLaunch.mockResolvedValue(browser);
    const session = await startSession('sess-9', vi.fn());

    await emitExchange(cdp, { requestId: 'r1', url: 'data:image/png;base64,AAAA' });

    expect(session.completed).toHaveLength(0);
  });

  it('drops a request whose responseReceived content-type is image/* even if the URL had no extension hint', async () => {
    const { browser, cdp } = makeFakeBrowser();
    mockLaunch.mockResolvedValue(browser);
    const session = await startSession('sess-10', vi.fn());

    await emitExchange(cdp, { requestId: 'r1', url: 'https://api.example.com/thumbnail', mimeType: 'image/webp' });

    expect(session.completed).toHaveLength(0);
  });

  it('honors user-supplied ignorePatterns passed into startSession', async () => {
    const { browser, cdp } = makeFakeBrowser();
    mockLaunch.mockResolvedValue(browser);
    const session = await startSession('sess-11', vi.fn(), [/analytics\.example\.com/]);

    await emitExchange(cdp, { requestId: 'r1', url: 'https://analytics.example.com/collect' });
    await emitExchange(cdp, { requestId: 'r2', url: 'https://api.example.com/users' });

    expect(session.completed).toHaveLength(1);
    expect(session.completed[0]!.url).toBe('https://api.example.com/users');
  });

  it('still captures normal API requests unaffected by skip rules', async () => {
    const { browser, cdp } = makeFakeBrowser();
    mockLaunch.mockResolvedValue(browser);
    const session = await startSession('sess-12', vi.fn());

    await emitExchange(cdp, { requestId: 'r1', url: 'https://api.example.com/orders', mimeType: 'application/json' });

    expect(session.completed).toHaveLength(1);
  });
});

// ─── startSession — browser/page/CDP wiring ───────────────────────────────────

describe('startSession — launch wiring', () => {
  it('launches headless:false with the configured executablePath and enables Network + Page domains', async () => {
    const { browser, page, cdp } = makeFakeBrowser();
    mockLaunch.mockResolvedValue(browser);

    await startSession('sess-13', vi.fn());

    expect(mockLaunch).toHaveBeenCalledWith(expect.objectContaining({ headless: false }));
    expect(page.setViewport).toHaveBeenCalledWith({ width: 1280, height: 800 });
    expect(cdp.send).toHaveBeenCalledWith('Network.enable');
    expect(cdp.send).toHaveBeenCalledWith('Page.enable');
  });

  it('returns a session with status "active" and the given sessionId', async () => {
    const { browser } = makeFakeBrowser();
    mockLaunch.mockResolvedValue(browser);

    const session = await startSession('sess-14', vi.fn());

    expect(session.id).toBe('sess-14');
    expect(session.status).toBe('active');
  });
});

// ─── stopSession ───────────────────────────────────────────────────────────────

describe('stopSession', () => {
  it('detaches the CDP session and closes the browser', async () => {
    const { browser, cdp } = makeFakeBrowser();
    mockLaunch.mockResolvedValue(browser);
    const session = await startSession('sess-15', vi.fn());

    await stopSession(session);

    expect(cdp.detach).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('sets status to "completed" and returns the captured requests', async () => {
    const { browser, cdp } = makeFakeBrowser();
    mockLaunch.mockResolvedValue(browser);
    const session = await startSession('sess-16', vi.fn());
    await emitExchange(cdp, { requestId: 'r1' });

    const result = await stopSession(session);

    expect(session.status).toBe('completed');
    expect(result).toHaveLength(1);
  });

  it('returns a snapshot copy — later mutation of session.completed does not affect the returned array', async () => {
    const { browser, cdp } = makeFakeBrowser();
    mockLaunch.mockResolvedValue(browser);
    const session = await startSession('sess-17', vi.fn());
    await emitExchange(cdp, { requestId: 'r1' });

    const result = await stopSession(session);
    session.completed.push({ requestId: 'r2', url: 'x', method: 'GET', headers: {}, responseStatus: 200, responseHeaders: {} });

    expect(result).toHaveLength(1);
  });

  it('swallows errors from an already-detached CDP session', async () => {
    const { browser, cdp } = makeFakeBrowser();
    mockLaunch.mockResolvedValue(browser);
    cdp.detach = vi.fn().mockRejectedValue(new Error('Session already detached'));
    const session = await startSession('sess-18', vi.fn());

    await expect(stopSession(session)).resolves.toEqual([]);
  });

  it('swallows errors from an already-closed browser', async () => {
    const { browser } = makeFakeBrowser();
    mockLaunch.mockResolvedValue(browser);
    browser.close = vi.fn().mockRejectedValue(new Error('Browser already closed'));
    const session = await startSession('sess-19', vi.fn());

    await expect(stopSession(session)).resolves.toEqual([]);
  });
});
