'use client';

import { useEffect, useState } from 'react';
import { getSchedules, createSchedule, updateSchedule, deleteSchedule, runSchedule, convertCron, Schedule } from '@/lib/api';
import { useWorkspace } from '@/lib/WorkspaceContext';

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
  const { activeWorkspaceId } = useWorkspace();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [cronPhrase, setCronPhrase] = useState('');
  const [cronConverting, setCronConverting] = useState(false);
  const [cronPreview, setCronPreview] = useState('');

  const load = async () => {
    try {
      const data = await getSchedules(activeWorkspaceId);
      setSchedules(data.schedules ?? []);
    } catch {
      setError('Could not reach results-service — check that it is running.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [activeWorkspaceId]);

  const handleConvertCron = async () => {
    if (!cronPhrase) return;
    setCronConverting(true);
    try {
      const { cron, preview } = await convertCron(cronPhrase);
      setForm(f => ({ ...f, cron }));
      setCronPreview(`✓ ${preview}`);
      setCronPhrase('');
    } catch (e) { setCronPreview(`Error: ${(e as Error).message}`); }
    finally { setCronConverting(false); }
  };

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
        workspaceId: activeWorkspaceId ?? undefined,
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

  const inputCls = "w-full bg-bg border border-border rounded-control px-3.5 py-2 text-[13px] text-tx focus:outline-none focus:border-ink-bd placeholder:text-tx-5";
  const labelCls = "font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase mb-1.5 block";

  return (
    <div>
      <div className="px-4 md:px-9 pt-7.5 flex items-start justify-between flex-wrap gap-3.5">
        <div>
          <div className="font-mono text-[11px] tracking-[0.16em] text-accent uppercase mb-1.5">— Automation</div>
          <h1 className="font-display text-[clamp(26px,6.5vw,38px)] font-bold tracking-[-0.025em] leading-none">Schedules</h1>
        </div>
        <button
          onClick={() => setShowForm(v => !v)}
          className={`flex items-center gap-1.5 rounded-control px-4 py-2.75 text-[13.5px] font-bold transition-colors ${
            showForm ? 'border border-border bg-surface text-tx-2' : 'bg-accent hover:bg-accent-hover text-white'
          }`}
        >
          {showForm ? 'Cancel' : '+ New schedule'}
        </button>
      </div>

      <div className="px-4 md:px-9 py-6 flex flex-col gap-4">
        {showForm && (
          <div className="bg-surface border border-border rounded-card overflow-hidden">
            <div className="px-6 py-4 border-b border-border">
              <span className="font-display text-[16px] font-semibold">New Schedule</span>
            </div>
            <div className="p-6 space-y-3.5">
              <div className="grid grid-cols-2 gap-3.5">
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
                  {cronPreview && <p className="text-[11px] text-green-fg-2 font-mono mt-1">{cronPreview}</p>}
                  {/* AI-5: natural-language cron assistant */}
                  <div className="flex gap-1.5 mt-1.5">
                    <input
                      type="text" value={cronPhrase}
                      onChange={e => setCronPhrase(e.target.value)}
                      onKeyDown={async e => { if (e.key === 'Enter') { e.preventDefault(); handleConvertCron(); } }}
                      placeholder="every weekday at 9am…"
                      className="flex-1 bg-bg border border-border rounded-control px-2.5 py-1.5 text-[12px] text-tx placeholder:text-tx-5 focus:outline-none focus:border-ink-bd"
                    />
                    <button type="button" onClick={handleConvertCron} disabled={cronConverting || !cronPhrase}
                      className="px-2.5 py-1.5 text-[11px] font-mono rounded-control border border-border text-accent hover:bg-orange-bg disabled:opacity-50">
                      {cronConverting ? '⏳' : '✨ Convert'}
                    </button>
                  </div>
                </div>
              </div>
              <div>
                <label className={labelCls}>Target URL</label>
                <input type="url" value={form.target_url}
                  onChange={e => setForm(f => ({ ...f, target_url: e.target.value }))}
                  placeholder="https://example.com" className={inputCls} />
              </div>
              <div className="grid grid-cols-2 gap-3.5">
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
              {error && <p className="text-red-fg text-[12.5px]">{error}</p>}
            </div>
            <div className="px-6 py-4 border-t border-border">
              <button onClick={handleCreate} disabled={saving}
                className="bg-accent hover:bg-accent-hover text-white rounded-control px-4 py-2 text-[13px] font-bold disabled:opacity-50 transition-colors">
                {saving ? 'Saving…' : 'Create schedule'}
              </button>
            </div>
          </div>
        )}

        {error && !showForm && (
          <div className="bg-red-bg border border-red-fg/30 rounded-control px-4 py-3 text-[12.5px] text-red-fg">{error}</div>
        )}

        {loading ? (
          <div className="bg-surface border border-border rounded-card p-8 text-center text-[13px] text-tx-4">Loading…</div>
        ) : schedules.length === 0 && !error ? (
          <div className="bg-surface border border-border rounded-card p-10 text-center text-[13px] text-tx-4">
            No schedules yet. Create one to run tests automatically.
          </div>
        ) : (
          <div className="bg-surface border border-border rounded-card overflow-hidden overflow-x-auto">
            <div className="grid grid-cols-[1.6fr_2fr_1.3fr_1fr_auto] gap-3.5 min-w-[700px] px-6 py-3 bg-surface-2 border-b border-border font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase">
              <span>Name</span><span>Target</span><span>Cron</span><span>Last run</span><span className="text-right">Actions</span>
            </div>
            {schedules.map(s => (
              <div key={s.id} className="grid grid-cols-[1.6fr_2fr_1.3fr_1fr_auto] gap-3.5 min-w-[700px] items-center px-6 py-3.5 border-b border-border-3 last:border-b-0 hover:bg-hover">
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="font-display font-semibold text-[14px]">{s.name}</span>
                  </div>
                  <span className={`inline-block mt-1 px-2 rounded-chip text-[10px] font-mono font-medium ${s.enabled ? 'bg-green-bg text-green-fg-2' : 'bg-surface-2 text-tx-3'}`}>
                    {s.enabled ? 'active' : 'paused'}
                  </span>
                  <span className="inline-block mt-1 ml-1.5 px-2 rounded-chip text-[10px] font-mono text-accent bg-orange-bg border border-orange-bd">{s.type}</span>
                </div>
                <p className="font-mono text-[12.5px] text-tx-3 truncate">{s.target_url}</p>
                <div>
                  <code className="text-[11px] bg-bg border border-border px-2 py-0.5 rounded-chip font-mono text-tx-3">{s.cron}</code>
                </div>
                <span className="text-[12px] font-mono text-tx-4">{s.last_run_at ? new Date(s.last_run_at).toLocaleString() : '—'}</span>
                <div className="flex items-center gap-1.5 justify-end">
                  <button onClick={() => handleRun(s.id)}
                    className="px-2.5 py-1 text-[11px] border border-border text-tx-2 rounded-chip hover:bg-hover transition-colors">
                    Run now
                  </button>
                  <button onClick={() => handleToggle(s)}
                    className={`w-9 h-5 rounded-full relative flex-shrink-0 transition-colors ${s.enabled ? 'bg-accent' : 'bg-line'}`}
                    title={s.enabled ? 'Pause' : 'Enable'}>
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${s.enabled ? 'right-0.5' : 'left-0.5'}`} />
                  </button>
                  <button onClick={() => handleDelete(s.id)}
                    className="px-2.5 py-1 text-[11px] border border-red-fg/30 text-red-fg rounded-chip hover:bg-red-bg transition-colors">
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
