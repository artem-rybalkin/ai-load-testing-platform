import { f, RESULTS_URL } from './core';

export interface Preset {
  id: string;
  name: string;
  description: string | null;
  type: 'backend' | 'client-side';
  target_url: string | null;
  options: Record<string, unknown>;
  thresholds: Record<string, unknown> | null;
  used_count: number;
  created_at: string;
}

export const getPresets = async (workspaceId?: string | null): Promise<{ presets: Preset[] }> => {
  const params = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
  const res = await f(`${RESULTS_URL}/presets${params}`, { cache: 'no-store' });
  return res.json();
};

export const createPreset = async (data: Omit<Preset, 'id' | 'used_count' | 'created_at'> & { workspaceId?: string }): Promise<{ preset: Preset }> => {
  const res = await f(`${RESULTS_URL}/presets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
};

export const getPreset = async (id: string): Promise<{ preset: Preset }> => {
  const res = await f(`${RESULTS_URL}/presets/${id}`, { cache: 'no-store' });
  return res.json();
};

export const deletePreset = async (id: string): Promise<void> => {
  await f(`${RESULTS_URL}/presets/${id}`, { method: 'DELETE' });
};
