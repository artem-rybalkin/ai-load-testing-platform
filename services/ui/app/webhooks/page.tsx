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
    <div className="p-4 lg:p-6 max-w-2xl">
      <h1 className="text-[15px] font-semibold text-[#24292f] mb-4">Webhooks</h1>

      <div className="bg-white border border-[#d0d7de] rounded-md overflow-hidden mb-4">
        <div className="px-4 py-2 bg-[#f6f8fa] border-b border-[#d0d7de]">
          <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Add Webhook</span>
        </div>
        <div className="p-4 space-y-3">
          <input
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://your-endpoint.example.com/webhook"
            className="w-full border border-[#d0d7de] rounded-md px-3 py-1.5 text-[13px] bg-white text-[#24292f] focus:outline-none focus:border-[#0969da] focus:ring-2 focus:ring-[#0969da]/20 placeholder-[#8c959f]"
          />
          <div className="flex items-center gap-4 text-[13px]">
            <span className="text-[#57606a]">Trigger on:</span>
            {['failed', 'degraded'].map(e => (
              <label key={e} className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={events.includes(e)}
                  onChange={() => toggleEvent(e)}
                  className="rounded border-[#d0d7de] text-[#0969da] focus:ring-[#0969da]"
                />
                <span className={`font-mono text-[12px] ${e === 'failed' ? 'text-[#cf222e]' : 'text-[#9a6700]'}`}>{e}</span>
              </label>
            ))}
          </div>
          {error && <p className="text-[#cf222e] text-[12px]">{error}</p>}
        </div>
        <div className="px-4 py-3 bg-[#f6f8fa] border-t border-[#d0d7de]">
          <button
            onClick={handleAdd}
            disabled={saving}
            className="px-4 py-1.5 bg-[#1f883d] hover:bg-[#1a7f37] text-white rounded-md text-[13px] font-medium disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Add webhook'}
          </button>
        </div>
      </div>

      {webhooks.length === 0 ? (
        <div className="bg-white border border-[#d0d7de] rounded-md p-8 text-center text-[13px] text-[#57606a]">
          No webhooks configured
        </div>
      ) : (
        <div className="bg-white border border-[#d0d7de] rounded-md overflow-hidden divide-y divide-[#eaeef2]">
          {webhooks.map(w => (
            <div key={w.id} className="flex items-center justify-between px-4 py-3 hover:bg-[#f6f8fa]">
              <div className="min-w-0">
                <p className="text-[13px] font-mono text-[#24292f] truncate max-w-sm">{w.url}</p>
                <p className="text-[10px] font-mono text-[#8c959f] mt-0.5">
                  Events: {w.events.join(', ')} · Added {new Date(w.created_at).toLocaleDateString()}
                </p>
              </div>
              <button
                onClick={() => handleDelete(w.id)}
                className="text-[11px] text-[#cf222e] hover:underline ml-4 flex-shrink-0"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
