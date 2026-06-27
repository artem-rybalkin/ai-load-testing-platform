import { f, RESULTS_URL } from './core';

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  format: 'generic' | 'slack' | 'pagerduty' | 'opsgenie';
  created_at: string;
}

export const getWebhooks = async (): Promise<{ webhooks: Webhook[] }> => {
  const res = await f(`${RESULTS_URL}/webhooks`, { cache: 'no-store' });
  return res.json();
};

export const createWebhook = async (url: string, events?: string[], format?: string): Promise<{ webhook: Webhook }> => {
  const res = await f(`${RESULTS_URL}/webhooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, events, format }),
  });
  return res.json();
};

export const deleteWebhook = async (id: string): Promise<void> => {
  await f(`${RESULTS_URL}/webhooks/${id}`, { method: 'DELETE' });
};
