import type { FlowStep, ChatMessage, ChatParseResponse } from '@alt/shared';
import { f, RESULTS_URL } from './core';

export type { ChatMessage, ChatParseResponse };

export interface ThresholdSuggestion {
  p95: number;
  avg: number;
  errorRate: number;
  reasoning: string;
}

export interface ErrorDiagnosis {
  category: 'serverError' | 'clientError' | 'timeout' | 'networkError';
  count: number;
  likelyCause: string;
  nextStep: string;
}

export interface SettingsSuggestion { vus: number; duration: string; profile: string; reasoning: string }

const aiJson = async <T>(res: Response): Promise<T> => {
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
};

export const diagnoseErrors = async (testId: string): Promise<{ diagnoses: ErrorDiagnosis[]; message?: string }> =>
  aiJson(await f(`${RESULTS_URL}/results/${testId}/diagnose`, { cache: 'no-store' }));

export const parseChatPrompt = async (messages: ChatMessage[]): Promise<ChatParseResponse> =>
  aiJson(await f(`${RESULTS_URL}/chat/parse`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  }));

export const predictWebhookNoise = async (events: string[]): Promise<{ level: string; warning: string | null; message: string }> =>
  aiJson(await f(`${RESULTS_URL}/ai/webhook-noise`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  }));

export const suggestPresetName = async (params: { url: string; type: string; vus?: number; duration?: string; profile?: string; stepCount?: number }): Promise<{ name: string; tags: string[] }> =>
  aiJson(await f(`${RESULTS_URL}/ai/preset-name`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  }));

export const suggestParamColumns = async (steps: FlowStep[]): Promise<{ columns: string[]; reasoning: string }> =>
  aiJson(await f(`${RESULTS_URL}/ai/param-suggestions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ steps: steps.map(s => ({ url: s.url, method: s.method, body: s.body })) }),
  }));

export const translatePlaywright = async (script: string, targetUrl?: string): Promise<{ k6Script: string }> =>
  aiJson(await f(`${RESULTS_URL}/ai/translate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script, targetUrl }),
  }));

export const convertCron = async (phrase: string): Promise<{ cron: string; preview: string }> =>
  aiJson(await f(`${RESULTS_URL}/ai/cron`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phrase }),
  }));

export const suggestSettings = async (url: string, type = 'backend'): Promise<SettingsSuggestion> =>
  aiJson(await f(`${RESULTS_URL}/results/suggest-settings?url=${encodeURIComponent(url)}&type=${type}`, { cache: 'no-store' }));

export const getTrendNarrative = async (trend: Array<{ created_at: string; metrics: Record<string, number>; perf_status?: string }>): Promise<{ narrative: string }> =>
  aiJson(await f(`${RESULTS_URL}/ai/trend-narrative`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trend }),
  }));

export const suggestThresholds = async (url: string, type = 'backend'): Promise<{ suggestions: ThresholdSuggestion; runsAnalysed: number }> =>
  aiJson(await f(`${RESULTS_URL}/results/suggest-thresholds?url=${encodeURIComponent(url)}&type=${type}`, { cache: 'no-store' }));
