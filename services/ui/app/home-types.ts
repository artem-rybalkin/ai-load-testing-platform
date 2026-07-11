export type HomeTestType = 'backend' | 'client-side' | 'flow';
export type LoadProfile = 'load' | 'spike' | 'capacity' | 'soak' | 'realistic';

export interface EnvVar { key: string; value: string }

export interface HomeFormState {
  type: HomeTestType;
  targetUrl: string;
  description: string;
  vus: number;
  peakVus: number;
  sessions: number;
  duration: string;
  rampUp: string;
  collectWebVitals: boolean;
  device: string; // Puppeteer KnownDevices key, e.g. 'iPhone 13'; '' = no emulation (desktop)
  profile: LoadProfile;
  httpKeepAlive: boolean;
  httpTimeout: string;
  httpDiscardBodies: boolean;
  setupFirstStep: boolean;
}

export interface Thresholds {
  p95: string; avg: string; errorRate: string; serverErrorRate: string; timeoutRate: string;
  lcp: string; fcp: string; ttfb: string; cls: string; inp: string; tbt: string;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  p95: '1000', avg: '500', errorRate: '1', serverErrorRate: '1', timeoutRate: '1',
  lcp: '2500', fcp: '1800', ttfb: '800', cls: '0.1', inp: '200', tbt: '200',
};

export const DURATION_OPTIONS = ['30s', '1m', '2m', '3m', '5m', '10m', '30m'];

// Curated subset of Puppeteer's KnownDevices — '' means no emulation (desktop viewport).
export const DEVICE_OPTIONS = [
  { id: '', label: 'Desktop (no emulation)' },
  { id: 'iPhone 13', label: 'iPhone 13' },
  { id: 'iPhone SE', label: 'iPhone SE' },
  { id: 'Pixel 5', label: 'Pixel 5' },
  { id: 'Galaxy S9+', label: 'Galaxy S9+' },
  { id: 'iPad', label: 'iPad' },
];

export const toSecs = (d: string): number => {
  const m = d.match(/^(\d+)(s|m|h)$/);
  if (!m) return 0;
  return parseInt(m[1]) * (m[2] === 'h' ? 3600 : m[2] === 'm' ? 60 : 1);
};

export const snapDuration = (secs: number): string =>
  DURATION_OPTIONS.reduce((best, opt) =>
    Math.abs(toSecs(opt) - secs) < Math.abs(toSecs(best) - secs) ? opt : best
  );
