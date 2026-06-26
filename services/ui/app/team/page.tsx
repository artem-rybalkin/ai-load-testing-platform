'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import {
  getTeamMembers, addTeamMember, updateTeamMemberRole, removeTeamMember,
  getTeamQuota, updateTeamQuota,
  getTeamApiKeys, createTeamApiKey, revokeTeamApiKey,
  getAuditLog, eraseTeamData,
  getAiProvider, setTeamAiProvider, clearTeamAiProvider,
  TeamMemberRow, TeamRole, TeamQuota, TeamUsage, TeamApiKeyRow, TeamApiKeyCreated, AuditLogEntry, AiProviderConfig, AiProviderName,
} from '@/lib/api';

const ROLES: TeamRole[] = ['admin', 'member', 'viewer'];

// Mirrors @alt/shared's AI_PROVIDER_NAMES — duplicated locally because Vite/Rollup
// cannot statically resolve value exports re-exported via `export *` from the
// shared package's compiled CJS output.
const AI_PROVIDER_NAMES: AiProviderName[] = ['gemini', 'openai', 'anthropic'];

const PROVIDER_LABELS: Record<AiProviderName, string> = {
  gemini: 'Gemini',
  openai: 'OpenAI',
  anthropic: 'Claude (Anthropic)',
};

const QUOTA_FIELDS: { key: keyof TeamQuota; label: string; usageKey?: keyof TeamUsage }[] = [
  { key: 'maxConcurrentTests', label: 'Concurrent Tests', usageKey: 'concurrentTests' },
  { key: 'maxVusPerTest', label: 'Max VUs / Sessions per Test' },
  { key: 'maxTestDurationSeconds', label: 'Max Test Duration (s)' },
  { key: 'maxScheduledTests', label: 'Enabled Schedules', usageKey: 'scheduledTests' },
  { key: 'maxGeminiCallsPerDay', label: 'AI (Gemini) Calls / Day', usageKey: 'geminiCallsToday' },
];

