import type { FlowStep } from '@alt/shared';
import { authHeaders, RECORDER_URL } from './core';

export type { FlowStep };

export interface RecordingSession {
  id: string;
  status: 'active' | 'stopping' | 'completed' | 'error';
  noVncUrl: string;
  steps?: FlowStep[];
  stepCount?: number;
  error?: string;
}

export const startRecording = async (targetUrl?: string, ignorePatterns?: string[], teamId?: string): Promise<RecordingSession> => {
  const res = await fetch(`/recordings/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ targetUrl, ignorePatterns, teamId }),
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Recorder error: ${res.status}`);
  return res.json();
};

export const stopRecording = async (id: string): Promise<RecordingSession> => {
  const res = await fetch(`/recordings/${id}/stop`, {
    method: 'POST',
    headers: { ...authHeaders() },
    signal: AbortSignal.timeout(120_000), // 2 min — AI correlation can be slow
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Recorder error: ${res.status}`);
  return res.json();
};

export const getRecording = async (id: string): Promise<RecordingSession> => {
  const res = await fetch(`/recordings/${id}`, { cache: 'no-store', headers: authHeaders(), credentials: 'include' });
  if (!res.ok) throw new Error(`Recorder error: ${res.status}`);
  return res.json();
};

// Re-export RECORDER_URL so consumers can reference it from this domain module
export { RECORDER_URL };
