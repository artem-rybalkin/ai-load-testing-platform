import { useState } from 'react';
import { useLoaderData } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import { getMe, getLiveMetricWindow, setLiveMetricWindow, LiveMetricWindowSec, getAiProvider, setAiProvider, AiProviderConfig, AiProviderName, getOperationalSettings, setOperationalSettings, OperationalSettings } from '@/lib/api';

const OPERATIONAL_SETTING_FIELDS: { key: keyof OperationalSettings; label: string; hint: string; min: number }[] = [
  { key: 'staleRunningMinutes', label: 'Stale "running" timeout', hint: 'Minutes before a stuck running test is marked failed', min: 1 },
  { key: 'stalePendingMinutes', label: 'Stale "pending" timeout', hint: 'Minutes before a stuck pending test is marked failed', min: 1 },
  { key: 'liveMetricsRetentionDays', label: 'Live-metrics retention', hint: 'Days of streaming metric points kept per test', min: 1 },
  { key: 'testResultsRetentionDays', label: 'Test-results retention (GDPR)', hint: 'Days before old test results are auto-purged — 0 disables auto-purge', min: 0 },
  { key: 'auditLogRetentionDays', label: 'Audit-log retention', hint: 'Days before old audit-log entries are auto-purged — 0 disables auto-purge', min: 0 },
  { key: 'rateLimitMax', label: 'Global rate limit', hint: 'Requests/min/IP across the whole API', min: 1 },
  { key: 'aiRateLimitMax', label: 'AI rate limit', hint: 'Requests/min for /ai/* and suggest-*/diagnose endpoints', min: 1 },
];

const WINDOW_OPTIONS: { id: LiveMetricWindowSec; label: string }[] = [
  { id: 10, label: '10s' },
  { id: 30, label: '30s' },
  { id: 60, label: '1min' },
];

// Mirrors @alt/shared's AI_PROVIDER_NAMES — duplicated locally (same reason as
// team/page.tsx: Vite/Rollup can't statically resolve value exports re-exported
// via `export *` from the shared package's compiled CJS output).
const AI_PROVIDER_NAMES: AiProviderName[] = ['gemini', 'openai', 'anthropic'];

const PROVIDER_LABELS: Record<AiProviderName, string> = {
  gemini: 'Gemini',
  openai: 'OpenAI',
  anthropic: 'Claude (Anthropic)',
};

interface LoaderData {
  isAdmin: boolean;
  windowSec: LiveMetricWindowSec | null;
  loadError: string | null;
  aiProvider: AiProviderConfig | null;
  aiProviderLoadError: string | null;
  operationalSettings: OperationalSettings | null;
  operationalSettingsLoadError: string | null;
}

export async function loader(): Promise<LoaderData> {
  // getMe() (not the AuthContext) so this loader has no React context dependency —
  // loaders run outside the component tree.
  const user = await getMe();
  const isAdmin = user.role === 'admin';
  if (!isAdmin) {
    return {
      isAdmin, windowSec: null, loadError: null, aiProvider: null, aiProviderLoadError: null,
      operationalSettings: null, operationalSettingsLoadError: null,
    };
  }
  const [windowResult, aiProviderResult, operationalResult] = await Promise.allSettled([
    getLiveMetricWindow(), getAiProvider(), getOperationalSettings(),
  ]);
  return {
    isAdmin,
    windowSec: windowResult.status === 'fulfilled' ? windowResult.value.windowSec : null,
    loadError: windowResult.status === 'fulfilled' ? null : 'Failed to load current setting',
    aiProvider: aiProviderResult.status === 'fulfilled' ? aiProviderResult.value : null,
    aiProviderLoadError: aiProviderResult.status === 'fulfilled' ? null : 'Failed to load AI provider setting',
    operationalSettings: operationalResult.status === 'fulfilled' ? operationalResult.value : null,
    operationalSettingsLoadError: operationalResult.status === 'fulfilled' ? null : 'Failed to load operational settings',
  };
}

