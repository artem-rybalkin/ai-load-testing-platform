/**
 * Regression tests for two confirmed-live bugs in validateSsrfSafeUrl
 * (packages/shared/src/index.ts:704-716), documented in TODO.md findings #1-#2.
 *
 * Each test is wrapped in it.fails() because the current implementation does NOT
 * yet block these URLs — the tests assert the DESIRED (fixed) behavior, and
 * it.fails() marks them as expected-to-fail so the suite stays green while the
 * bugs remain open.  When a fix lands, the .fails wrapper will start making
 * these tests report "unexpected pass" — that is the signal to flip them back to
 * plain it() and remove this note.
 *
 * DO NOT use .skip or .todo — those don't actually exercise the assertion.
 */
import { describe, it, expect } from 'vitest';
import { validateSsrfSafeUrl } from '../index';

// ── Finding #1: IPv6 literals are not checked at all ─────────────────────────
// The blocklist regexes (SSRF_BLOCKED_HOSTNAME_RE, SSRF_PRIVATE_IPV4_RE) only
// match dotted-decimal IPv4 and named hostnames.  Bracketed IPv6 addresses are
// passed through to the caller as "safe".
//
// Node.js / WHATWG URL gives these hostnames:
//   http://[::1]/                      → "[::1]"
//   http://[fc00::1]/                  → "[fc00::1]"
//   http://[fe80::1]/                  → "[fe80::1]"
//   http://[::ffff:169.254.169.254]/   → "[::ffff:a9fe:a9fe]" (URL normalises the embedded decimal IPv4)
// None of these match any existing blocklist pattern.

describe('validateSsrfSafeUrl – IPv6 regression (TODO.md finding #1)', () => {
  it.fails('blocks loopback IPv6 literal http://[::1]/', () => {
    // Current buggy return: null (treated as safe).
    // Fixed return: a non-null error string.
    expect(validateSsrfSafeUrl('http://[::1]/')).not.toBeNull();
  });

  it.fails('blocks unique-local IPv6 literal http://[fc00::1]/', () => {
    expect(validateSsrfSafeUrl('http://[fc00::1]/')).not.toBeNull();
  });

  it.fails('blocks link-local IPv6 literal http://[fe80::1]/', () => {
    expect(validateSsrfSafeUrl('http://[fe80::1]/')).not.toBeNull();
  });

  it.fails('blocks IPv4-mapped IPv6 literal that reaches cloud metadata http://[::ffff:169.254.169.254]/', () => {
    // The URL constructor normalises the embedded decimal IPv4 octets to hex
    // (hostname becomes "[::ffff:a9fe:a9fe]"), but the address still maps to
    // 169.254.169.254 and is still unrestricted by the current validator.
    expect(validateSsrfSafeUrl('http://[::ffff:169.254.169.254]/')).not.toBeNull();
  });
});

// ── Finding #2: Trailing-dot hostname bypass ──────────────────────────────────
// validateSsrfSafeUrl lowercases the hostname but never strips a trailing dot.
// DNS / the OS resolver treats "localhost." identically to "localhost", so
// http://localhost./ resolves to 127.0.0.1.  However, the hostname string seen
// by the blocklist regex is "localhost." (with the dot), which does not satisfy
// the anchored pattern ^(localhost|...)$ — the trailing dot is past the $.

describe('validateSsrfSafeUrl – trailing-dot bypass regression (TODO.md finding #2)', () => {
  it.fails('blocks http://localhost./ (FQDN trailing-dot bypass for localhost)', () => {
    // Current buggy return: null (treated as safe).
    // Fixed return: a non-null error string.
    expect(validateSsrfSafeUrl('http://localhost./')).not.toBeNull();
  });
});
