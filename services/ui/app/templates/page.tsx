'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getTemplates, createTemplate, deleteTemplate, Template } from '@/lib/api';

const EMPTY_FORM = {
  name: '',
  description: '',
  type: 'backend' as 'backend' | 'client-side',
  target_url: '',
  vus: 5,
  duration: '30s',
  sessions: 2,
};

export default function TemplatesPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    const data = await getTemplates();
    setTemplates(data.templates ?? []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!form.name) { setError('Name is required'); return; }
    setSaving(true);
    setError('');
    try {
      const options = form.type === 'backend'
        ? { vus: form.vus, duration: form.duration }
        : { sessions: form.sessions, duration: form.duration, collectWebVitals: true };
      await createTemplate({
        name: form.name,
        description: form.description || null,
        type: form.type,
        target_url: form.target_url || null,
        options,
        thresholds: null,
      });
      setForm(EMPTY_FORM);
      setShowForm(false);
      await load();
    } catch {
      setError('Failed to create template');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this template?')) return;
    await deleteTemplate(id);
    await load();
  };

  const handleUse = (t: Template) => {
    const opts = t.options as Record<string, unknown>;
    const description = t.description ?? '';
    const params = new URLSearchParams({
      type: t.type,
      ...(t.target_url ? { targetUrl: t.target_url } : {}),
      ...(description ? { description } : {}),
      ...(opts.vus ? { vus: String(opts.vus) } : {}),
      ...(opts.sessions ? { sessions: String(opts.sessions) } : {}),
      ...(opts.duration ? { duration: String(opts.duration) } : {}),
      ...(opts.profile ? { profile: String(opts.profile) } : {}),
    });
    router.push(`/?${params.toString()}`);
  };

  return (
    <main className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Test templates</h1>
            <p className="text-gray-500 text-sm mt-1">Save and reuse test configurations</p>
          </div>
          <button
            onClick={() => setShowForm(v => !v)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
          >
            {showForm ? 'Cancel' : '+ New template'}
          </button>
        </div>

        {showForm && (
          <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6 space-y-4">
            <h2 className="text-sm font-semibold text-gray-800">New template</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="API smoke test"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Test type</label>
                <select
                  value={form.type}
                  onChange={e => setForm(f => ({ ...f, type: e.target.value as 'backend' | 'client-side' }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="backend">Backend / API</option>
                  <option value="client-side">Client-side / Browser</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Default URL (optional)</label>
              <input
                type="url"
                value={form.target_url}
                onChange={e => setForm(f => ({ ...f, target_url: e.target.value }))}
                placeholder="https://example.com"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              {form.type === 'backend' ? (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Virtual users</label>
                  <input
                    type="number"
                    min={1} max={100}
                    value={form.vus}
                    onChange={e => setForm(f => ({ ...f, vus: Number(e.target.value) }))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Sessions</label>
                  <input
                    type="number"
                    min={1} max={10}
                    value={form.sessions}
                    onChange={e => setForm(f => ({ ...f, sessions: Number(e.target.value) }))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Duration</label>
                <select
                  value={form.duration}
                  onChange={e => setForm(f => ({ ...f, duration: e.target.value }))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {['30s', '1m', '2m', '5m', '10m'].map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Description (optional)</label>
              <input
                type="text"
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Describe this template..."
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            {error && <p className="text-red-500 text-sm">{error}</p>}
            <button
              onClick={handleCreate}
              disabled={saving}
              className="w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save template'}
            </button>
          </div>
        )}

        {loading ? (
          <div className="text-center py-16 text-gray-400">Loading…</div>
        ) : templates.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400">
            No templates yet. Save a test configuration to reuse it later.
          </div>
        ) : (
          <div className="space-y-3">
            {templates.map(t => {
              const opts = t.options as Record<string, unknown>;
              return (
                <div key={t.id} className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-medium text-gray-900 text-sm">{t.name}</span>
                      <span className="px-2 py-0.5 rounded-full text-xs bg-blue-50 text-blue-700">{t.type}</span>
                      {t.used_count > 0 && (
                        <span className="text-xs text-gray-400">used {t.used_count}×</span>
                      )}
                    </div>
                    {t.target_url && (
                      <p className="text-xs text-gray-500 truncate">{t.target_url}</p>
                    )}
                    <div className="flex items-center gap-3 mt-1">
                      {opts.vus != null && <span className="text-xs text-gray-400">{String(opts.vus)} VUs</span>}
                      {opts.sessions != null && <span className="text-xs text-gray-400">{String(opts.sessions)} sessions</span>}
                      {opts.duration != null && <span className="text-xs text-gray-400">{String(opts.duration)}</span>}
                    </div>
                    {t.description && (
                      <p className="text-xs text-gray-400 mt-0.5">{t.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => handleUse(t)}
                      className="px-3 py-1.5 text-xs border border-blue-300 text-blue-600 rounded-lg hover:bg-blue-50"
                    >
                      Use template
                    </button>
                    <button
                      onClick={() => handleDelete(t.id)}
                      className="px-3 py-1.5 text-xs border border-red-200 text-red-600 rounded-lg hover:bg-red-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