export default function TeamPage() {
  const { user } = useAuth();
  const teamId = user?.currentTeamId;
  const isAdmin = user?.role === 'admin';

  const [members, setMembers] = useState<TeamMemberRow[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRole>('member');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const [quota, setQuota] = useState<TeamQuota | null>(null);
  const [usage, setUsage] = useState<TeamUsage | null>(null);
  const [quotaDraft, setQuotaDraft] = useState<Partial<TeamQuota>>({});
  const [quotaError, setQuotaError] = useState('');
  const [savingQuota, setSavingQuota] = useState(false);

  const [apiKeys, setApiKeys] = useState<TeamApiKeyRow[]>([]);
  const [apiKeyName, setApiKeyName] = useState('');
  const [apiKeyError, setApiKeyError] = useState('');
  const [creatingKey, setCreatingKey] = useState(false);
  const [newKey, setNewKey] = useState<TeamApiKeyCreated | null>(null);

  const [aiProvider, setAiProviderState] = useState<AiProviderConfig | null>(null);
  const [aiProviderDraft, setAiProviderDraft] = useState<{ provider: AiProviderName; fallbacks: AiProviderName[] }>({ provider: 'gemini', fallbacks: [] });
  const [aiProviderError, setAiProviderError] = useState('');
  const [savingAiProvider, setSavingAiProvider] = useState(false);

  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
  const [auditError, setAuditError] = useState('');

  const [eraseConfirming, setEraseConfirming] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [eraseError, setEraseError] = useState('');
  const [eraseResult, setEraseResult] = useState<string | null>(null);

  const load = async () => {
    if (!teamId || teamId === 'dev') return;

    if (isAdmin) {
      const [membersRes, quotaRes, apiKeysRes, auditRes, aiRes] = await Promise.allSettled([
        getTeamMembers(teamId),
        getTeamQuota(teamId),
        getTeamApiKeys(teamId),
        getAuditLog(teamId),
        getAiProvider(teamId),
      ]);

      if (membersRes.status === 'fulfilled') {
        setMembers(membersRes.value);
      } else {
        setError('Failed to load team members');
      }

      if (quotaRes.status === 'fulfilled') {
        const { quota: q, usage: u } = quotaRes.value;
        setQuota(q);
        setUsage(u);
        setQuotaDraft(q);
      } else {
        setQuotaError('Failed to load usage & limits');
      }

      if (apiKeysRes.status === 'fulfilled') {
        setApiKeys(apiKeysRes.value);
      } else {
        setApiKeyError('Failed to load API keys');
      }

      if (auditRes.status === 'fulfilled') {
        setAuditLog(auditRes.value.entries);
      } else {
        setAuditError('Failed to load audit log');
      }

      if (aiRes.status === 'fulfilled') {
        const cfg = aiRes.value;
        setAiProviderState(cfg);
        setAiProviderDraft({ provider: cfg.provider, fallbacks: cfg.fallbacks });
      } else {
        setAiProviderError('Failed to load AI provider settings');
      }
    } else {
      const [membersRes, quotaRes] = await Promise.allSettled([
        getTeamMembers(teamId),
        getTeamQuota(teamId),
      ]);

      if (membersRes.status === 'fulfilled') {
        setMembers(membersRes.value);
      } else {
        setError('Failed to load team members');
      }

      if (quotaRes.status === 'fulfilled') {
        const { quota: q, usage: u } = quotaRes.value;
        setQuota(q);
        setUsage(u);
        setQuotaDraft(q);
      } else {
        setQuotaError('Failed to load usage & limits');
      }
    }
  };

  useEffect(() => { load(); }, [teamId]);

  if (!teamId || teamId === 'dev') {
    return (
      <div className="px-4 md:px-9 py-7.5">
        <h1 className="font-display text-[28px] font-bold tracking-[-0.02em] mb-4">Team</h1>
        <p className="text-[13px] text-tx-3">Team management is not available — auth is disabled (dev mode).</p>
      </div>
    );
  }

  const currentTeam = user?.teams.find(t => t.id === teamId);

  const handleAdd = async () => {
    if (!email.trim()) { setError('Email is required'); return; }
    setSaving(true);
    setError('');
    try {
      await addTeamMember(teamId, email.trim(), role);
      setEmail('');
      setRole('member');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add member');
    } finally {
      setSaving(false);
    }
  };

  const handleRoleChange = async (userId: string, newRole: TeamRole) => {
    setError('');
    try {
      await updateTeamMemberRole(teamId, userId, newRole);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role');
    }
  };

  const handleRemove = async (userId: string) => {
    setError('');
    try {
      await removeTeamMember(teamId, userId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove member');
    }
  };

  const handleSaveQuota = async () => {
    setSavingQuota(true);
    setQuotaError('');
    try {
      const { quota: q } = await updateTeamQuota(teamId, quotaDraft);
      setQuota(q);
      setQuotaDraft(q);
    } catch (err) {
      setQuotaError(err instanceof Error ? err.message : 'Failed to save limits');
    } finally {
      setSavingQuota(false);
    }
  };

  const handleCreateKey = async () => {
    if (!apiKeyName.trim()) { setApiKeyError('Name is required'); return; }
    setCreatingKey(true);
    setApiKeyError('');
    try {
      const created = await createTeamApiKey(teamId, apiKeyName.trim());
      setNewKey(created);
      setApiKeyName('');
      await load();
    } catch (err) {
      setApiKeyError(err instanceof Error ? err.message : 'Failed to create API key');
    } finally {
      setCreatingKey(false);
    }
  };

  const handleRevokeKey = async (keyId: string) => {
    setApiKeyError('');
    try {
      await revokeTeamApiKey(teamId, keyId);
      await load();
    } catch (err) {
      setApiKeyError(err instanceof Error ? err.message : 'Failed to revoke API key');
    }
  };

  const handleSaveAiProvider = async () => {
    if (!teamId) return;
    setSavingAiProvider(true);
    setAiProviderError('');
    try {
      const result = await setTeamAiProvider(teamId, aiProviderDraft.provider, aiProviderDraft.fallbacks);
      setAiProviderDraft(result);
      setAiProviderState(prev => prev ? { ...prev, ...result } : prev);
    } catch (err) {
      setAiProviderError(err instanceof Error ? err.message : 'Failed to save AI provider');
    } finally {
      setSavingAiProvider(false);
    }
  };

  const handleRevertAiProvider = async () => {
    if (!teamId) return;
    setSavingAiProvider(true);
    setAiProviderError('');
    try {
      await clearTeamAiProvider(teamId);
      const cfg = await getAiProvider(teamId);
      setAiProviderState(cfg);
      setAiProviderDraft({ provider: cfg.provider, fallbacks: cfg.fallbacks });
    } catch (err) {
      setAiProviderError(err instanceof Error ? err.message : 'Failed to revert AI provider');
    } finally {
      setSavingAiProvider(false);
    }
  };

  const toggleAiFallback = (p: AiProviderName) => {
    setAiProviderDraft(d => ({
      ...d,
      fallbacks: d.fallbacks.includes(p) ? d.fallbacks.filter(f => f !== p) : [...d.fallbacks, p],
    }));
  };

  const handleEraseData = async () => {
    if (!eraseConfirming) { setEraseConfirming(true); return; }
    setErasing(true);
    setEraseError('');
    try {
      const result = await eraseTeamData(teamId);
      setEraseResult(`Deleted ${result.deleted.testResults} test result(s), ${result.deleted.scripts} script(s), ${result.deleted.schedules} schedule(s).`);
      setEraseConfirming(false);
      await load();
    } catch (err) {
      setEraseError(err instanceof Error ? err.message : 'Failed to erase team data');
    } finally {
      setErasing(false);
    }
  };

  return (
    <div>
      <div className="px-4 md:px-9 pt-7.5">
        <div className="font-mono text-[11px] tracking-[0.16em] text-accent uppercase mb-1.5">— People</div>
        <h1 className="font-display text-[clamp(26px,6.5vw,38px)] font-bold tracking-[-0.025em] leading-none">Team{currentTeam ? `: ${currentTeam.name}` : ''}</h1>
      </div>
      <div className="px-4 md:px-9 py-6 flex flex-col gap-4">

      {isAdmin && (
        <div className="bg-surface border border-border rounded-card overflow-hidden">
          <div className="px-6 py-4 border-b border-border">
            <span className="font-display text-[16px] font-semibold">Add Member</span>
          </div>
          <div className="p-5 flex gap-2 items-center">
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="teammate@example.com"
              className="flex-1 border border-border rounded-control px-3 py-1.5 text-[13px] bg-surface text-tx focus:outline-none focus:border-ink-bd placeholder:text-tx-5"
            />
            <select
              value={role}
              onChange={e => setRole(e.target.value as TeamRole)}
              className="border border-border rounded-control px-3 py-1.5 text-[13px] bg-surface text-tx focus:outline-none focus:border-ink-bd"
            >
              {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <button
              onClick={handleAdd}
              disabled={saving}
              className="px-4 py-1.5 bg-accent hover:bg-accent-hover text-white rounded-control text-[13px] font-medium disabled:opacity-50 transition-colors"
            >
              {saving ? 'Adding…' : 'Add'}
            </button>
          </div>
          {error && <p className="px-4 pb-3 text-red-fg text-[12px]">{error}</p>}
        </div>
      )}

      {!isAdmin && error && <p className="text-red-fg text-[12px]">{error}</p>}

      <div className="bg-surface border border-border rounded-card overflow-hidden divide-y divide-line">
        {members.length === 0 ? (
          <div className="p-8 text-center text-[13px] text-tx-3">No members</div>
        ) : (
          members.map(m => (
            <div key={m.userId} className="flex items-center justify-between px-4 py-3 hover:bg-surface-2">
              <div className="min-w-0">
                <p className="text-[13px] font-mono text-tx truncate">{m.email}</p>
                {m.name && <p className="text-[11px] text-tx-4">{m.name}</p>}
              </div>
              {isAdmin ? (
                <div className="flex items-center gap-3 flex-shrink-0">
                  <select
                    value={m.role}
                    onChange={e => handleRoleChange(m.userId, e.target.value as TeamRole)}
                    className="border border-border rounded-control px-2 py-1 text-[12px] bg-surface text-tx focus:outline-none focus:border-ink-bd"
                  >
                    {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <button
                    onClick={() => handleRemove(m.userId)}
                    className="text-[11px] text-red-fg hover:underline"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <span className="text-[10px] uppercase tracking-wide text-tx-4 flex-shrink-0">{m.role}</span>
              )}
            </div>
          ))
        )}
      </div>

      <div className="bg-surface border border-border rounded-card overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <span className="font-display text-[16px] font-semibold">Usage &amp; Limits</span>
        </div>
        {!quota || !usage ? (
          <div className="p-8 text-center text-[13px] text-tx-3">
            {quotaError || 'Loading…'}
          </div>
        ) : (
          <div className="p-4 space-y-4">
            {QUOTA_FIELDS.map(({ key, label, usageKey }) => {
              const limit = quotaDraft[key] ?? quota[key];
              const used = usageKey ? usage[usageKey] : undefined;
              const pct = used !== undefined && limit ? Math.min(100, (used / limit) * 100) : 0;
              const barColor = pct >= 100 ? 'bg-status-fail' : pct >= 80 ? 'bg-status-slow' : 'bg-status-pass';
              return (
                <div key={key}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[12px] text-tx">{label}</span>
                    {isAdmin ? (
                      <input
                        type="number"
                        min={1}
                        value={quotaDraft[key] ?? ''}
                        onChange={e => setQuotaDraft(d => ({ ...d, [key]: parseInt(e.target.value, 10) || 0 }))}
                        className="w-24 border border-border rounded-control px-2 py-1 text-[12px] font-mono bg-surface text-tx text-right focus:outline-none focus:border-ink-bd"
                      />
                    ) : (
                      <span className="text-[12px] font-mono text-tx-3">
                        {used !== undefined ? `${used} / ${limit}` : limit}
                      </span>
                    )}
                  </div>
                  {usageKey && (
                    <div className="h-1.5 rounded-full bg-line overflow-hidden">
                      <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
              );
            })}
            {isAdmin && (
              <div className="flex items-center justify-end gap-2 pt-2">
                {quotaError && <p className="text-red-fg text-[12px] mr-auto">{quotaError}</p>}
                <button
                  onClick={handleSaveQuota}
                  disabled={savingQuota}
                  className="px-4 py-1.5 bg-accent hover:bg-accent-hover text-white rounded-control text-[13px] font-medium disabled:opacity-50 transition-colors"
                >
                  {savingQuota ? 'Saving…' : 'Save limits'}
                </button>
              </div>
            )}
            {!isAdmin && quotaError && <p className="text-red-fg text-[12px]">{quotaError}</p>}
          </div>
        )}
      </div>

      {isAdmin && (
        <div className="bg-surface border border-border rounded-card overflow-hidden">
          <div className="px-6 py-4 border-b border-border">
            <span className="font-display text-[16px] font-semibold">API Keys</span>
          </div>

          {newKey && (
            <div className="m-4 p-3 bg-orange-bg border border-orange-bd rounded-control">
              <p className="text-[12px] text-tx mb-2">
                API key created — copy it now, it won&apos;t be shown again:
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-[12px] font-mono bg-surface border border-border rounded px-2 py-1 overflow-x-auto">
                  {newKey.key}
                </code>
                <button
                  onClick={() => navigator.clipboard?.writeText(newKey.key)}
                  className="px-3 py-1 bg-accent hover:bg-accent-hover text-white rounded-control text-[12px] font-medium transition-colors"
                >
                  Copy
                </button>
                <button
                  onClick={() => setNewKey(null)}
                  className="px-3 py-1 border border-border rounded-control text-[12px] hover:bg-surface-2 transition-colors"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          <div className="p-4 flex gap-2 items-center">
            <input
              type="text"
              value={apiKeyName}
              onChange={e => setApiKeyName(e.target.value)}
              placeholder="Key name (e.g. CI pipeline)"
              className="flex-1 border border-border rounded-control px-3 py-1.5 text-[13px] bg-surface text-tx focus:outline-none focus:border-ink-bd placeholder:text-tx-5"
            />
            <button
              onClick={handleCreateKey}
              disabled={creatingKey}
              className="px-4 py-1.5 bg-accent hover:bg-accent-hover text-white rounded-control text-[13px] font-medium disabled:opacity-50 transition-colors"
            >
              {creatingKey ? 'Generating…' : 'Generate key'}
            </button>
          </div>
          {apiKeyError && <p className="px-4 pb-3 text-red-fg text-[12px]">{apiKeyError}</p>}

          {apiKeys.length === 0 ? (
            <div className="p-8 text-center text-[13px] text-tx-3">No API keys</div>
          ) : (
            <div className="divide-y divide-line border-t border-border">
              {apiKeys.map(k => (
                <div key={k.id} className="flex items-center justify-between px-4 py-3 hover:bg-surface-2">
                  <div className="min-w-0">
                    <p className="text-[13px] font-mono text-tx truncate">
                      {k.name} {k.revoked && <span className="text-[10px] uppercase tracking-wide text-red-fg ml-1">Revoked</span>}
                    </p>
                    <p className="text-[11px] text-tx-4">
                      Created {new Date(k.createdAt).toLocaleDateString()}
                      {k.lastUsedAt ? ` · Last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : ' · Never used'}
                    </p>
                  </div>
                  {!k.revoked && (
                    <button
                      onClick={() => handleRevokeKey(k.id)}
                      className="text-[11px] text-red-fg hover:underline flex-shrink-0"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {isAdmin && (
        <div className="bg-surface border border-border rounded-card overflow-hidden">
          <div className="px-6 py-4 border-b border-border flex items-center justify-between">
            <span className="font-display text-[16px] font-semibold">AI Provider</span>
            {aiProvider && (
              <span className={`text-[11px] px-2 py-0.5 rounded-full ${aiProvider.isOverride ? 'bg-orange-bg text-accent' : 'bg-surface-2 text-tx-3 border border-border'}`}>
                {aiProvider.isOverride ? 'Custom for this team' : 'Using platform default'}
              </span>
            )}
          </div>
          {!aiProvider ? (
            <div className="p-8 text-center text-[13px] text-tx-3">
              {aiProviderError || 'Loading…'}
            </div>
          ) : (
            <div className="p-4 space-y-3">
              <p className="text-[11px] text-tx-4">
                Choose which AI provider generates scripts and insights for this team. Fallbacks are tried in order if the primary provider is rate-limited or unreachable. Leave unset to use the platform default.
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
                {aiProvider.isOverride && (
                  <button
                    onClick={handleRevertAiProvider}
                    disabled={savingAiProvider}
                    className="px-4 py-1.5 border border-border hover:bg-surface-2 text-tx rounded-control text-[13px] font-medium disabled:opacity-50 transition-colors"
                  >
                    Revert to platform default
                  </button>
                )}
                <button
                  onClick={handleSaveAiProvider}
                  disabled={savingAiProvider}
                  className="px-4 py-1.5 bg-accent hover:bg-accent-hover text-white rounded-control text-[13px] font-medium disabled:opacity-50 transition-colors"
                >
                  {savingAiProvider ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {isAdmin && (
        <div className="bg-surface border border-border rounded-card overflow-hidden">
          <div className="px-6 py-4 border-b border-border">
            <span className="font-display text-[16px] font-semibold">Audit Log</span>
          </div>
          {auditError && <p className="px-4 pt-3 text-red-fg text-[12px]">{auditError}</p>}
          {auditLog.length === 0 ? (
            <div className="p-8 text-center text-[13px] text-tx-3">No audit log entries</div>
          ) : (
            <div className="divide-y divide-line">
              {auditLog.map(entry => (
                <div key={entry.id} className="flex items-center justify-between px-4 py-2 hover:bg-surface-2">
                  <div className="min-w-0">
                    <p className="text-[12px] font-mono text-tx truncate">
                      {entry.action} <span className="text-tx-4">{entry.resourceType}</span> {entry.resourceId.slice(0, 8)}
                    </p>
                    <p className="text-[11px] text-tx-4">{entry.userEmail ?? 'unknown user'}</p>
                  </div>
                  <span className="text-[11px] font-mono text-tx-3 flex-shrink-0">
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {isAdmin && (
        <div className="bg-surface border border-red-fg/30 rounded-card overflow-hidden">
          <div className="px-4 py-2 bg-red-bg border-b border-red-fg/30">
            <span className="text-[11px] font-semibold text-red-fg uppercase tracking-wide">Danger Zone</span>
          </div>
          <div className="p-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-[13px] text-tx font-medium">Erase all team data</p>
              <p className="text-[11px] text-tx-4">
                Permanently deletes all test results, live metrics, scripts, schedules, presets, webhooks, log sources, and audit log entries for this team. This cannot be undone.
              </p>
            </div>
            <button
              onClick={handleEraseData}
              disabled={erasing}
              className="px-4 py-1.5 bg-red-fg hover:bg-red-badge-fg text-white rounded-control text-[13px] font-medium disabled:opacity-50 transition-colors flex-shrink-0"
            >
              {erasing ? 'Erasing…' : eraseConfirming ? 'Click again to confirm' : 'Erase all data'}
            </button>
          </div>
          {eraseError && <p className="px-4 pb-3 text-red-fg text-[12px]">{eraseError}</p>}
          {eraseResult && <p className="px-4 pb-3 text-green-fg-2 text-[12px]">{eraseResult}</p>}
        </div>
      )}
      </div>
    </div>
  );
}
