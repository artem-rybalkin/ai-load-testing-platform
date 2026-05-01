export type TestType = 'backend' | 'client-side';
export type TestStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface TestRequest {
  id: string;
  type: TestType;
  targetUrl: string;
  description: string;
  options: BackendTestOptions | ClientTestOptions;
  createdAt: string;
}

export interface BackendTestOptions {
  vus: number;          // virtual users
  duration: string;     // наприклад "30s", "1m"
  rampUp?: string;      // час розгону, наприклад "10s"
}

export interface ClientTestOptions {
  sessions: number;     // кількість браузерних сесій
  duration: string;
  collectWebVitals: boolean;
}

export interface TestResult {
  testId: string;
  status: TestStatus;
  metrics: BackendMetrics | ClientMetrics;
  startedAt: string;
  completedAt?: string;
}

export interface BackendMetrics {
  type: 'backend';
  requestsTotal: number;
  requestsFailed: number;
  avgResponseTime: number;  // ms
  p95ResponseTime: number;  // ms
  p99ResponseTime: number;  // ms
  rps: number;              // requests per second
}

export interface ClientMetrics {
  type: 'client';
  lcp: number;   // Largest Contentful Paint, ms
  fid: number;   // First Input Delay, ms
  cls: number;   // Cumulative Layout Shift (score)
  ttfb: number;  // Time to First Byte, ms
  fcp: number;   // First Contentful Paint, ms
}