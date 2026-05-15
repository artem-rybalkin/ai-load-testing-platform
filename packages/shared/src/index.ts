export type TestType = 'backend' | 'client-side';

export type TestStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SLOThresholds {
  p95?: number;       // ms — default 1000
  avg?: number;       // ms — default 500
  errorRate?: number; // % — default 1
  lcp?: number;       // ms — default 2500
  fcp?: number;       // ms — default 1800
  ttfb?: number;      // ms — default 800
  cls?: number;       // score — default 0.1
}

export interface TestRequest {
  id: string;
  type: TestType;
  targetUrl: string;
  description: string;
  options: BackendTestOptions | ClientTestOptions;
  thresholds?: SLOThresholds;
  createdAt: string;
}

export type LoadProfile = 'load' | 'spike' | 'capacity' | 'soak';

export interface BackendTestOptions {
  vus: number;
  duration: string;
  rampUp?: string;
  profile?: LoadProfile;
  peakVus?: number;
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
  thresholds?: SLOThresholds;
  startedAt: string;
  completedAt?: string;
  perfStatus?: 'passed' | 'degraded' | 'failed';
  analysis?: {
    perfStatus: string;
    diffs: Array<{
      metric: string;
      current: number;
      previous: number;
      diffPercent: number;
      status: 'better' | 'same' | 'worse';
    }>;
    summary: string;
    thresholdViolations: string[];
  };
}

export interface BackendMetrics {
  type: 'backend';
  requestsTotal: number;
  requestsFailed: number;
  avgResponseTime: number;
  p50ResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  rps: number;
  statusCodes?: Record<string, number>;
}

export interface LighthouseScore {
  performance: number;    // 0-100
  accessibility: number;  // 0-100
  bestPractices: number;  // 0-100
  seo: number;            // 0-100
}

export interface ClientMetrics {
  type: 'client';
  lcp: number;
  fid: number;
  cls: number;
  ttfb: number;
  fcp: number;
  lighthouseScore?: LighthouseScore;
}
export interface TestScript {
  id: string;
  targetUrl: string;
  testType: TestType;
  script: string;
  usedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface EnrichedTestRequest extends TestRequest {
  generatedScript?: string;
  scriptId?: string;
  reusedScript?: boolean;
}

export interface LiveMetricPoint {
  timestamp: string;
  vus: number;
  rps: number;
  avgResponseTime: number;
  errorRate: number;
}