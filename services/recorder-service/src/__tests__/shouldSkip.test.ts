/**
 * Unit tests for recorder-service shouldSkip / compileIgnorePatterns (L2).
 * These are pure functions with no external dependencies.
 */
import { describe, it, expect } from 'vitest';
import { compileIgnorePatterns, shouldSkip } from '../recorder';

// ─── compileIgnorePatterns ────────────────────────────────────────────────────

describe('compileIgnorePatterns', () => {
  it('returns an empty array for an empty input', () => {
    expect(compileIgnorePatterns([])).toEqual([]);
  });

  it('filters out blank strings', () => {
    expect(compileIgnorePatterns(['', '  ', '\t'])).toEqual([]);
  });

  it('converts a plain string to a substring-match RegExp', () => {
    const [re] = compileIgnorePatterns(['analytics.example.com']);
    expect(re.test('https://analytics.example.com/track')).toBe(true);
    expect(re.test('https://other.com')).toBe(false);
  });

  it('escapes regex special characters in plain strings', () => {
    const [re] = compileIgnorePatterns(['a.b.c']); // dots are literal
    expect(re.test('a.b.c')).toBe(true);
    expect(re.test('axbxc')).toBe(false); // dots not wildcarded
  });

  it('treats /pattern/ as a regex literal', () => {
    const [re] = compileIgnorePatterns(['/track(event|pageview)/']);
    expect(re.test('https://cdn.com/trackevent?q=1')).toBe(true);
    expect(re.test('https://cdn.com/trackpageview')).toBe(true);
    expect(re.test('https://cdn.com/other')).toBe(false);
  });

  it('applies regex flags when specified', () => {
    const [re] = compileIgnorePatterns(['/ANALYTICS/i']);
    expect(re.test('https://analytics.example.com')).toBe(true);
  });

  it('filters out invalid regex patterns instead of throwing', () => {
    const patterns = compileIgnorePatterns(['/[invalid/']);
    expect(patterns).toHaveLength(0); // invalid regex is silently dropped
  });

  it('handles multiple patterns and returns all valid ones', () => {
    const patterns = compileIgnorePatterns([
      'analytics.example.com',
      '/^https:\\/\\/cdn\\./i',
      '/[bad regex/',  // invalid — dropped
      '',              // blank — dropped
    ]);
    expect(patterns).toHaveLength(2);
    expect(patterns[0].test('https://analytics.example.com/x')).toBe(true);
    expect(patterns[1].test('https://cdn.example.com/x')).toBe(true);
  });

  it('trims whitespace from each pattern before compiling', () => {
    const [re] = compileIgnorePatterns(['  sentry.io  ']);
    expect(re.test('https://sentry.io/api/store/')).toBe(true);
  });
});

// ─── shouldSkip — SKIP_SCHEMES ────────────────────────────────────────────────

describe('shouldSkip — SKIP_SCHEMES', () => {
  it('skips data: URLs', () => {
    expect(shouldSkip('data:image/png;base64,AAAA', '', [])).toBe(true);
  });

  it('skips blob: URLs', () => {
    expect(shouldSkip('blob:https://example.com/uuid', '', [])).toBe(true);
  });

  it('skips chrome-extension: URLs', () => {
    expect(shouldSkip('chrome-extension://abcdefg/content.js', '', [])).toBe(true);
  });

  it('skips about: URLs', () => {
    expect(shouldSkip('about:blank', '', [])).toBe(true);
  });

  it('does NOT skip a normal https: URL', () => {
    expect(shouldSkip('https://api.example.com/users', '', [])).toBe(false);
  });

  it('matches scheme case-insensitively', () => {
    expect(shouldSkip('DATA:text/plain,hello', '', [])).toBe(true);
  });
});

// ─── shouldSkip — SKIP_EXTENSIONS ─────────────────────────────────────────────

