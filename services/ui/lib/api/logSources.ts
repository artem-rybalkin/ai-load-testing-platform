import type { TestResult } from './tests';
import { f, RESULTS_URL } from './core';

export interface LogSource {
  id: string;
  name: string;
  platform: string | null;
  url_template: string;
  metrics_endpoint_template: string | null;
  auth_header: string | null;
  created_at: string;
}

/**
 * Interpolates template variables in a log source URL for a specific test result.
 *
 * Supported variables:
 *   {startedAtMs}      — started_at as epoch milliseconds
 *   {completedAtMs}    — completed_at as epoch milliseconds (falls back to now)
 *   {startedAtISO}     — started_at as ISO 8601 string
 *   {completedAtISO}   — completed_at as ISO 8601 string
 *   {targetUrl}        — raw target URL
 *   {targetUrlEncoded} — URL-encoded target URL
 *   {testId}           — test UUID
 */
export const interpolateLogSourceUrl = (
  template: string,
  result: Pick<TestResult, 'test_id' | 'target_url' | 'started_at' | 'completed_at'>,
): string => {
  const startedAt   = result.started_at   ? new Date(result.started_at)   : new Date();
  const completedAt = result.completed_at ? new Date(result.completed_at) : new Date();

  return template
    .replaceAll('{startedAtMs}',      String(startedAt.getTime()))
    .replaceAll('{completedAtMs}',    String(completedAt.getTime()))
    .replaceAll('{startedAtS}',       String(Math.floor(startedAt.getTime() / 1000)))
    .replaceAll('{completedAtS}',     String(Math.floor(completedAt.getTime() / 1000)))
    .replaceAll('{startedAtISO}',     startedAt.toISOString())
    .replaceAll('{completedAtISO}',   completedAt.toISOString())
    .replaceAll('{targetUrl}',        result.target_url)
    .replaceAll('{targetUrlEncoded}', encodeURIComponent(result.target_url))
    .replaceAll('{testId}',           result.test_id);
};

export const getLogSources = async (): Promise<{ logSources: LogSource[] }> => {
  const res = await f(`${RESULTS_URL}/log-sources`, { cache: 'no-store' });
  return res.json();
};

export const createLogSource = async (data: { name: string; platform?: string; urlTemplate: string; metricsEndpointTemplate?: string; authHeader?: string }): Promise<{ logSource: LogSource }> => {
  const res = await f(`${RESULTS_URL}/log-sources`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
};

export const updateLogSource = async (id: string, data: Partial<{ name: string; platform: string | null; urlTemplate: string; metricsEndpointTemplate: string | null; authHeader: string | null }>): Promise<{ logSource: LogSource }> => {
  const res = await f(`${RESULTS_URL}/log-sources/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
};

export const deleteLogSource = async (id: string): Promise<void> => {
  await f(`${RESULTS_URL}/log-sources/${id}`, { method: 'DELETE' });
};
