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
  vus: number;
  duration: string;
  rampUp?: string;
}

export interface ClientTestOptions {
  sessions: number;
  duration: string;
  collectWebVitals: boolean;
}

export interface TestResult {
  testId: string;
  targetUrl: string;
  status: TestStatus;
  metrics: BackendMetrics | ClientMetrics;
  startedAt: string;
  completedAt?: string;
}

export interface BackendMetrics {
  type: 'backend';
  requestsTotal: number;
  requestsFailed: number;
  avgResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  rps: number;
}

export interface ClientMetrics {
  type: 'client';
  lcp: number;
  fid: number;
  cls: number;
  ttfb: number;
  fcp: number;
}