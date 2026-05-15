'use client';

import { useEffect, useState } from 'react';
import { getWebhooks, createWebhook, deleteWebhook, Webhook } from '@/lib/api';

export default function WebhooksPage() {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['failed', 'degraded']);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    const data = await getWebhooks();
    setWebhooks(data.webhooks ?? []);
  };

  useEffect(() => { load(); }, []);

  const handleAdd = async () => {
    if (!url.trim()) { setError('URL is required'); return; }
    setSaving(true);
    setError('');
    try {
      await createWebhook(url.trim(), events);
      setUrl('');
      await load();
    } catch {
      setError('Failed to save webhook');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    await deleteWebhook(id);
    await load();
  };

  const toggleEvent = (e: string) =>
    setEvents(prev => prev.includes(e) ? prev.filter(x => x !== e) : [...prev, e]);

  return (
    <main className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Webhooks</h1>

        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <h2 className="text-sm font-medium text-gray-700 mb-4">Add webhook</h2>
          <div className="space-y-3">
            <input
              type="url"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://your-endpoint.example.com/webhook"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
            <div className="flex gap-4 text-sm">
              <span className="text-gray-600">Trigger on:</span>
              {['failed', 'degraded'].map(e => (
                <label key={e} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={events.includes(e)}
                    onChange={() => toggleEvent(e)}
                    className="rounded border-gray-300"
                  />
                  <span className={e === 'failed' ? 'text-red-600' : 'text-yellow-600'}>{e}</span>
                </label>
              ))}
            </div>
            {error && <p className="text-red-500 text-xs">{error}</p>}
            <button
              onClick={handleAdd}
              disabled={saving}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Add webhook'}
            </button>
          </div>
        </div>

        {webhooks.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-8">No webhooks configured</p>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
            {webhooks.map(w => (
              <div key={w.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-gray-900 truncate max-w-xs">{w.url}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Events: {w.events.join(', ')} · Added {new Date(w.created_at).toLocaleDateString()}
                  </p>
                </div>
                <button
                  onClick={() => handleDelete(w.id)}
                  className="text-red-500 hover:text-red-700 text-xs ml-4"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
