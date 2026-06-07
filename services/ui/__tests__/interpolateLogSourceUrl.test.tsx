// @vitest-environment node
import { describe, it, expect } from 'vitest';

// Import the actual function — it's a pure utility with no side effects
// We import from the built module; vitest resolves the @/ alias
import { interpolateLogSourceUrl } from '../lib/api';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const fixedDate = new Date('2026-06-01T12:00:00.000Z');
const fixedMs   = fixedDate.getTime(); // 1748779200000

const makeResult = (overrides: {
  test_id?: string;
  target_url?: string;
  started_at?: string | null;
  completed_at?: string | null;
} = {}) => ({
  test_id:      overrides.test_id      ?? 'abc-123-def-456',
  target_url:   overrides.target_url   ?? 'https://api.example.com',
  started_at:   overrides.started_at   !== undefined ? overrides.started_at : fixedDate.toISOString(),
  completed_at: overrides.completed_at !== undefined ? overrides.completed_at : new Date(fixedMs + 60_000).toISOString(),
});

// ─── {testId} ────────────────────────────────────────────────────────────────

describe('interpolateLogSourceUrl — {testId}', () => {
  it('replaces {testId} with the test UUID', () => {
    const result = interpolateLogSourceUrl(
      'https://logs.example.com?test={testId}',
      makeResult()
    );
    expect(result).toBe('https://logs.example.com?test=abc-123-def-456');
  });

  it('replaces multiple occurrences of {testId}', () => {
    const result = interpolateLogSourceUrl(
      'https://logs.example.com/{testId}/detail?ref={testId}',
      makeResult()
    );
    expect(result).toBe('https://logs.example.com/abc-123-def-456/detail?ref=abc-123-def-456');
  });
});

// ─── {targetUrl} and {targetUrlEncoded} ──────────────────────────────────────

describe('interpolateLogSourceUrl — target URL variables', () => {
  it('inserts raw target URL with {targetUrl}', () => {
    const result = interpolateLogSourceUrl(
      'https://logs.example.com?site={targetUrl}',
      makeResult({ target_url: 'https://api.example.com/v2' })
    );
    expect(result).toBe('https://logs.example.com?site=https://api.example.com/v2');
  });

  it('URL-encodes target URL with {targetUrlEncoded}', () => {
    const result = interpolateLogSourceUrl(
      'https://logs.example.com?site={targetUrlEncoded}',
      makeResult({ target_url: 'https://api.example.com/v2?debug=true' })
    );
    expect(result).toContain(encodeURIComponent('https://api.example.com/v2?debug=true'));
  });

  it('handles target URLs with special characters', () => {
    const result = interpolateLogSourceUrl(
      '{targetUrlEncoded}',
      makeResult({ target_url: 'https://example.com/path?a=1&b=2' })
    );
    expect(result).toBe(encodeURIComponent('https://example.com/path?a=1&b=2'));
  });
});

// ─── Timestamp variables — epoch ms ──────────────────────────────────────────

describe('interpolateLogSourceUrl — {startedAtMs} / {completedAtMs}', () => {
  it('inserts started_at as epoch milliseconds', () => {
    const result = interpolateLogSourceUrl(
      'https://grafana.example.com/explore?from={startedAtMs}',
      makeResult({ started_at: fixedDate.toISOString() })
    );
    expect(result).toBe(`https://grafana.example.com/explore?from=${fixedMs}`);
  });

  it('inserts completed_at as epoch milliseconds', () => {
    const endMs = fixedMs + 60_000;
    const result = interpolateLogSourceUrl(
      'https://grafana.example.com/explore?to={completedAtMs}',
      makeResult({ completed_at: new Date(endMs).toISOString() })
    );
    expect(result).toBe(`https://grafana.example.com/explore?to=${endMs}`);
  });

  it('Grafana-style URL with both timestamps', () => {
    const endMs = fixedMs + 300_000;
    const result = interpolateLogSourceUrl(
      'https://grafana.example.com/explore?from={startedAtMs}&to={completedAtMs}',
      makeResult({
        started_at:   fixedDate.toISOString(),
        completed_at: new Date(endMs).toISOString(),
      })
    );
    expect(result).toBe(`https://grafana.example.com/explore?from=${fixedMs}&to=${endMs}`);
  });
});

