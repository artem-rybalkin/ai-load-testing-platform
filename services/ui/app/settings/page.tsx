import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { getLiveMetricWindow, setLiveMetricWindow, LiveMetricWindowSec } from '@/lib/api';

const WINDOW_OPTIONS: { id: LiveMetricWindowSec; label: string }[] = [
  { id: 10, label: '10s' },
  { id: 30, label: '30s' },
  { id: 60, label: '1min' },
];

export default function SettingsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [current, setCurrent] = useState<LiveMetricWindowSec | null>(null);
  const [draft, setDraft] = useState<LiveMetricWindowSec>(10);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    getLiveMetricWindow()
      .then(({ windowSec }) => { setCurrent(windowSec); setDraft(windowSec); })
      .catch(() => setError('Failed to load current setting'));
  }, [isAdmin]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const { windowSec } = await setLiveMetricWindow(draft);
      setCurrent(windowSec);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save setting');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="px-4 md:px-9 pt-7.5">
        <div className="font-mono text-[11px] tracking-[0.16em] text-accent uppercase mb-1.5">— Platform</div>
        <h1 className="font-display text-[clamp(26px,6.5vw,38px)] font-bold tracking-[-0.025em] leading-none">Settings</h1>
      </div>
      <div className="px-4 md:px-9 py-6 flex flex-col gap-4">

        {!isAdmin ? (
          <div className="bg-surface border border-border rounded-card p-8 text-center text-[13px] text-tx-3">
            Admin access required to view platform settings.
          </div>
        ) : (
          <div className="bg-surface border border-border rounded-card overflow-hidden">
            <div className="px-6 py-4 border-b border-border">
              <span className="font-display text-[16px] font-semibold">Live metrics window</span>
            </div>
            {current === null ? (
              <div className="p-8 text-center text-[13px] text-tx-3">{error || 'Loading…'}</div>
            ) : (
              <div className="p-4 space-y-3">
                <p className="text-[11px] text-tx-4">
                  Aggregation window for the live metrics chart shown during a running test. Applies to new
                  tests only — tests already in progress keep using the window that was active when they started.
                </p>
                <div className="grid grid-cols-3 gap-1.5 max-w-sm">
                  {WINDOW_OPTIONS.map(o => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => setDraft(o.id)}
                      className={`py-2 px-3 rounded-control border text-center transition-colors ${
                        draft === o.id ? 'border-ink-bd bg-surface' : 'border-border bg-surface hover:bg-hover'
                      }`}
                    >
                      <div className="text-[12.5px] font-semibold">{o.label}</div>
                    </button>
                  ))}
                </div>
                <div className="flex items-center justify-end gap-2 pt-1">
                  {error && <p className="text-red-fg text-[12px] mr-auto">{error}</p>}
                  {saved && !error && <p className="text-green-fg text-[12px] mr-auto">Saved</p>}
                  <button
                    onClick={handleSave}
                    disabled={saving || draft === current}
                    className="px-4 py-1.5 bg-accent hover:bg-accent-hover text-white rounded-control text-[13px] font-medium disabled:opacity-50 transition-colors"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
