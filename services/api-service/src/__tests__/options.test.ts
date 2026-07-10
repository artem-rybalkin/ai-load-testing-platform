import { describe, it, expect } from 'vitest';
import { buildK6Options, replaceK6Options } from '../options';

// ─── replaceK6Options ─────────────────────────────────────────────────────────

describe('replaceK6Options', () => {
  it('replaces a simple options block', () => {
    const script = [
      "import http from 'k6/http';",
      'export const options = {',
      '  vus: 5,',
      "  duration: '30s',",
      '};',
      'export default function() { http.get("http://test.com"); }',
    ].join('\n');

    const result = replaceK6Options(script, '{"vus":10,"duration":"60s"}');

    expect(result).toContain('export const options = {"vus":10,"duration":"60s"};');
    expect(result).not.toContain('vus: 5');
    expect(result).toContain('export default function');
  });

  it('replaces options block with nested stages array', () => {
    const script = [
      'export const options = {',
      '  stages: [',
      '    { duration: "30s", target: 10 },',
      '    { duration: "1m", target: 10 },',
      '  ],',
      '  thresholds: { http_req_duration: ["p(95)<1000"] },',
      '};',
    ].join('\n');

    const newJson = '{"stages":[{"duration":"1m","target":20}]}';
    const result = replaceK6Options(script, newJson);

    expect(result).toBe(`export const options = ${newJson};`);
    const parsed = JSON.parse(newJson);
    expect(parsed.stages).toHaveLength(1);
    expect(parsed.stages[0].target).toBe(20);
  });

  it('returns the script unchanged when there is no options block', () => {
    const script = "import http from 'k6/http';\nexport default function() {}";

    const result = replaceK6Options(script, '{"vus":5}');

    expect(result).toBe(script);
  });

  it('handles deeply nested thresholds object correctly', () => {
    const script = [
      'export const options = {',
      '  thresholds: {',
      "    http_req_duration: ['p(95)<1000'],",
      "    http_req_failed: ['rate<0.01'],",
      '  },',
      '};',
    ].join('\n');

    const newJson = '{"thresholds":{"http_req_duration":["p(95)<500"]}}';
    const result = replaceK6Options(script, newJson);

    expect(result).toBe(`export const options = ${newJson};`);
  });

  it('does not duplicate the semicolon when original has a trailing semicolon', () => {
    const script = 'export const options = { vus: 5 };\n// rest of script';

    const result = replaceK6Options(script, '{"vus":10}');

    expect(result).toContain('export const options = {"vus":10};');
    expect(result).not.toContain(';;');
    expect(result).toContain('// rest of script');
  });
});

// ─── buildK6Options ───────────────────────────────────────────────────────────

describe('buildK6Options', () => {
  it('spike profile produces 6 stages with the specified peakVus', () => {
    const result = buildK6Options({ vus: 10, duration: '30s', profile: 'spike', peakVus: 100 });
    const parsed = JSON.parse(result);

    expect(parsed.stages).toHaveLength(6);
    const peakTargets = parsed.stages.filter((s: { target: number }) => s.target === 100);
    expect(peakTargets.length).toBeGreaterThan(0);
  });

  it('capacity profile produces 2 stages ramping to peakVus', () => {
    const result = buildK6Options({ vus: 10, duration: '5m', profile: 'capacity', peakVus: 50 });
    const parsed = JSON.parse(result);

    expect(parsed.stages).toHaveLength(2);
    expect(parsed.stages[0].target).toBe(50);
    expect(parsed.stages[1].target).toBe(0);
  });

  it('load profile produces 3 stages with plateau at vus', () => {
    const result = buildK6Options({ vus: 20, duration: '2m', profile: 'load' });
    const parsed = JSON.parse(result);

    expect(parsed.stages).toHaveLength(3);
    expect(parsed.stages[1].target).toBe(20);
    expect(parsed.stages[1].duration).toBe('2m');
  });

  it('defaults peakVus to vus * 10 when not provided', () => {
    const result = buildK6Options({ vus: 5, duration: '30s', profile: 'spike' });
    const parsed = JSON.parse(result);

    const peakTargets = parsed.stages.filter((s: { target: number }) => s.target === 50);
    expect(peakTargets.length).toBeGreaterThan(0);
  });

  it('produces valid JSON with stages and thresholds for every profile', () => {
    const profiles = ['load', 'spike', 'capacity', 'soak'] as const;

    for (const profile of profiles) {
      const result = buildK6Options({ vus: 10, duration: '1m', profile });

      expect(() => JSON.parse(result)).not.toThrow();
      const parsed = JSON.parse(result);
      expect(Array.isArray(parsed.stages)).toBe(true);
      expect(parsed.thresholds).toBeDefined();
    }
  });

  it('includes a checks threshold for every profile, so cached-script re-injection (findExistingScript) never drops it', () => {
    const profiles = ['load', 'spike', 'capacity', 'soak'] as const;

    for (const profile of profiles) {
      const result = buildK6Options({ vus: 10, duration: '1m', profile });
      const parsed = JSON.parse(result);
      expect(parsed.thresholds.checks).toEqual(['rate>0.9']);
    }
  });

  it('capacity profile aborts early on a threshold breach instead of running the full duration', () => {
    const result = buildK6Options({ vus: 10, duration: '5m', profile: 'capacity' });
    const parsed = JSON.parse(result);

    expect(parsed.thresholds.http_req_duration).toEqual([
      { threshold: 'p(95)<2000', abortOnFail: true, delayAbortEval: '10s' },
    ]);
    expect(parsed.thresholds.http_req_failed).toEqual([
      { threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '10s' },
    ]);
  });

  it('non-capacity profiles keep plain-string thresholds — no abortOnFail', () => {
    const profiles = ['load', 'spike', 'soak'] as const;

    for (const profile of profiles) {
      const result = buildK6Options({ vus: 10, duration: '1m', profile });
      const parsed = JSON.parse(result);
      expect(typeof parsed.thresholds.http_req_duration[0]).toBe('string');
      expect(typeof parsed.thresholds.http_req_failed[0]).toBe('string');
    }
  });
});

// ─── buildK6Options — httpOptions ─────────────────────────────────────────────

describe('buildK6Options — httpOptions', () => {
  it('includes discardResponseBodies when set', () => {
    const result = buildK6Options({ vus: 5, duration: '30s', httpOptions: { discardResponseBodies: true } });
    const parsed = JSON.parse(result);
    expect(parsed.discardResponseBodies).toBe(true);
  });

  it('does not include discardResponseBodies when httpOptions is absent', () => {
    const result = buildK6Options({ vus: 5, duration: '30s' });
    const parsed = JSON.parse(result);
    expect(parsed.discardResponseBodies).toBeUndefined();
  });

  it('combines httpOptions with load profile stages', () => {
    const result = buildK6Options({ vus: 5, duration: '30s', profile: 'soak', httpOptions: { discardResponseBodies: true } });
    const parsed = JSON.parse(result);
    expect(Array.isArray(parsed.stages)).toBe(true);
    expect(parsed.discardResponseBodies).toBe(true);
  });
});
