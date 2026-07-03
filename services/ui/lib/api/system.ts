import type { LiveMetricWindowSec } from '@alt/shared';
import { f, orgJson, RESULTS_URL } from './core';

export type { LiveMetricWindowSec };

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

/** Admin-configurable live-metrics chart aggregation window — applies to new tests only. */
export const getLiveMetricWindow = (): Promise<{ windowSec: LiveMetricWindowSec }> =>
  f(`${RESULTS_URL}/system/live-metric-window`, { cache: 'no-store' }).then(orgJson<{ windowSec: LiveMetricWindowSec }>());

export const setLiveMetricWindow = (windowSec: LiveMetricWindowSec): Promise<{ windowSec: LiveMetricWindowSec }> =>
  f(`${RESULTS_URL}/system/live-metric-window`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ windowSec }),
  }).then(orgJson<{ windowSec: LiveMetricWindowSec }>());
