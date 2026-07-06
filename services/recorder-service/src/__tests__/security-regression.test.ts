/**
 * Regression tests for 7 audit findings in services/recorder-service,
 * documented in TODO.md "## Open" section (High + Medium + Low severity).
 *
 * All findings use it.fails() because each assertion describes the DESIRED
 * (fixed) behavior that the current implementation does NOT satisfy.
 * it.fails() keeps the suite green while the bugs remain open. When a fix
 * lands, it.fails() starts reporting "unexpected pass" — that is the signal
 * to remove the wrapper and promote the test to a plain it().
 *
 * DO NOT replace failing tests with it.skip/it.todo — those do not exercise
 * the assertion at all and do not confirm the bug is still present.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';

// ─── Module mocks (same pattern as correlator.test.ts) ──────────────────────

vi.mock('@alt/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alt/shared')>();
  const mockFn = vi.fn();
  return { ...actual, generateAIText: mockFn };
});

// Disable real network calls to results-service (getProviderSetting)
vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch disabled in tests')));

// puppeteer-core requires a native binary; mock it so recorder.ts can be imported
vi.mock('puppeteer-core', () => ({ default: {} }));

// ─── Imports (after mocks so vi.mock applies first) ──────────────────────────

import { detectCorrelations } from '../correlator';
import * as correlatorModule from '../correlator';
import { toFlowSteps, createSsrfInterceptHandler } from '../recorder';
import { validateRecorderUrl } from '../index';
import { validateSsrfSafeUrl } from '@alt/shared';
import type { RecordedRequest, FlowStep } from '@alt/shared';

// ─── Helper: get the generateAIText mock from the mocked @alt/shared ─────────

const getMock = async (): Promise<ReturnType<typeof vi.fn>> => {
  const shared = await import('@alt/shared');
  return (shared as unknown as { generateAIText: ReturnType<typeof vi.fn> }).generateAIText;
};

// ─── Fixtures ────────────────────────────────────────────────────────────────

const makeRequest = (overrides: Partial<RecordedRequest> = {}): RecordedRequest => ({
  requestId: crypto.randomUUID(),
  url: 'https://api.example.com/endpoint',
  method: 'GET',
  headers: {},
  body: undefined,
  responseStatus: 200,
  responseHeaders: {},
  responseBody: '{"ok":true}',
  ...overrides,
});

const makeStep = (name: string, url: string): FlowStep => ({
  name,
  url,
  method: 'GET',
  headers: {},
  extract: {},
});

// ─── Global beforeEach: ensure GEMINI_API_KEY is set + reset mock ─────────────

beforeEach(async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  const mock = await getMock();
  mock.mockReset();
  mock.mockResolvedValue('{"correlations":[]}');
});

// ─── Finding #1: Auth headers forwarded to Gemini in cleartext ───────────────
//
// correlator.ts:112-121 (buildSummary): auth headers matching
// /^authorization$|x-auth|x-csrf|x-token|x-api-key/i are included verbatim in
// the prompt. No redactPII() call touches the header values. Real bearer tokens
// and session cookies captured during recording leave the perimeter to Gemini.
//
// Desired fix: pass auth header values through redactPII() before building the
// prompt summary, or replace literal values with a placeholder token.

describe('Finding #1 — auth headers forwarded verbatim to Gemini', () => {
  it('Authorization header value does not appear verbatim in the Gemini prompt', async () => {
    const mock = await getMock();
    const token = 'supersecretbearertoken999';

    const requests = [
      makeRequest({
        url: 'https://api.example.com/login',
        method: 'POST',
        responseBody: `{"access_token":"${token}"}`,
      }),
      makeRequest({
        url: 'https://api.example.com/profile',
        method: 'GET',
        // This header is picked up by buildSummary's requestHeaders filter:
        headers: { Authorization: `Bearer ${token}` },
        responseBody: undefined,
      }),
    ];
    const steps = [
      makeStep('Login', 'https://api.example.com/login'),
      makeStep('Get profile', 'https://api.example.com/profile'),
    ];

    await detectCorrelations(requests, steps);

    const prompt = mock.mock.calls[0][0] as string;
    // Desired: the literal bearer token should be redacted before reaching Gemini.
    // Current: buildSummary includes requestHeaders as-is with no redactPII call
    // (correlator.ts:108-113), so the token appears verbatim in the prompt.
    expect(prompt).not.toContain(token);
  });

  it('X-Api-Key header value does not appear verbatim in the Gemini prompt', async () => {
    const mock = await getMock();
    const apiKey = 'xapikey-cleartext-leaked-4567';

    const requests = [
      makeRequest({
        url: 'https://api.example.com/data',
        method: 'GET',
        headers: { 'x-api-key': apiKey },
        responseBody: '{"data":"value"}',
      }),
      makeRequest({
        url: 'https://api.example.com/more',
        method: 'GET',
        headers: { 'x-api-key': apiKey },
        responseBody: undefined,
      }),
    ];
    const steps = [
      makeStep('Fetch data', 'https://api.example.com/data'),
      makeStep('Fetch more', 'https://api.example.com/more'),
    ];

    await detectCorrelations(requests, steps);

    const prompt = mock.mock.calls[0][0] as string;
    expect(prompt).not.toContain(apiKey);
  });
});

// ─── Finding #2: PII redaction runs after body truncation ────────────────────
//
// correlator.ts:115: redactPII(r.body.slice(0, 500))
// correlator.ts:126: redactPII(r.responseBody.slice(0, 2000))
//
// Truncation happens before redaction. A PII value (email, SSN, phone) that
// straddles the cutoff is cut mid-pattern and is no longer matched by the
// regex → the partial value reaches Gemini in plaintext.
//
// Desired fix: redact first, truncate second:
//   redactPII(r.body).slice(0, 500)

describe('Finding #2 — PII straddling the truncation boundary reaches Gemini', () => {
  it('email straddling the 500-char request-body boundary is fully redacted', async () => {
    const mock = await getMock();

    // Place the email so it starts 8 chars before the 500-char boundary.
    // After body.slice(0, 500) the text in the prompt is:
    //   'x'.repeat(492) + 'user@exa'   ← 8 chars of the email (no '.com' TLD)
    // EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
    // 'user@exa' does not contain a dot-separated TLD → no match → not redacted.
    const email = 'user@example.com'; // 16 chars
    const prefixLen = 500 - 8;        // = 492; email starts at position 492
    const body = 'x'.repeat(prefixLen) + email; // 508 chars total

    const requests = [
      makeRequest({
        url: 'https://api.example.com/checkout',
        method: 'POST',
        body,
        responseBody: '{"ok":true}',
      }),
      makeRequest({
        url: 'https://api.example.com/confirm',
        responseBody: undefined,
      }),
    ];
    const steps = [
      makeStep('Checkout', 'https://api.example.com/checkout'),
      makeStep('Confirm', 'https://api.example.com/confirm'),
    ];

    await detectCorrelations(requests, steps);

    const prompt = mock.mock.calls[0][0] as string;
    // Desired: redactPII runs on the full body before slicing, so 'user@example.com'
    // is matched in full and replaced with '[REDACTED_EMAIL]' before the 500-char cut.
    // Current: slice runs first → 'user@exa' leaks into the prompt unredacted.
    expect(prompt).not.toContain('user@');
  });
});

// ─── Finding #3: SSRF guard only checks literal targetUrl, not redirects ─────
//
// index.ts:93-101: validateRecorderUrl() is called once before page.goto().
// page.goto() follows redirects natively (up to N hops) with no re-validation
// of the final resolved URL. A public hostname that 302-redirects to an RFC-1918
// address bypasses the guard entirely.
//
// The shared validator's own IPv6 and trailing-dot bypass bugs are already
// regression-tested in packages/shared/src/__tests__/validateSsrfSafeUrl.test.ts.
// This describe covers only the recorder-specific call-site wiring.

describe('Finding #3 — recorder SSRF guard wiring and redirect gap', () => {
  it('validateRecorderUrl delegates to the shared validateSsrfSafeUrl validator', () => {
    // index.ts:19: export const validateRecorderUrl = validateSsrfSafeUrl;
    // Confirms the wiring — the call site in POST /recordings/start uses the
    // shared validator (with its known IPv6/trailing-dot gaps, covered separately).
    expect(validateRecorderUrl).toBe(validateSsrfSafeUrl);
  });

  // The fix installs a Puppeteer request-interception handler (createSsrfInterceptHandler)
  // on the page before any navigation. Puppeteer fires a fresh 'request' event for
  // every redirect hop, so the handler re-validates every URL the browser visits —
  // including the final target of a 302 redirect chain.
  //
  // This test exercises the handler directly (extracted for testability) using a
  // minimal fake request object — no real Puppeteer/Chromium required.
  it('request interception handler validates every URL including redirect targets and blocks private-IP hops', () => {
    const handler = createSsrfInterceptHandler(validateSsrfSafeUrl);

    // A public/external URL passes through — the handler calls continue()
    const publicReq = {
      url: () => 'https://api.example.com/data',
      abort: vi.fn(),
      continue: vi.fn(),
    };
    handler(publicReq);
    expect(publicReq.continue).toHaveBeenCalledOnce();
    expect(publicReq.abort).not.toHaveBeenCalled();

    // Redirect hop to loopback (the confirmed live exploit target: 127.0.0.1:6080)
    // must be blocked — this is the exact redirect-gap that the fix closes.
    const loopbackReq = {
      url: () => 'http://127.0.0.1:6080/',
      abort: vi.fn(),
      continue: vi.fn(),
    };
    handler(loopbackReq);
    expect(loopbackReq.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(loopbackReq.continue).not.toHaveBeenCalled();

    // Redirect hop to an RFC-1918 private range must also be blocked
    const privateReq = {
      url: () => 'http://192.168.1.1/internal',
      abort: vi.fn(),
      continue: vi.fn(),
    };
    handler(privateReq);
    expect(privateReq.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(privateReq.continue).not.toHaveBeenCalled();
  });
});

// ─── Finding #4: Correlations mis-attached when any captured request is a 5xx ─
//
// index.ts:162-164:
//   const rawSteps = toFlowSteps(capturedRequests);   // drops 5xx → shorter
//   const correlatedSteps = await detectCorrelations(capturedRequests, rawSteps, ...);
//
// buildSummary() (correlator.ts:100) sends ALL requests to Gemini → Gemini
// returns indices into the UNFILTERED array. applyCorrelations()
// (correlator.ts:229-241) uses those indices to write into the FILTERED result[]
// array → wrong step gets the extract rule, and any usedInStepIndex that exceeds
// result.length is silently dropped (the idx < result.length guard at line 244).

describe('Finding #4 — correlations mis-attached when a 5xx request is in the captured set', () => {
  it.fails('correlation from a request after a 5xx attaches to the correct filtered step', async () => {
    const mock = await getMock();

    // Four requests: index 1 is a 5xx and will be dropped by toFlowSteps().
    const req0 = makeRequest({ url: 'https://api.example.com/init',   responseBody: '{"started":true}' });
    const req1 = makeRequest({ url: 'https://api.example.com/error',  responseStatus: 500, responseBody: '{"error":"fail"}' });
    const req2 = makeRequest({ url: 'https://api.example.com/auth',   responseBody: '{"session_token":"tok-abc-789"}' });
    const req3 = makeRequest({ url: 'https://api.example.com/action', method: 'POST',
                               headers: { 'X-Session': 'tok-abc-789' }, responseBody: '{"done":true}' });

    const capturedRequests = [req0, req1, req2, req3];

    // toFlowSteps drops req1 (5xx) → 3 steps: [step0, step2, step3]
    const rawSteps = toFlowSteps(capturedRequests);
    // sanity: confirm filtering happened so the index mismatch is in play
    expect(rawSteps).toHaveLength(3);

    // Gemini's response uses indices from the UNFILTERED array:
    //   sourceStepIndex=2 → req2 (the /auth response with session_token)
    //   usedInStepIndices=[3] → req3 (the /action request using X-Session header)
    mock.mockResolvedValueOnce(JSON.stringify({
      correlations: [{
        sourceStepIndex: 2,          // unfiltered index → req2
        variableName: 'session_token',
        source: 'jsonpath',
        expression: '$.session_token',
        usedInStepIndices: [3],      // unfiltered index → req3
      }],
    }));

    const result = await detectCorrelations(capturedRequests, rawSteps);

    // Desired: the extract rule should land on result[1] — the filtered step
    // corresponding to req2 (the /auth response, filtered index 1).
    // Current: applyCorrelations uses sourceStepIndex=2 to index into result[]
    // (filtered), so the rule goes to result[2] (the step for req3 — WRONG);
    // and usedInStepIndices=[3] is silently dropped because 3 >= result.length.
    expect(result[1].extract).toHaveProperty('session_token');
  });
});

// ─── Finding #5: correlatorRateLimited is a racy global singleton ─────────────
//
// correlator.ts:260: export let correlatorRateLimited = false;
//
// Every concurrent recording session reads and writes the same module-level
// boolean. Session A's success (correlatorRateLimited = false) can clobber
// session B's rate-limited flag (set to true), silently hiding B's failure in
// the _completed result that finishSession stores and the UI reads.

describe('Finding #5 — correlatorRateLimited global singleton race', () => {
  it.fails('a successful session does not clobber a rate-limited session\'s flag', async () => {
    const mock = await getMock();

    // Control execution order:
    //   Session B → rate-limited (rejects immediately → finishes first)
    //   Session A → succeeds (delayed via a deferred promise → finishes second)
    // After both settle: if the flag is a global singleton, A's success resets it
    // to false even though B was rate-limited during this same window.
    let resolveA!: (v: string) => void;
    const aInnerPromise = new Promise<string>(r => { resolveA = r; });

    mock
      .mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error('quota exceeded'), { status: 429 }))
      )
      .mockImplementationOnce(() => aInnerPromise);

    const twoRequests = [makeRequest(), makeRequest()];
    const twoSteps = [
      makeStep('x', 'https://api.example.com/x'),
      makeStep('y', 'https://api.example.com/y'),
    ];

    // Start both sessions concurrently
    const sessionBPromise = detectCorrelations(twoRequests, twoSteps);
    const sessionAPromise = detectCorrelations(twoRequests, twoSteps);

    // B's mock rejects immediately; wait for it to settle
    // → correlatorRateLimited = true (B was rate-limited)
    await sessionBPromise;

    // Now let A complete with a success
    // → correlatorRateLimited = false (clobbers B's rate-limited state)
    resolveA('{"correlations":[]}');
    await sessionAPromise;

    // Desired: B's rate-limited state should be preserved per-session, not clobbered
    // by A's success. A correct implementation would track this per-session.
    // Current: the global singleton is false (A reset it), hiding B's failure.
    expect(correlatorModule.correlatorRateLimited).toBe(true);
  });
});

// ─── Finding #6: 429/quota detection is an unanchored substring match ─────────
//
// correlator.ts:418:
//   if (status === 429 || msg.includes('429') || msg.includes('quota')) { ... }
//
// msg.includes('429') matches any error text that contains the digit sequence
// "429" anywhere — including port numbers (":3429"), byte counts ("3429 bytes"),
// timing strings ("3429ms"). This falsely flips correlatorRateLimited and the
// /health Gemini status for an unrelated transient error.

describe('Finding #6 — unanchored 429 substring match misclassifies unrelated errors', () => {
  it.fails('error "request failed after 3429ms" is not classified as a rate limit', async () => {
    const mock = await getMock();

    // Run a success first to guarantee the flag starts false regardless of other
    // tests' side-effects (the mock default from beforeEach provides the response).
    await detectCorrelations(
      [makeRequest(), makeRequest()],
      [makeStep('p', 'https://api.example.com/p'), makeStep('q', 'https://api.example.com/q')],
    );
    // Flag should be false after a success
    expect(correlatorModule.correlatorRateLimited).toBe(false);

    // Now inject an ambiguous error: contains "429" but is a timing value, not a
    // 429 HTTP status code.
    mock.mockRejectedValueOnce(new Error('upstream request failed after 3429ms'));
    await detectCorrelations(
      [makeRequest(), makeRequest()],
      [makeStep('a', 'https://api.example.com/a'), makeStep('b', 'https://api.example.com/b')],
    );

    // Desired: "3429ms" should NOT be classified as an HTTP 429 rate-limit.
    // Current: msg.includes('429') matches "3429ms" → correlatorRateLimited = true.
    expect(correlatorModule.correlatorRateLimited).toBe(false);
  });
});

// ─── Finding #7: Pino redact list is a copy-paste with no recorder-specific paths
//
// services/recorder-service/src/logger.ts:
//   const SENSITIVE_PATHS = ['envVars', 'testData', 'csvData'];
//
// These paths are identical to every other service's logger config. None of them
// appear in recorder-service's structured log messages. If a future debug log
// statement accidentally includes a captured request's auth header or response
// body, it will appear in plaintext — the redact list provides no protection.

describe('Finding #7 — Pino redact list covers no recorder-specific fields', () => {
  it.fails('logger redact paths include recorder-specific sensitive fields', () => {
    // Recreate the exact logger configuration from logger.ts using a captured
    // stream so we can inspect what reaches the log output.
    const logLines: string[] = [];
    const dest = new Writable({
      write(chunk: Buffer, _encoding: BufferEncoding, cb: () => void) {
        logLines.push(chunk.toString());
        cb();
      },
    });

    const testLog = pino(
      {
        level: 'info',
        base: { service: 'recorder-service' },
        // These are the CURRENT sensitive paths from logger.ts —
        // none of them are relevant to recorder-service's domain.
        redact: { paths: ['envVars', 'testData', 'csvData'], censor: '[REDACTED]' },
      },
      dest,
    );

    // Simulate a structured log entry that might appear in recorder-service
    // if a debug statement logged a captured request's auth header.
    const capturedSecret = 'Bearer supersecret-auth-token-xyz';
    testLog.info(
      { requestHeaders: { authorization: capturedSecret } },
      'Captured request',
    );

    const output = logLines.join('');

    // Desired: 'requestHeaders.authorization' (or 'requestHeaders') should be in
    // the redact paths so captured auth tokens never appear in logs.
    // Current: only 'envVars'/'testData'/'csvData' are redacted — none of which
    // ever appear in recorder-service logs — so capturedSecret appears in plaintext.
    expect(output).not.toContain('supersecret-auth-token-xyz');
  });
});
