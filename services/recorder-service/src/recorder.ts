import puppeteer, { Browser, Page, CDPSession } from 'puppeteer-core';
import { FlowStep, RecordedRequest, validateSsrfSafeUrl } from '@alt/shared';
import { log } from './logger';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PendingRequest {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | undefined;
  timestamp: number;
}

export interface RecordingSessionInternal {
  id: string;
  status: 'active' | 'stopping' | 'completed' | 'error';
  browser: Browser;
  page: Page;
  cdp: CDPSession;
  pending: Map<string, PendingRequest>;
  completed: RecordedRequest[];
  stepCount: number;
  ignorePatterns: RegExp[]; // compiled from user-supplied pattern strings
  onStep: (() => void) | null; // called when a new step is captured
  startedAt: number;     // epoch ms when the session was created
  lastActivityAt: number; // epoch ms of the last captured request
  teamId?: string | null; // team whose AI provider override should be used for correlation
}

// ─── Static assets we always skip ────────────────────────────────────────────

const SKIP_EXTENSIONS = /\.(js|mjs|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|webp|avif|mp4|mp3|pdf)(\?.*)?$/i;
const SKIP_CONTENT_TYPES = /^(text\/css|application\/javascript|font\/|image\/)/i;
const SKIP_SCHEMES = /^(chrome-extension:|data:|blob:|about:)/i;

export function shouldSkip(url: string, contentType: string, ignorePatterns: RegExp[]): boolean {
  if (SKIP_SCHEMES.test(url)) return true;
  if (SKIP_EXTENSIONS.test(url)) return true;
  if (contentType && SKIP_CONTENT_TYPES.test(contentType)) return true;
  // User-defined ignore list: match anywhere in the URL (substring or regex)
  for (const pattern of ignorePatterns) {
    if (pattern.test(url)) return true;
  }
  return false;
}

/** Compile user pattern strings into RegExp objects.
 *  Plain strings become substring matches; patterns wrapped in / / are treated as regex. */
export function compileIgnorePatterns(patterns: string[]): RegExp[] {
  return patterns
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => {
      const regexMatch = p.match(/^\/(.+)\/([gimsuy]*)$/);
      if (regexMatch) {
        try { return new RegExp(regexMatch[1]!, regexMatch[2]!); } catch { return null; } // both capture groups are required by the pattern (group 2 may capture an empty string, but always participates)
      }
      // Plain string → escape and use as substring match
      return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    })
    .filter((r): r is RegExp => r !== null);
}

// ─── Convert captured requests → FlowStep[] ──────────────────────────────────

export const FLOW_STEPS_CAP = 50;

/** Compute realistic inter-step think times (ms) from request timestamps.
 *  Returns one value per step: the pause before that step starts (0 for step 0). */
export function computeThinkTimes(requests: RecordedRequest[]): number[] {
  const filtered = requests.filter(r => r.responseStatus < 500).slice(0, FLOW_STEPS_CAP);
  return filtered.map((r, i) => {
    if (i === 0) return 0;
    const curr = r.timestamp ?? 0;
    const prev = filtered[i - 1]!.timestamp ?? 0; // i === 0 returns above, so i - 1 is always a valid index here
    if (!curr || !prev) return 0;
    // Cap at 10s — longer gaps are usually page load wait time, not think time
    return Math.min(Math.max(curr - prev, 0), 10_000);
  });
}

export function toFlowSteps(requests: RecordedRequest[]): FlowStep[] {
  return requests
    .filter(r => r.responseStatus < 500) // skip hard server errors
    .slice(0, FLOW_STEPS_CAP)
    .map((r, i) => {
      const parsedUrl = ((): URL | null => { try { return new URL(r.url); } catch { return null; } })();
      const path = parsedUrl ? parsedUrl.pathname : r.url;
      const method = r.method.toUpperCase() as FlowStep['method'];
      const step: FlowStep = {
        name: `Step ${i + 1}: ${method} ${path}`,
        url: r.url,
        method,
        body: r.body ?? '',
        headers: {},
        extract: {},
      };
      // Include only non-trivial headers (skip browser internals)
      const SKIP_HEADERS = new Set([
        'cookie', 'authorization', 'host', 'content-length', 'connection',
        'accept-encoding', 'accept-language', 'sec-fetch-site', 'sec-fetch-mode',
        'sec-fetch-dest', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
        'upgrade-insecure-requests', 'cache-control', 'pragma',
      ]);
      for (const [name, value] of Object.entries(r.headers)) {
        if (!SKIP_HEADERS.has(name.toLowerCase())) {
          step.headers![name] = value;
        }
      }
      return step;
    });
}

