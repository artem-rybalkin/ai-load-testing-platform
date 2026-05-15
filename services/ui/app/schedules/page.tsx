'use client';

import { useEffect, useState } from 'react';
import { getSchedules, createSchedule, updateSchedule, deleteSchedule, runSchedule, Schedule } from '@/lib/api';

const EMPTY_FORM = {
  name: '',
  cron: '0 * * * *',
  type: 'backend' as 'backend' | 'client-side',
  target_url: '',
  description: '',
  vus: 5,
  duration: '30s',
  sessions: 2,
  enabled: true,
};

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    const data = await getSchedules();
    setSchedules(data.schedules ?? []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!form.name || !form.target_url || !form.cron) { setError('Name, URL and cron are required'); return; }
    setSaving(true);
    setError('');
    try {
      const options = form.type === 'backend'
        ? { vus: form.vus, duration: form.duration }
        : { sessions: form.sessions, duration: form.duration, collectWebVitals: true };
      await createSchedule({
        name: form.name,
        cron: form.cron,
        type: form.type,
        target_url: form.target_url,
        description: form.description || null,
        options,
        thresholds: null,
        enabled: form.enabled,
      });
      setForm(EMPTY_FORM);
      setShowForm(false);
      await load();
    } catch {
      setError('Failed to create schedule');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (s: Schedule) => {
    await updateSchedule(s.id, { enabled: !s.enabled });
    await load();
  };

  const handleRun = async (id: string) => {
    await runSchedule(id);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this schedule?')) return;
    await deleteSchedule(id);
    await load();
  };

  return (
    <main className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Scheduled tests</h1>
            <p className="text-gray-500 text-sm mt-1">Run tests automatically on a cron schedule</p>
          </div>
          <button
            onClick={() => setShowForm(v => !v)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
          >
            {showForm ? 'Cancel' : '+ New schedule'}
          </button>
        </div>

        {showForm && (
          <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6 space-y-4">
            <h2 className="text-sm font-semibold text-gray-800">New schedule</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Hourly smoke test"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Cron expression</label>
                <input
                  type="text"
                  value={form.cron}
                  onChange={e => setForm(f => ({ ...f, cron: e.target.value }))}
                  placeholder="0 * * * *"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Target URL</label>
              <input
                type="url"
                value={form.target_url}
                onChange={e => setForm(f => ({ ...f, target_url: e.target.value }))}
                placeholder="https://example.com"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
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
              <label className="block text-xs font-medium text-gray-600 mb-1">Description (optional)</label>
              <input
                type="text"
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="What does this schedule test?"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            {error && <p className="text-red-500 text-sm">{error}</p>}
            <button
              onClick={handleCreate}
              disabled={saving}
              className="w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Create schedule'}
            </button>
          </div>
        )}

        {loading ? (
          <div className="text-center py-16 text-gray-400">Loading…</div>
        ) : schedules.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400">
            No schedules yet. Create one to run tests automatically.
          </div>
        ) : (
          <div className="space-y-3">
            {schedules.map(s => (
              <div key={s.id} className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-medium text-gray-900 text-sm">{s.name}</span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${s.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {s.enabled ? 'active' : 'paused'}
                    </span>
                    <span className="px-2 py-0.5 rounded-full text-xs bg-blue-50 text-blue-700">{s.type}</span>
                  </div>
                  <p className="text-xs text-gray-500 truncate">{s.target_url}</p>
                  <div className="flex items-center gap-3 mt-1">
                    <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded font-mono text-gray-600">{s.cron}</code>
                    {s.last_run_at && (
                      <span className="text-xs text-gray-400">
                        Last run: {new Date(s.last_run_at).toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => handleRun(s.id)}
                    className="px-3 py-1.5 text-xs border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50"
                    title="Run now"
                  >
                    Run now
                  </button>
                  <button
                    onClick={() => handleToggle(s)}
                    className={`px-3 py-1.5 text-xs border rounded-lg ${
                      s.enabled
                        ? 'border-yellow-300 text-yellow-700 hover:bg-yellow-50'
                        : 'border-green-300 text-green-700 hover:bg-green-50'
                    }`}
                  >
                    {s.enabled ? 'Pause' : 'Enable'}
                  </button>
                  <button
                    onClick={() => handleDelete(s.id)}
                    className="px-3 py-1.5 text-xs border border-red-200 text-red-600 rounded-lg hover:bg-red-50"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
