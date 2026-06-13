'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import {
  getOrg, addOrgMember, updateOrgMemberRole, removeOrgMember, createOrgTeam,
  OrgDetail, OrgRole,
} from '@/lib/api';

const ORG_ROLES: OrgRole[] = ['owner', 'admin', 'member'];

export default function OrgPage() {
  const { user } = useAuth();
  const orgs = user?.orgs ?? [];

  const [orgId, setOrgId] = useState<string>(orgs[0]?.id ?? '');
  const [detail, setDetail] = useState<OrgDetail | null>(null);
  const [error, setError] = useState('');

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('member');
  const [saving, setSaving] = useState(false);

  const [teamName, setTeamName] = useState('');
  const [teamError, setTeamError] = useState('');
  const [savingTeam, setSavingTeam] = useState(false);

  const load = async (id: string) => {
    if (!id) return;
    try {
      setDetail(await getOrg(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load organization');
    }
  };

  useEffect(() => { load(orgId); }, [orgId]);

  if (orgs.length === 0) {
    return (
      <div className="p-4 lg:p-6">
        <h1 className="text-[15px] font-semibold text-[#24292f] mb-4">Organization</h1>
        <p className="text-[13px] text-[#57606a]">You are not a member of any organization.</p>
      </div>
    );
  }

  const isAdmin = detail?.role === 'owner' || detail?.role === 'admin';

  const handleAddMember = async () => {
    if (!email.trim()) { setError('Email is required'); return; }
    setSaving(true);
    setError('');
    try {
      await addOrgMember(orgId, email.trim(), role);
      setEmail('');
      setRole('member');
      await load(orgId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add member');
    } finally {
      setSaving(false);
    }
  };

  const handleRoleChange = async (userId: string, newRole: OrgRole) => {
    setError('');
    try {
      await updateOrgMemberRole(orgId, userId, newRole);
      await load(orgId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role');
    }
  };

  const handleRemove = async (userId: string) => {
    setError('');
    try {
      await removeOrgMember(orgId, userId);
      await load(orgId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove member');
    }
  };

  const handleCreateTeam = async () => {
    if (!teamName.trim()) { setTeamError('Name is required'); return; }
    setSavingTeam(true);
    setTeamError('');
    try {
      await createOrgTeam(orgId, teamName.trim());
      setTeamName('');
      await load(orgId);
    } catch (err) {
      setTeamError(err instanceof Error ? err.message : 'Failed to create team');
    } finally {
      setSavingTeam(false);
    }
  };

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-[15px] font-semibold text-[#24292f]">
          Organization{detail ? `: ${detail.org.name}` : ''}
        </h1>
        {orgs.length > 1 && (
          <select
            value={orgId}
            onChange={e => setOrgId(e.target.value)}
            className="border border-[#d0d7de] rounded-md px-2 py-1 text-[12px] bg-white text-[#24292f] focus:outline-none focus:border-[#0969da]"
          >
            {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        )}
      </div>

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
              onChange={e => setRole(e.target.value as OrgRole)}
              className="border border-[#d0d7de] rounded-md px-3 py-1.5 text-[13px] bg-white text-[#24292f] focus:outline-none focus:border-[#0969da]"
            >
              {ORG_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <button
              onClick={handleAddMember}
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
        {!detail || detail.members.length === 0 ? (
          <div className="p-8 text-center text-[13px] text-[#57606a]">No members</div>
        ) : (
          detail.members.map(m => (
            <div key={m.userId} className="flex items-center justify-between px-4 py-3 hover:bg-[#f6f8fa]">
              <div className="min-w-0">
                <p className="text-[13px] font-mono text-[#24292f] truncate">{m.email}</p>
                {m.name && <p className="text-[11px] text-[#8c959f]">{m.name}</p>}
              </div>
              {isAdmin ? (
                <div className="flex items-center gap-3 flex-shrink-0">
                  <select
                    value={m.role}
                    onChange={e => handleRoleChange(m.userId, e.target.value as OrgRole)}
                    className="border border-[#d0d7de] rounded-md px-2 py-1 text-[12px] bg-white text-[#24292f] focus:outline-none focus:border-[#0969da]"
                  >
                    {ORG_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
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
          <span className="text-[11px] font-semibold text-[#57606a] uppercase tracking-wide">Teams</span>
        </div>
        {!detail || detail.teams.length === 0 ? (
          <div className="p-8 text-center text-[13px] text-[#57606a]">No teams</div>
        ) : (
          <div className="divide-y divide-[#eaeef2]">
            {detail.teams.map(t => (
              <div key={t.id} className="flex items-center justify-between px-4 py-3 hover:bg-[#f6f8fa]">
                <p className="text-[13px] font-mono text-[#24292f]">{t.name}</p>
                <p className="text-[11px] text-[#8c959f] font-mono">
                  {t.usage.concurrentTests}/{t.quota.maxConcurrentTests} running ·{' '}
                  {t.usage.scheduledTests}/{t.quota.maxScheduledTests} schedules ·{' '}
                  {t.usage.geminiCallsToday}/{t.quota.maxGeminiCallsPerDay} AI calls today
                </p>
              </div>
            ))}
          </div>
        )}
        {isAdmin && (
          <div className="p-4 flex gap-2 items-center border-t border-[#d0d7de]">
            <input
              type="text"
              value={teamName}
              onChange={e => setTeamName(e.target.value)}
              placeholder="New team name"
              className="flex-1 border border-[#d0d7de] rounded-md px-3 py-1.5 text-[13px] bg-white text-[#24292f] focus:outline-none focus:border-[#0969da] focus:ring-2 focus:ring-[#0969da]/20 placeholder-[#8c959f]"
            />
            <button
              onClick={handleCreateTeam}
              disabled={savingTeam}
              className="px-4 py-1.5 bg-[#1f883d] hover:bg-[#1a7f37] text-white rounded-md text-[13px] font-medium disabled:opacity-50 transition-colors"
            >
              {savingTeam ? 'Creating…' : '+ New team'}
            </button>
          </div>
        )}
        {teamError && <p className="px-4 pb-3 text-[#cf222e] text-[12px]">{teamError}</p>}
      </div>
    </div>
  );
}
