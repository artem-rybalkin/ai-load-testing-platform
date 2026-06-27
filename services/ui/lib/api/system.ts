import { f, RESULTS_URL } from './core';

export interface WorkerMetrics {
  cpuPercent: number;
  memoryMb: number;
  memoryPercent: number;
  activeTests: number;
  maxTests: number;
}

export interface ServiceHealth {
  name: string;
  status: 'ok' | 'degraded' | 'saturated' | 'unreachable';
  checks: Record<string, string>;
  metrics?: WorkerMetrics;
}

export interface SystemHealth {
  healthy: boolean;
  services: ServiceHealth[];
}

export interface AIStatus {
  quotaExceeded: boolean;
  message?: string;
  since?: string;
}

export const getSystemHealth = async (): Promise<SystemHealth> => {
  const res = await f(`${RESULTS_URL}/system/health`, { cache: 'no-store' });
  return res.json();
};

export const getAIStatus = async (): Promise<AIStatus> => {
  const res = await f(`${RESULTS_URL}/system/ai-status`, { cache: 'no-store' });
  return res.json();
};
