import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getPresets, createPreset, deletePreset, Preset } from '@/lib/api';
import { useWorkspace } from '@/lib/WorkspaceContext';

const EMPTY_FORM = {
  name: '',
  description: '',
  type: 'backend' as 'backend' | 'client-side',
  target_url: '',
  vus: 5,
  duration: '30s',
  sessions: 2,
};

export default function PresetsPage() {
  const navigate = useNavigate();
  const { activeWorkspaceId } = useWorkspace();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const data = await getPresets(activeWorkspaceId);
      setPresets(data.presets ?? []);
    } catch {
      setError('Could not reach results-service — check that it is running.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [activeWorkspaceId]);

  const handleCreate = async () => {
    if (!form.name) { setError('Name is required'); return; }
    setSaving(true);
    setError('');
    try {
      const options = form.type === 'backend'
        ? { vus: form.vus, duration: form.duration }
        : { sessions: form.sessions, duration: form.duration, collectWebVitals: true };
      await createPreset({
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
      setError('Failed to create preset');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this preset?')) return;
    await deletePreset(id);
    await load();
  };

  const handleUse = (t: Preset) => {
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
    navigate(`/?${params.toString()}`);
  };

  const inputCls = "w-full bg-bg border border-border rounded-control px-3.5 py-2 text-[13px] text-tx focus:outline-none focus:border-ink-bd placeholder:text-tx-5";
  const labelCls = "font-mono text-[10.5px] tracking-[0.06em] text-tx-4 uppercase mb-1.5 block";

  return (
    <div>
      <div className="px-4 md:px-9 pt-7.5 flex items-start justify-between flex-wrap gap-3.5">
        <div>
          <div className="font-mono text-[11px] tracking-[0.16em] text-accent uppercase mb-1.5">— Saved configs</div>
          <h1 className="font-display text-[clamp(26px,6.5vw,38px)] font-bold tracking-[-0.025em] leading-none">Presets</h1>
        </div>
        <button
          onClick={() => setShowForm(v => !v)}
          className={`flex items-center gap-1.5 rounded-control px-4 py-2.75 text-[13.5px] font-bold transition-colors ${
            showForm ? 'border border-border bg-surface text-tx-2' : 'bg-accent hover:bg-accent-hover text-white'
          }`}
        >
          {showForm ? 'Cancel' : '+ New preset'}
        </button>
      </div>

      <div className="px-4 md:px-9 py-6 flex flex-col gap-4">
        {showForm && (
          <div className="bg-surface border border-border rounded-card overflow-hidden">
            <div className="px-6 py-4 border-b border-border">
              <span className="font-display text-[16px] font-semibold">New Preset</span>
            </div>
            <div className="p-6 space-y-3.5">
              <div className="grid grid-cols-2 gap-3.5">
                <div>
                  <label className={labelCls}>Name</label>
                  <input type="text" value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="API smoke test" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Test type</label>
                  <select value={form.type}
                    onChange={e => setForm(f => ({ ...f, type: e.target.value as 'backend' | 'client-side' }))}
                    className={inputCls}>
                    <option value="backend">Backend / API</option>
                    <option value="client-side">Client-side / Browser</option>
                  </select>
                </div>
              </div>
              <div>
                <label className={labelCls}>Default URL (optional)</label>
                <input type="url" value={form.target_url}
                  onChange={e => setForm(f => ({ ...f, target_url: e.target.value }))}
                  placeholder="https://example.com" className={inputCls} />
              </div>
              <div className="grid grid-cols-2 gap-3.5">
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
                  <label className={labelCls}>Duration</label>
                  <select value={form.duration}
                    onChange={e => setForm(f => ({ ...f, duration: e.target.value }))}
                    className={inputCls}>
                    {['30s', '1m', '2m', '5m', '10m'].map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className={labelCls}>Description (optional)</label>
                <input type="text" value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Describe this preset…" className={inputCls} />
              </div>
              {error && <p className="text-red-fg text-[12.5px]">{error}</p>}
            </div>
            <div className="px-6 py-4 border-t border-border">
              <button onClick={handleCreate} disabled={saving}
                className="bg-accent hover:bg-accent-hover text-white rounded-control px-4 py-2 text-[13px] font-bold disabled:opacity-50 transition-colors">
                {saving ? 'Saving…' : 'Save preset'}
              </button>
            </div>
          </div>
        )}

        {error && !showForm && (
          <div className="bg-red-bg border border-red-fg/30 rounded-control px-4 py-3 text-[12.5px] text-red-fg">{error}</div>
        )}

        {loading ? (
          <div className="bg-surface border border-border rounded-card p-8 text-center text-[13px] text-tx-4">Loading…</div>
        ) : presets.length === 0 && !error ? (
          <div className="bg-surface border border-border rounded-card p-10 text-center text-[13px] text-tx-4">
            No presets yet. Save a test configuration to reuse it later.
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(270px,1fr))] gap-4">
            {presets.map(t => {
              const opts = t.options as Record<string, unknown>;
              return (
                <div key={t.id} className="bg-surface border border-border rounded-tile p-5 flex flex-col gap-3 hover:border-tx-5 transition-colors">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] border border-orange-bd rounded-chip px-2 py-0.5 text-accent bg-orange-bg">{t.type}</span>
                    {t.used_count > 0 && <span className="text-[11px] font-mono text-tx-4">used {t.used_count}×</span>}
                  </div>
                  <div>
                    <div className="font-display text-[16px] font-semibold">{t.name}</div>
                    {t.target_url && <div className="font-mono text-[12px] text-tx-4 mt-0.75 truncate">{t.target_url}</div>}
                  </div>
                  <div className="flex gap-1.5 flex-wrap">
                    {opts.vus != null && <span className="font-mono text-[11px] bg-bg border border-border rounded-chip px-2 py-0.75 text-tx-3">{String(opts.vus)} VUs</span>}
                    {opts.sessions != null && <span className="font-mono text-[11px] bg-bg border border-border rounded-chip px-2 py-0.75 text-tx-3">{String(opts.sessions)} sessions</span>}
                    {opts.duration != null && <span className="font-mono text-[11px] bg-bg border border-border rounded-chip px-2 py-0.75 text-tx-3">{String(opts.duration)}</span>}
                  </div>
                  {t.description && <p className="text-[11.5px] text-tx-4">{t.description}</p>}
                  <div className="flex items-center justify-between pt-3 border-t border-line mt-auto">
                    <button onClick={() => handleDelete(t.id)} className="text-[12px] text-red-fg hover:underline">Delete</button>
                    <button onClick={() => handleUse(t)} className="flex items-center gap-1.5 text-accent text-[13px] font-bold">
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="var(--accent)"><path d="M4 3l9 5-9 5z" /></svg>Use
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
