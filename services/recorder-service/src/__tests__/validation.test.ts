import { describe, it, expect, vi } from 'vitest';

// puppeteer-core is a native-binary dep that can't run in the Vitest Node environment.
// index.ts imports recorder.ts (which imports puppeteer-core) at module load time,
// so we mock it the same way as recorder.test.ts / correlator.test.ts.
vi.mock('puppeteer-core', () => ({ default: {} }));

import { validateRecorderUrl } from '../index';

// ─── validateRecorderUrl — SSRF blocklist ─────────────────────────────────────

describe('validateRecorderUrl', () => {
  describe('blocked hostnames', () => {
    it('blocks localhost', () => {
      expect(validateRecorderUrl('http://localhost/')).toMatch(/blocked internal hostname/);
    });

    it('blocks 127.0.0.1', () => {
      expect(validateRecorderUrl('http://127.0.0.1/')).toMatch(/private\/internal IP range/);
    });

    it('blocks 0.0.0.0', () => {
      expect(validateRecorderUrl('http://0.0.0.0/')).toMatch(/private\/internal IP range/);
    });

    it('blocks *.local hostnames', () => {
      expect(validateRecorderUrl('http://myhost.local/')).toMatch(/blocked internal hostname/);
    });

    it('blocks *.internal hostnames', () => {
      expect(validateRecorderUrl('http://service.internal/')).toMatch(/blocked internal hostname/);
    });

    it('blocks host.docker.internal', () => {
      expect(validateRecorderUrl('http://host.docker.internal/')).toMatch(/blocked internal hostname/);
    });

    it('blocks metadata.google.internal', () => {
      expect(validateRecorderUrl('http://metadata.google.internal/')).toMatch(/blocked internal hostname/);
    });

    it('blocks hostnames case-insensitively', () => {
      expect(validateRecorderUrl('http://LOCALHOST/')).toMatch(/blocked internal hostname/);
    });
  });

  describe('blocked private IPv4 ranges', () => {
    it('blocks 10.x.x.x range', () => {
      expect(validateRecorderUrl('http://10.0.0.1/')).toMatch(/private\/internal IP range/);
      expect(validateRecorderUrl('http://10.255.255.255/')).toMatch(/private\/internal IP range/);
    });

    it('blocks 192.168.x.x range', () => {
      expect(validateRecorderUrl('http://192.168.1.1/')).toMatch(/private\/internal IP range/);
      expect(validateRecorderUrl('http://192.168.0.0/')).toMatch(/private\/internal IP range/);
    });

    it('blocks 172.16.0.0 - 172.31.255.255 range', () => {
      expect(validateRecorderUrl('http://172.16.0.0/')).toMatch(/private\/internal IP range/);
      expect(validateRecorderUrl('http://172.20.5.5/')).toMatch(/private\/internal IP range/);
      expect(validateRecorderUrl('http://172.31.255.255/')).toMatch(/private\/internal IP range/);
    });

    it('boundary: 172.15.x.x is NOT in the blocked private range', () => {
      expect(validateRecorderUrl('http://172.15.0.1/')).toBeNull();
    });

    it('boundary: 172.32.x.x is NOT in the blocked private range', () => {
      expect(validateRecorderUrl('http://172.32.0.1/')).toBeNull();
    });

    it('blocks link-local 169.254.x.x range', () => {
      expect(validateRecorderUrl('http://169.254.169.254/')).toMatch(/private\/internal IP range/);
    });

    it('blocks 127.x.x.x loopback range generally', () => {
      expect(validateRecorderUrl('http://127.0.0.2/')).toMatch(/private\/internal IP range/);
      expect(validateRecorderUrl('http://127.255.255.255/')).toMatch(/private\/internal IP range/);
    });
  });

  describe('valid public URLs', () => {
    it('allows a valid public https URL', () => {
      expect(validateRecorderUrl('https://example.com')).toBeNull();
    });

    it('allows a valid public http URL', () => {
      expect(validateRecorderUrl('http://example.com/path?query=1')).toBeNull();
    });

    it('allows a public IPv4 address', () => {
      expect(validateRecorderUrl('http://93.184.216.34/')).toBeNull();
    });

    it('allows a subdomain of a public domain', () => {
      expect(validateRecorderUrl('https://api.example.com')).toBeNull();
    });
  });

  describe('protocol and parsing validation', () => {
    it('rejects an invalid URL', () => {
      expect(validateRecorderUrl('not a url')).toBe('Invalid URL');
    });

    it('rejects non-http(s) protocols', () => {
      expect(validateRecorderUrl('ftp://example.com')).toMatch(/must use http or https/);
    });

    it('rejects file:// protocol', () => {
      expect(validateRecorderUrl('file:///etc/passwd')).toMatch(/must use http or https/);
    });
  });
});
