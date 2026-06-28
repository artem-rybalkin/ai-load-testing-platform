import { f, RESULTS_URL } from './core';

export interface Schedule {
  id: string;
  name: string;
  cron: string;
  type: 'backend' | 'client-side';
  target_url: string;
  description: string | null;
  options: Record<string, unknown>;
  thresholds: Record<string, unknown> | null;
  enabled: boolean;
  last_run_at: string | null;
  created_at: string;
}

export const getSchedules = async (workspaceId?: string | null): Promise<{ schedules: Schedule[] }> => {
  const params = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
  const res = await f(`${RESULTS_URL}/schedules${params}`, { cache: 'no-store' });
  return res.json();
};

export const createSchedule = async (data: Omit<Schedule, 'id' | 'last_run_at' | 'created_at'> & { workspaceId?: string }): Promise<{ schedule: Schedule }> => {
  const res = await f(`${RESULTS_URL}/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
};

export const updateSchedule = async (id: string, data: Partial<Omit<Schedule, 'id' | 'created_at'>>): Promise<{ schedule: Schedule }> => {
  const res = await f(`${RESULTS_URL}/schedules/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
};

export const deleteSchedule = async (id: string): Promise<void> => {
  await f(`${RESULTS_URL}/schedules/${id}`, { method: 'DELETE' });
};

export const runSchedule = async (id: string): Promise<void> => {
  await f(`${RESULTS_URL}/schedules/${id}/run`, { method: 'POST' });
};
