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

  const inputCls = "w-full border border-[#d0d7de] rounded-md px-3 py-1.5 text-[13px] bg-white text-[#24292f] focus:outline-none focus:border-[#0969da] focus:ring-2 focus:ring-[#0969da]/20 placeholder-[#8c959f]";
  const labelCls = "block text-[11px] font-semibold text-[#57606a] uppercase tracking-wide mb-1";

  return (
    <div className="p-4 lg:p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-[15px] font-semibold text-[#24292f]">Scheduled Tests</h1>
        <button
          onClick={() => setShowForm(v => !v)}
          className={`px-3 py-1.5 rounded-md text-[12px] font-medium border transition-colors ${
            showForm
              ? 'border-[#d0d7de] bg-white text-[#24292f] hover:bg-[#eaeef2]'
              : 'bg-[#1f883d] hover:bg-[#1a7f37] text-white border-transparent'
          }`}
        >
          {showForm ? 'Cancel' : '+ New schedule'}
        </button>
      </div>

      {showForm && (
        <div className="bg-white border border-[#d0d7de] rounded-md mb-4 overflow-hidden">
          <div className="px-4 py-2 bg-[#f6f8fa] border-b border-[#d0d7de]">
            <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">New Schedule</span>
          </div>
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Name</label>
                <input type="text" value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Hourly smoke test" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Cron expression</label>
                <input type="text" value={form.cron}
                  onChange={e => setForm(f => ({ ...f, cron: e.target.value }))}
                  placeholder="0 * * * *" className={`${inputCls} font-mono`} />
              </div>
            </div>
            <div>
              <label className={labelCls}>Target URL</label>
              <input type="url" value={form.target_url}
                onChange={e => setForm(f => ({ ...f, target_url: e.target.value }))}
                placeholder="https://example.com" className={inputCls} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Test type</label>
                <select value={form.type}
                  onChange={e => setForm(f => ({ ...f, type: e.target.value as 'backend' | 'client-side' }))}
                  className={inputCls}>
                  <option value="backend">Backend / API</option>
                  <option value="client-side">Client-side / Browser</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>Duration</label>
                <select value={form.duration}
                  onChange={e => setForm(f => ({ ...f, duration: e.target.value }))}
                  className={inputCls}>
                  {['30s', '1m', '2m', '5m', '10m'].map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
            </div>
            {form.type === 'backend' ? (
              <div>
                <label className={labelCls}>Virtual users</label>
                <input type="number" min={1} max={100} value={form.vus}
                  onChange={e => setForm(f => ({ ...f, vus: Number(e.target.value) }))}
                  className={inputCls} />
              </div>
            ) : (
              <div>
                <label className={labelCls}>Sessions</label>
                <input type="number" min={1} max={10} value={form.sessions}
                  onChange={e => setForm(f => ({ ...f, sessions: Number(e.target.value) }))}
                  className={inputCls} />
              </div>
            )}
            <div>
              <label className={labelCls}>Description (optional)</label>
              <input type="text" value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="What does this schedule test?" className={inputCls} />
            </div>
            {error && <p className="text-[#cf222e] text-[12px]">{error}</p>}
          </div>
          <div className="px-4 py-3 bg-[#f6f8fa] border-t border-[#d0d7de]">
            <button onClick={handleCreate} disabled={saving}
              className="px-4 py-1.5 bg-[#1f883d] hover:bg-[#1a7f37] text-white rounded-md text-[13px] font-medium disabled:opacity-50 transition-colors">
              {saving ? 'Saving…' : 'Create schedule'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="bg-white border border-[#d0d7de] rounded-md p-8 text-center text-[13px] text-[#57606a]">Loading…</div>
      ) : schedules.length === 0 ? (
        <div className="bg-white border border-[#d0d7de] rounded-md p-10 text-center text-[13px] text-[#57606a]">
          No schedules yet. Create one to run tests automatically.
        </div>
      ) : (
        <div className="bg-white border border-[#d0d7de] rounded-md overflow-hidden divide-y divide-[#eaeef2]">
          {schedules.map(s => (
            <div key={s.id} className="flex items-center gap-4 px-4 py-3 hover:bg-[#f6f8fa]">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-medium text-[#24292f] text-[13px]">{s.name}</span>
                  <span className={`px-1.5 rounded text-[10px] font-mono font-medium ${s.enabled ? 'bg-[#dafbe1] text-[#1a7f37]' : 'bg-[#f6f8fa] text-[#57606a]'}`}>
                    {s.enabled ? 'active' : 'paused'}
                  </span>
                  <span className="px-1.5 rounded text-[10px] font-mono bg-[#ddf4ff] text-[#0969da]">{s.type}</span>
                </div>
                <p className="text-[11px] font-mono text-[#57606a] truncate">{s.target_url}</p>
                <div className="flex items-center gap-3 mt-0.5">
                  <code className="text-[10px] bg-[#f6f8fa] border border-[#d0d7de] px-1.5 py-0.5 rounded font-mono text-[#57606a]">{s.cron}</code>
                  {s.last_run_at && (
                    <span className="text-[10px] font-mono text-[#8c959f]">Last run: {new Date(s.last_run_at).toLocaleString()}</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button onClick={() => handleRun(s.id)}
                  className="px-2.5 py-1 text-[11px] border border-[#d0d7de] text-[#24292f] rounded-md hover:bg-[#eaeef2] transition-colors">
                  Run now
                </button>
                <button onClick={() => handleToggle(s)}
                  className={`px-2.5 py-1 text-[11px] border rounded-md transition-colors ${
                    s.enabled
                      ? 'border-[#e3b341] text-[#9a6700] hover:bg-[#fff8c5]'
                      : 'border-[#2da44e] text-[#1f883d] hover:bg-[#dafbe1]'
                  }`}>
                  {s.enabled ? 'Pause' : 'Enable'}
                </button>
                <button onClick={() => handleDelete(s.id)}
                  className="px-2.5 py-1 text-[11px] border border-[#f4c7c3] text-[#cf222e] rounded-md hover:bg-[#ffebe9] transition-colors">
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