describe('shouldSkip — SKIP_EXTENSIONS', () => {
  it.each([
    'https://cdn.example.com/logo.png',
    'https://cdn.example.com/photo.jpg',
    'https://cdn.example.com/photo.jpeg',
    'https://cdn.example.com/icon.gif',
    'https://cdn.example.com/icon.svg',
    'https://cdn.example.com/favicon.ico',
    'https://cdn.example.com/app.js',
    'https://cdn.example.com/app.mjs',
    'https://cdn.example.com/styles.css',
    'https://cdn.example.com/font.woff',
    'https://cdn.example.com/font.woff2',
    'https://cdn.example.com/font.ttf',
    'https://cdn.example.com/font.eot',
    'https://cdn.example.com/image.webp',
    'https://cdn.example.com/image.avif',
    'https://cdn.example.com/clip.mp4',
    'https://cdn.example.com/song.mp3',
    'https://cdn.example.com/doc.pdf',
  ])('skips static asset extension in %s', (url) => {
    expect(shouldSkip(url, '', [])).toBe(true);
  });

  it('skips an asset URL even with a query string appended', () => {
    expect(shouldSkip('https://cdn.example.com/logo.png?v=2&cache=1', '', [])).toBe(true);
  });

  it('matches extensions case-insensitively', () => {
    expect(shouldSkip('https://cdn.example.com/LOGO.PNG', '', [])).toBe(true);
  });

  it('does NOT skip an API endpoint with no static extension', () => {
    expect(shouldSkip('https://api.example.com/users/42', '', [])).toBe(false);
  });

  it('does NOT skip a path that merely contains an asset extension as a substring', () => {
    expect(shouldSkip('https://api.example.com/pngconverter', '', [])).toBe(false);
  });
});

// ─── shouldSkip — SKIP_CONTENT_TYPES ──────────────────────────────────────────

describe('shouldSkip — SKIP_CONTENT_TYPES', () => {
  it('skips text/css content-type', () => {
    expect(shouldSkip('https://api.example.com/dynamic', 'text/css', [])).toBe(true);
  });

  it('skips application/javascript content-type', () => {
    expect(shouldSkip('https://api.example.com/dynamic', 'application/javascript', [])).toBe(true);
  });

  it('skips any font/* content-type', () => {
    expect(shouldSkip('https://api.example.com/dynamic', 'font/woff2', [])).toBe(true);
  });

  it('skips any image/* content-type', () => {
    expect(shouldSkip('https://api.example.com/dynamic', 'image/webp', [])).toBe(true);
  });

  it('does NOT skip application/json content-type', () => {
    expect(shouldSkip('https://api.example.com/dynamic', 'application/json', [])).toBe(false);
  });

  it('does NOT skip text/html content-type', () => {
    expect(shouldSkip('https://api.example.com/dynamic', 'text/html', [])).toBe(false);
  });

  it('ignores content-type check when contentType is an empty string', () => {
    expect(shouldSkip('https://api.example.com/dynamic', '', [])).toBe(false);
  });
});

// ─── shouldSkip — ignorePatterns integration ──────────────────────────────────

describe('shouldSkip — user ignorePatterns', () => {
  it('skips a URL matching a compiled user ignore pattern', () => {
    const patterns = compileIgnorePatterns(['analytics.example.com']);
    expect(shouldSkip('https://analytics.example.com/collect', '', patterns)).toBe(true);
  });

  it('does not skip a URL matching none of the ignore patterns', () => {
    const patterns = compileIgnorePatterns(['analytics.example.com']);
    expect(shouldSkip('https://api.example.com/users', '', patterns)).toBe(false);
  });

  it('checks scheme/extension/content-type before falling through to ignorePatterns', () => {
    // matches SKIP_EXTENSIONS regardless of an (empty) ignorePatterns list
    expect(shouldSkip('https://cdn.example.com/logo.png', '', [])).toBe(true);
  });
});

// ─── compileIgnorePatterns — edge cases ───────────────────────────────────────

describe('compileIgnorePatterns — edge cases', () => {
  it('handles a regex with no flags', () => {
    const [re] = compileIgnorePatterns(['/track/']);
    expect(re.flags).toBe('');
    expect(re.test('tracking')).toBe(true);
  });

  it('handles a regex with multiple flags', () => {
    const [re] = compileIgnorePatterns(['/test/gi']);
    expect(re.flags).toContain('g');
    expect(re.flags).toContain('i');
  });

  it('a plain string with slashes is treated as a substring matcher (not regex)', () => {
    // "/path/to/" without the outer /…/ delimiter pattern → treated as plain string
    const [re] = compileIgnorePatterns(['path/to']);
    // The / and . are literal — the plain string escaper turns '/' to '\/'? No:
    // only regex special chars are escaped. '/' is not a special char in JS regex.
    expect(re.test('https://example.com/path/to/resource')).toBe(true);
  });

  it('very long ignore list compiles without error', () => {
    const patterns = Array.from({ length: 100 }, (_, i) => `domain${i}.example.com`);
    const compiled = compileIgnorePatterns(patterns);
    expect(compiled).toHaveLength(100);
    expect(compiled[42].test('https://domain42.example.com/api')).toBe(true);
  });
});