// ─── Timestamp variables — ISO 8601 ──────────────────────────────────────────

describe('interpolateLogSourceUrl — {startedAtISO} / {completedAtISO}', () => {
  it('inserts started_at as ISO string', () => {
    const iso = fixedDate.toISOString();
    const result = interpolateLogSourceUrl(
      "from='{startedAtISO}'",
      makeResult({ started_at: iso })
    );
    expect(result).toBe(`from='${iso}'`);
  });

  it('inserts completed_at as ISO string', () => {
    const end = new Date(fixedMs + 60_000).toISOString();
    const result = interpolateLogSourceUrl(
      "to='{completedAtISO}'",
      makeResult({ completed_at: end })
    );
    expect(result).toBe(`to='${end}'`);
  });

  it('Kibana-style URL using ISO timestamps', () => {
    const start = fixedDate.toISOString();
    const end   = new Date(fixedMs + 60_000).toISOString();
    const result = interpolateLogSourceUrl(
      "https://kibana.example.com/app/discover#/?_g=(time:(from:'{startedAtISO}',to:'{completedAtISO}'))",
      makeResult({ started_at: start, completed_at: end })
    );
    expect(result).toBe(
      `https://kibana.example.com/app/discover#/?_g=(time:(from:'${start}',to:'${end}'))`
    );
  });
});

// ─── Fallback when timestamps are null ───────────────────────────────────────

describe('interpolateLogSourceUrl — null / missing timestamps', () => {
  it('falls back to current time when started_at is null', () => {
    const before = Date.now();
    const result = interpolateLogSourceUrl(
      '{startedAtMs}',
      makeResult({ started_at: null })
    );
    const after = Date.now();
    const ms = Number(result);
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });

  it('falls back to current time when completed_at is null', () => {
    const before = Date.now();
    const result = interpolateLogSourceUrl(
      '{completedAtMs}',
      makeResult({ completed_at: null })
    );
    const after = Date.now();
    const ms = Number(result);
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });
});

// ─── Templates with no variables ─────────────────────────────────────────────

describe('interpolateLogSourceUrl — static templates', () => {
  it('returns template unchanged when it contains no variables', () => {
    const template = 'https://logs.example.com/static-dashboard';
    const result = interpolateLogSourceUrl(template, makeResult());
    expect(result).toBe(template);
  });

  it('handles empty template string', () => {
    const result = interpolateLogSourceUrl('', makeResult());
    expect(result).toBe('');
  });
});

// ─── All variables combined ───────────────────────────────────────────────────

describe('interpolateLogSourceUrl — all variables', () => {
  it('replaces all 7 variables in a single template', () => {
    const start = fixedDate.toISOString();
    const endMs  = fixedMs + 60_000;
    const end   = new Date(endMs).toISOString();
    const result = interpolateLogSourceUrl(
      '{startedAtMs}|{completedAtMs}|{startedAtISO}|{completedAtISO}|{targetUrl}|{targetUrlEncoded}|{testId}',
      makeResult({ started_at: start, completed_at: end })
    );
    const parts = result.split('|');
    expect(parts[0]).toBe(String(fixedMs));
    expect(parts[1]).toBe(String(endMs));
    expect(parts[2]).toBe(start);
    expect(parts[3]).toBe(end);
    expect(parts[4]).toBe('https://api.example.com');
    expect(parts[5]).toBe(encodeURIComponent('https://api.example.com'));
    expect(parts[6]).toBe('abc-123-def-456');
  });
});