// ─── SSRF request-interception handler ───────────────────────────────────────

/**
 * Returns a Puppeteer request-interception handler that re-validates every URL
 * the browser navigates to — including each redirect hop — using the provided
 * SSRF validator. Puppeteer's interception API fires a fresh 'request' event for
 * every redirect target, so every hop is independently checked.
 *
 * Exported separately so it can be unit-tested without a real Puppeteer instance.
 */
export function createSsrfInterceptHandler(
  validate: (url: string) => string | null | undefined,
): (request: { url(): string; abort(reason?: string): void; continue(): void }) => void {
  return (request) => {
    const err = validate(request.url());
    if (err) {
      request.abort('blockedbyclient');
    } else {
      request.continue();
    }
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function startSession(
  sessionId: string,
  onStep: () => void,
  ignorePatterns: RegExp[] = [],
): Promise<RecordingSessionInternal> {
  const chromiumPath =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROMIUM_PATH ||
    '/usr/bin/chromium-browser';

  const display = process.env.DISPLAY || (process.platform === 'win32' ? undefined : ':99');
  const launchEnv = display ? { ...process.env, DISPLAY: display } : undefined;

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: chromiumPath,
    ...(launchEnv ? { env: launchEnv } : {}), // omit the key entirely rather than pass env: undefined
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,960',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // Re-validate every URL the browser navigates to, including redirect hops.
  // Puppeteer fires a fresh 'request' event for each redirect target, so this
  // catches 302→private-IP attacks that bypass the one-time targetUrl check.
  await page.setRequestInterception(true);
  page.on('request', createSsrfInterceptHandler(validateSsrfSafeUrl));

  const cdp: CDPSession = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Page.enable');

  const pending = new Map<string, PendingRequest>();
  const completed: RecordedRequest[] = [];

  // ── CDP: capture outgoing requests ────────────────────────────────────────
  cdp.on('Network.requestWillBeSent', (event) => {
    const { url, method, headers, postData } = event.request;
    if (shouldSkip(url, '', ignorePatterns)) return;

    pending.set(event.requestId, {
      requestId: event.requestId,
      url,
      method,
      headers,
      body: postData,
      timestamp: Date.now(),
    });
  });

  // ── CDP: capture response metadata ────────────────────────────────────────
  const responseHeaders = new Map<string, { status: number; headers: Record<string, string>; contentType: string }>();

  cdp.on('Network.responseReceived', (event) => {
    const { url, status, headers, mimeType } = event.response;
    if (shouldSkip(url, mimeType ?? '', ignorePatterns)) {
      pending.delete(event.requestId);
      return;
    }
    responseHeaders.set(event.requestId, {
      status,
      headers,
      contentType: mimeType ?? '',
    });
  });

  // ── CDP: assemble complete exchange ───────────────────────────────────────
  cdp.on('Network.loadingFinished', (event) => {
    void (async (): Promise<void> => {
      const req = pending.get(event.requestId);
      const resp = responseHeaders.get(event.requestId);
      if (!req || !resp) return;
      pending.delete(event.requestId);
      responseHeaders.delete(event.requestId);

      // Try to read response body (for JSON responses only — for correlation)
      let responseBody: string | undefined;
      const ct = resp.contentType.toLowerCase();
      if (ct.includes('json')) {
        try {
          const { body } = await cdp.send('Network.getResponseBody', { requestId: event.requestId });
          responseBody = body;
        } catch {
          // body may not be available for some requests — ignore
        }
      }

      completed.push({
        requestId: req.requestId,
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body,
        responseStatus: resp.status,
        responseHeaders: resp.headers,
        responseBody,
        timestamp: req.timestamp,
      });

      session.stepCount = completed.length;
      session.lastActivityAt = Date.now();
      onStep();
      log.debug({ url: req.url, status: resp.status }, 'Captured request');
    })();
  });

  const session: RecordingSessionInternal = {
    id: sessionId,
    status: 'active',
    browser,
    page,
    cdp,
    pending,
    completed,
    stepCount: 0,
    ignorePatterns,
    onStep,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
  };

  log.info({ sessionId, chromiumPath }, 'Recording session started');
  return session;
}

export async function stopSession(
  session: RecordingSessionInternal,
): Promise<RecordedRequest[]> {
  session.status = 'stopping';
  try {
    await session.cdp.detach();
  } catch { /* already detached */ }
  try {
    await session.browser.close();
  } catch { /* already closed */ }
  session.status = 'completed';
  log.info({ sessionId: session.id, captured: session.completed.length }, 'Recording session stopped');
  return [...session.completed];
}
