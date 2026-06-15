'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import {
  getTeamMembers, addTeamMember, updateTeamMemberRole, removeTeamMember,
  getTeamQuota, updateTeamQuota,
  getTeamApiKeys, createTeamApiKey, revokeTeamApiKey,
  getAuditLog, eraseTeamData,
  TeamMemberRow, TeamRole, TeamQuota, TeamUsage, TeamApiKeyRow, TeamApiKeyCreated, AuditLogEntry,
} from '@/lib/api';

const ROLES: TeamRole[] = ['admin', 'member', 'viewer'];

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

  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
  const [auditError, setAuditError] = useState('');

  const [eraseConfirming, setEraseConfirming] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [eraseError, setEraseError] = useState('');
  const [eraseResult, setEraseResult] = useState<string | null>(null);

  const load = async () => {
    if (!teamId || teamId === 'dev') return;
    try {
      setMembers(await getTeamMembers(teamId));
    } catch {
      setError('Failed to load team members');
    }
    try {
      const { quota: q, usage: u } = await getTeamQuota(teamId);
      setQuota(q);
      setUsage(u);
      setQuotaDraft(q);
    } catch {
      setQuotaError('Failed to load usage & limits');
    }
    if (isAdmin) {
      try {
        setApiKeys(await getTeamApiKeys(teamId));
      } catch {
        setApiKeyError('Failed to load API keys');
      }
      try {
        const { entries } = await getAuditLog(teamId);
        setAuditLog(entries);
      } catch {
        setAuditError('Failed to load audit log');
      }
    }
  };

  useEffect(() => { load(); }, [teamId]);

  if (!teamId || teamId === 'dev') {
    return (
      <div className="p-4 lg:p-6">
        <h1 className="text-[15px] font-semibold text-[#24292f] mb-4">Team</h1>
        <p className="text-[13px] text-[#57606a]">Team management is not available — auth is disabled (dev mode).</p>
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
    <div className="p-4 lg:p-6 space-y-4">
      <h1 className="text-[15px] font-semibold text-[#24292f]">Team{currentTeam ? `: ${currentTeam.name}` : ''}</h1>

      {isAdmin && (
        <div className="bg-white border border-[#d0d7de] rounded-md overflow-hidden">
          <div className="px-4 py-2 bg-[#f6f8fa] border-b border-[#d0d7de]">
            <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Add Member</span>
          </div>
          <div className="p-4 flex gap-2 items-center">
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="teammate@example.com"
              className="flex-1 border border-[#d0d7de] rounded-md px-3 py-1.5 text-[13px] bg-white text-[#24292f] focus:outline-none focus:border-[#0969da] focus:ring-2 focus:ring-[#0969da]/20 placeholder-[#8c959f]"
            />
            <select
              value={role}
              onChange={e => setRole(e.target.value as TeamRole)}
              className="border border-[#d0d7de] rounded-md px-3 py-1.5 text-[13px] bg-white text-[#24292f] focus:outline-none focus:border-[#0969da]"
            >
              {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <button
              onClick={handleAdd}
              disabled={saving}
              className="px-4 py-1.5 bg-[#1f883d] hover:bg-[#1a7f37] text-white rounded-md text-[13px] font-medium disabled:opacity-50 transition-colors"
            >
              {saving ? 'Adding…' : 'Add'}
            </button>
          </div>
          {error && <p className="px-4 pb-3 text-[#cf222e] text-[12px]">{error}</p>}
        </div>
      )}

      {!isAdmin && error && <p className="text-[#cf222e] text-[12px]">{error}</p>}

      <div className="bg-white border border-[#d0d7de] rounded-md overflow-hidden divide-y divide-[#eaeef2]">
        {members.length === 0 ? (
          <div className="p-8 text-center text-[13px] text-[#57606a]">No members</div>
        ) : (
          members.map(m => (
            <div key={m.userId} className="flex items-center justify-between px-4 py-3 hover:bg-[#f6f8fa]">
              <div className="min-w-0">
                <p className="text-[13px] font-mono text-[#24292f] truncate">{m.email}</p>
                {m.name && <p className="text-[11px] text-[#8c959f]">{m.name}</p>}
              </div>
              {isAdmin ? (
                <div className="flex items-center gap-3 flex-shrink-0">
                  <select
                    value={m.role}
                    onChange={e => handleRoleChange(m.userId, e.target.value as TeamRole)}
                    className="border border-[#d0d7de] rounded-md px-2 py-1 text-[12px] bg-white text-[#24292f] focus:outline-none focus:border-[#0969da]"
                  >
                    {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <button
                    onClick={() => handleRemove(m.userId)}
                    className="text-[11px] text-[#cf222e] hover:underline"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <span className="text-[10px] uppercase tracking-wide text-[#8c959f] flex-shrink-0">{m.role}</span>
              )}
            </div>
          ))
        )}
      </div>

      <div className="bg-white border border-[#d0d7de] rounded-md overflow-hidden">
        <div className="px-4 py-2 bg-[#f6f8fa] border-b border-[#d0d7de]">
          <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Usage &amp; Limits</span>
        </div>
        {!quota || !usage ? (
          <div className="p-8 text-center text-[13px] text-[#57606a]">
            {quotaError || 'Loading…'}
          </div>
        ) : (
          <div className="p-4 space-y-4">
            {QUOTA_FIELDS.map(({ key, label, usageKey }) => {
              const limit = quotaDraft[key] ?? quota[key];
              const used = usageKey ? usage[usageKey] : undefined;
              const pct = used !== undefined && limit ? Math.min(100, (used / limit) * 100) : 0;
              const barColor = pct >= 100 ? 'bg-[#cf222e]' : pct >= 80 ? 'bg-[#9a6700]' : 'bg-[#1f883d]';
              return (
                <div key={key}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[12px] text-[#24292f]">{label}</span>
                    {isAdmin ? (
                      <input
                        type="number"
                        min={1}
                        value={quotaDraft[key] ?? ''}
                        onChange={e => setQuotaDraft(d => ({ ...d, [key]: parseInt(e.target.value, 10) || 0 }))}
                        className="w-24 border border-[#d0d7de] rounded-md px-2 py-1 text-[12px] font-mono bg-white text-[#24292f] text-right focus:outline-none focus:border-[#0969da]"
                      />
                    ) : (
                      <span className="text-[12px] font-mono text-[#57606a]">
                        {used !== undefined ? `${used} / ${limit}` : limit}
                      </span>
                    )}
                  </div>
                  {usageKey && (
                    <div className="h-1.5 rounded-full bg-[#eaeef2] overflow-hidden">
                      <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
              );
            })}
            {isAdmin && (
              <div className="flex items-center justify-end gap-2 pt-2">
                {quotaError && <p className="text-[#cf222e] text-[12px] mr-auto">{quotaError}</p>}
                <button
                  onClick={handleSaveQuota}
                  disabled={savingQuota}
                  className="px-4 py-1.5 bg-[#1f883d] hover:bg-[#1a7f37] text-white rounded-md text-[13px] font-medium disabled:opacity-50 transition-colors"
                >
                  {savingQuota ? 'Saving…' : 'Save limits'}
                </button>
              </div>
            )}
            {!isAdmin && quotaError && <p className="text-[#cf222e] text-[12px]">{quotaError}</p>}
          </div>
        )}
      </div>

      {isAdmin && (
        <div className="bg-white border border-[#d0d7de] rounded-md overflow-hidden">
          <div className="px-4 py-2 bg-[#f6f8fa] border-b border-[#d0d7de]">
            <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">API Keys</span>
          </div>

          {newKey && (
            <div className="m-4 p-3 bg-[#ddf4ff] border border-[#54aeff] rounded-md">
              <p className="text-[12px] text-[#24292f] mb-2">
                API key created — copy it now, it won&apos;t be shown again:
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-[12px] font-mono bg-white border border-[#d0d7de] rounded px-2 py-1 overflow-x-auto">
                  {newKey.key}
                </code>
                <button
                  onClick={() => navigator.clipboard?.writeText(newKey.key)}
                  className="px-3 py-1 bg-[#0969da] hover:bg-[#0860ca] text-white rounded-md text-[12px] font-medium transition-colors"
                >
                  Copy
                </button>
                <button
                  onClick={() => setNewKey(null)}
                  className="px-3 py-1 border border-[#d0d7de] rounded-md text-[12px] hover:bg-[#f6f8fa] transition-colors"
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
              className="flex-1 border border-[#d0d7de] rounded-md px-3 py-1.5 text-[13px] bg-white text-[#24292f] focus:outline-none focus:border-[#0969da] focus:ring-2 focus:ring-[#0969da]/20 placeholder-[#8c959f]"
            />
            <button
              onClick={handleCreateKey}
              disabled={creatingKey}
              className="px-4 py-1.5 bg-[#1f883d] hover:bg-[#1a7f37] text-white rounded-md text-[13px] font-medium disabled:opacity-50 transition-colors"
            >
              {creatingKey ? 'Generating…' : 'Generate key'}
            </button>
          </div>
          {apiKeyError && <p className="px-4 pb-3 text-[#cf222e] text-[12px]">{apiKeyError}</p>}

          {apiKeys.length === 0 ? (
            <div className="p-8 text-center text-[13px] text-[#57606a]">No API keys</div>
          ) : (
            <div className="divide-y divide-[#eaeef2] border-t border-[#d0d7de]">
              {apiKeys.map(k => (
                <div key={k.id} className="flex items-center justify-between px-4 py-3 hover:bg-[#f6f8fa]">
                  <div className="min-w-0">
                    <p className="text-[13px] font-mono text-[#24292f] truncate">
                      {k.name} {k.revoked && <span className="text-[10px] uppercase tracking-wide text-[#cf222e] ml-1">Revoked</span>}
                    </p>
                    <p className="text-[11px] text-[#8c959f]">
                      Created {new Date(k.createdAt).toLocaleDateString()}
                      {k.lastUsedAt ? ` · Last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : ' · Never used'}
                    </p>
                  </div>
                  {!k.revoked && (
                    <button
                      onClick={() => handleRevokeKey(k.id)}
                      className="text-[11px] text-[#cf222e] hover:underline flex-shrink-0"
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
        <div className="bg-white border border-[#d0d7de] rounded-md overflow-hidden">
          <div className="px-4 py-2 bg-[#f6f8fa] border-b border-[#d0d7de]">
            <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Audit Log</span>
          </div>
          {auditError && <p className="px-4 pt-3 text-[#cf222e] text-[12px]">{auditError}</p>}
          {auditLog.length === 0 ? (
            <div className="p-8 text-center text-[13px] text-[#57606a]">No audit log entries</div>
          ) : (
            <div className="divide-y divide-[#eaeef2]">
              {auditLog.map(entry => (
                <div key={entry.id} className="flex items-center justify-between px-4 py-2 hover:bg-[#f6f8fa]">
                  <div className="min-w-0">
                    <p className="text-[12px] font-mono text-[#24292f] truncate">
                      {entry.action} <span className="text-[#8c959f]">{entry.resourceType}</span> {entry.resourceId.slice(0, 8)}
                    </p>
                    <p className="text-[11px] text-[#8c959f]">{entry.userEmail ?? 'unknown user'}</p>
                  </div>
                  <span className="text-[11px] font-mono text-[#57606a] flex-shrink-0">
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {isAdmin && (
        <div className="bg-white border border-[#cf222e]/40 rounded-md overflow-hidden">
          <div className="px-4 py-2 bg-[#fff0f0] border-b border-[#cf222e]/40">
            <span className="text-[11px] font-semibold text-[#cf222e] uppercase tracking-wide">Danger Zone</span>
          </div>
          <div className="p-4 flex items-center justify-between gap-4">
            <div>
              <p className="text-[13px] text-[#24292f] font-medium">Erase all team data</p>
              <p className="text-[11px] text-[#8c959f]">
                Permanently deletes all test results, live metrics, scripts, schedules, presets, webhooks, log sources, and audit log entries for this team. This cannot be undone.
              </p>
            </div>
            <button
              onClick={handleEraseData}
              disabled={erasing}
              className="px-4 py-1.5 bg-[#cf222e] hover:bg-[#a40e26] text-white rounded-md text-[13px] font-medium disabled:opacity-50 transition-colors flex-shrink-0"
            >
              {erasing ? 'Erasing…' : eraseConfirming ? 'Click again to confirm' : 'Erase all data'}
            </button>
          </div>
          {eraseError && <p className="px-4 pb-3 text-[#cf222e] text-[12px]">{eraseError}</p>}
          {eraseResult && <p className="px-4 pb-3 text-[#1f883d] text-[12px]">{eraseResult}</p>}
        </div>
      )}
    </div>
  );
}