export default function SettingsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const {
    windowSec, loadError, aiProvider: initialAiProvider, aiProviderLoadError,
    operationalSettings: initialOperationalSettings, operationalSettingsLoadError,
  } = useLoaderData() as LoaderData;

  const [current, setCurrent] = useState<LiveMetricWindowSec | null>(windowSec);
  const [draft, setDraft] = useState<LiveMetricWindowSec>(windowSec ?? 10);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

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

  const [aiProvider, setAiProviderState] = useState<AiProviderConfig | null>(initialAiProvider);
  const [aiProviderDraft, setAiProviderDraft] = useState<{ provider: AiProviderName; fallbacks: AiProviderName[] }>(
    initialAiProvider ? { provider: initialAiProvider.provider, fallbacks: initialAiProvider.fallbacks } : { provider: 'gemini', fallbacks: [] },
  );
  const [aiProviderError, setAiProviderError] = useState(aiProviderLoadError ?? '');
  const [savingAiProvider, setSavingAiProvider] = useState(false);
  const [aiProviderSaved, setAiProviderSaved] = useState(false);

  const toggleAiFallback = (p: AiProviderName): void => {
    setAiProviderDraft(d => ({
      ...d,
      fallbacks: d.fallbacks.includes(p) ? d.fallbacks.filter(f => f !== p) : [...d.fallbacks, p],
    }));
  };

  const handleSaveAiProvider = async () => {
    setSavingAiProvider(true);
    setAiProviderError('');
    setAiProviderSaved(false);
    try {
      const result = await setAiProvider(aiProviderDraft.provider, aiProviderDraft.fallbacks);
      setAiProviderDraft(result);
      setAiProviderState(prev => prev ? { ...prev, ...result } : prev);
      setAiProviderSaved(true);
    } catch (err) {
      setAiProviderError(err instanceof Error ? err.message : 'Failed to save AI provider');
    } finally {
      setSavingAiProvider(false);
    }
  };

  const [operationalSettings, setOperationalSettingsState] = useState<OperationalSettings | null>(initialOperationalSettings);
  const [operationalDraft, setOperationalDraft] = useState<OperationalSettings | null>(initialOperationalSettings);
  const [operationalError, setOperationalError] = useState(operationalSettingsLoadError ?? '');
  const [savingOperational, setSavingOperational] = useState(false);
  const [operationalSaved, setOperationalSaved] = useState(false);

  const handleSaveOperational = async () => {
    if (!operationalDraft) return;
    setSavingOperational(true);
    setOperationalError('');
    setOperationalSaved(false);
    try {
      const result = await setOperationalSettings(operationalDraft);
      setOperationalSettingsState(result);
      setOperationalDraft(result);
      setOperationalSaved(true);
    } catch (err) {
      setOperationalError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSavingOperational(false);
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
              <div className="p-8 text-center text-[13px] text-tx-3">{loadError || 'Loading…'}</div>
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

        {isAdmin && (
          <div className="bg-surface border border-border rounded-card overflow-hidden">
            <div className="px-6 py-4 border-b border-border">
              <span className="font-display text-[16px] font-semibold">Platform-default AI provider</span>
            </div>
            {!aiProvider ? (
              <div className="p-8 text-center text-[13px] text-tx-3">{aiProviderError || 'Loading…'}</div>
            ) : (
              <div className="p-4 space-y-3">
                <p className="text-[11px] text-tx-4">
                  Which AI provider generates scripts and insights platform-wide by default. Fallbacks are tried in
                  order if the primary provider is rate-limited or unreachable. Individual teams can still override
                  this from their own Team page.
                </p>
                <div className="flex items-center justify-between gap-4">
                  <span className="text-[12px] text-tx">Primary provider</span>
                  <select
                    value={aiProviderDraft.provider}
                    onChange={e => {
                      const provider = e.target.value as AiProviderName;
                      setAiProviderDraft(d => ({ provider, fallbacks: d.fallbacks.filter(f => f !== provider) }));
                    }}
                    className="border border-border rounded-control px-2 py-1 text-[12px] bg-surface text-tx focus:outline-none focus:border-ink-bd"
                  >
                    {AI_PROVIDER_NAMES.map(p => (
                      <option key={p} value={p}>
                        {PROVIDER_LABELS[p]}{!aiProvider.available[p] ? ' (not configured)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <span className="text-[12px] text-tx">Fallback order</span>
                  <div className="flex flex-col gap-1 mt-1">
                    {AI_PROVIDER_NAMES.filter(p => p !== aiProviderDraft.provider).map(p => (
                      <label key={p} className="flex items-center gap-2 text-[12px] text-tx">
                        <input
                          type="checkbox"
                          checked={aiProviderDraft.fallbacks.includes(p)}
                          onChange={() => toggleAiFallback(p)}
                        />
                        {PROVIDER_LABELS[p]}{!aiProvider.available[p] ? ' (not configured)' : ''}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2 pt-1">
                  {aiProviderError && <p className="text-red-fg text-[12px] mr-auto">{aiProviderError}</p>}
                  {aiProviderSaved && !aiProviderError && <p className="text-green-fg text-[12px] mr-auto">Saved</p>}
                  <button
                    onClick={handleSaveAiProvider}
                    disabled={savingAiProvider}
                    className="px-4 py-1.5 bg-accent hover:bg-accent-hover text-white rounded-control text-[13px] font-medium disabled:opacity-50 transition-colors"
                  >
                    {savingAiProvider ? 'Saving…' : 'Save provider'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {isAdmin && (
          <div className="bg-surface border border-border rounded-card overflow-hidden">
            <div className="px-6 py-4 border-b border-border">
              <span className="font-display text-[16px] font-semibold">Retention &amp; rate limits</span>
            </div>
            {!operationalDraft ? (
              <div className="p-8 text-center text-[13px] text-tx-3">{operationalError || 'Loading…'}</div>
            ) : (
              <div className="p-4 space-y-3">
                <p className="text-[11px] text-tx-4">
                  Previously env-var-only knobs — now editable here without a redeploy. Changes to the cleanup
                  timers take effect on the next sweep (within a minute); rate limits take effect within 30s.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {OPERATIONAL_SETTING_FIELDS.map(field => (
                    <div key={field.key}>
                      <div className="text-[12px] text-tx mb-0.5">{field.label}</div>
                      <div className="text-[10.5px] text-tx-4 mb-1">{field.hint}</div>
                      <input
                        type="number"
                        min={field.min}
                        value={operationalDraft[field.key]}
                        onChange={e => setOperationalDraft(d => d && { ...d, [field.key]: Number(e.target.value) })}
                        className="w-full border border-border rounded-control px-2.5 py-1.5 text-[12.5px] font-mono bg-surface focus:outline-none focus:border-ink-bd"
                      />
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-end gap-2 pt-1">
                  {operationalError && <p className="text-red-fg text-[12px] mr-auto">{operationalError}</p>}
                  {operationalSaved && !operationalError && <p className="text-green-fg text-[12px] mr-auto">Saved</p>}
                  <button
                    onClick={handleSaveOperational}
                    disabled={savingOperational || JSON.stringify(operationalDraft) === JSON.stringify(operationalSettings)}
                    className="px-4 py-1.5 bg-accent hover:bg-accent-hover text-white rounded-control text-[13px] font-medium disabled:opacity-50 transition-colors"
                  >
                    {savingOperational ? 'Saving…' : 'Save settings'}
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
