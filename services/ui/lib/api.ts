const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const RESULTS_URL = process.env.NEXT_PUBLIC_RESULTS_URL || 'http://localhost:3004';

export interface TestRequest {
  type: 'backend' | 'client-side';
  targetUrl: string;
  description: string;
  options: {
    vus?: number;
    duration: string;
    rampUp?: string;
    sessions?: number;
    collectWebVitals?: boolean;
  };
}

export interface TestResult {
  id: string;
  test_id: string;
  type: string;
  target_url: string;
  status: string;
  metrics: Record<string, number>;
  script: string | null;
  reused_script: boolean;
  started_at: string;
  completed_at: string;
  created_at: string;
  perf_status?: string;
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

export const createTest = async (data: TestRequest) => {
  const res = await fetch(`${API_URL}/tests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return res.json();
};

export const getResults = async (): Promise<{ results: TestResult[] }> => {
  const res = await fetch(`${RESULTS_URL}/results`, { cache: 'no-store' });
  return res.json();
};

export const getResult = async (testId: string): Promise<{ result: TestResult }> => {
  const res = await fetch(`${RESULTS_URL}/results/${testId}`, { cache: 'no-store' });
  return res.json();
};

export const getScripts = async () => {
  const res = await fetch(`${RESULTS_URL}/scripts`, { cache: 'no-store' });
  return res.json();
};
export interface ActiveTest {
  test_id: string;
  type: string;
  target_url: string;
  status: string;
  created_at: string;
}

export const getActiveTests = async (): Promise<{ active: ActiveTest[] }> => {
  const res = await fetch(`${RESULTS_URL}/results/active`, { cache: 'no-store' });
  return res.json();
};

export interface LiveMetricPoint {
  timestamp: string;
  vus: number;
  rps: number;
  avgResponseTime: number;
  errorRate: number;
}

export const getLiveMetrics = async (testId: string): Promise<{ points: LiveMetricPoint[] }> => {
  const res = await fetch(`${RESULTS_URL}/results/${testId}/live`, { cache: 'no-store' });
  return res.json();
};