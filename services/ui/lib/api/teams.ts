import type { TeamRole, TeamQuota, TeamUsage, AiProviderName } from '@alt/shared';
import { f, orgJson, RESULTS_URL } from './core';

export type { TeamRole, TeamQuota, TeamUsage, AiProviderName };

export interface TeamMemberRow { userId: string; email: string; name: string | null; role: TeamRole }

export interface AiProviderConfig {
  provider: AiProviderName;
  fallbacks: AiProviderName[];
  available: Record<AiProviderName, boolean>;
  isOverride?: boolean;
}

export interface AuditLogEntry {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string;
  createdAt: string;
  userEmail: string | null;
}

export interface EraseTeamDataResult {
  success: boolean;
  deleted: { testResults: number; scripts: number; schedules: number };
}

export const getTeamMembers = (teamId: string): Promise<TeamMemberRow[]> =>
  f(`${RESULTS_URL}/teams/${teamId}/members`).then(orgJson<TeamMemberRow[]>());

export const addTeamMember = (teamId: string, email: string, role: TeamRole = 'member'): Promise<{ success: boolean }> =>
  f(`${RESULTS_URL}/teams/${teamId}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, role }),
  }).then(orgJson<{ success: boolean }>());

export const updateTeamMemberRole = (teamId: string, userId: string, role: TeamRole): Promise<{ success: boolean }> =>
  f(`${RESULTS_URL}/teams/${teamId}/members/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  }).then(orgJson<{ success: boolean }>());

export const removeTeamMember = (teamId: string, userId: string): Promise<{ success: boolean }> =>
  f(`${RESULTS_URL}/teams/${teamId}/members/${userId}`, { method: 'DELETE' }).then(orgJson<{ success: boolean }>());

export const getTeamQuota = (teamId: string): Promise<{ quota: TeamQuota; usage: TeamUsage }> =>
  f(`${RESULTS_URL}/teams/${teamId}/quotas`).then(orgJson<{ quota: TeamQuota; usage: TeamUsage }>());

export const updateTeamQuota = (teamId: string, quota: Partial<TeamQuota>): Promise<{ quota: TeamQuota }> =>
  f(`${RESULTS_URL}/teams/${teamId}/quotas`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(quota),
  }).then(orgJson<{ quota: TeamQuota }>());

export const getAiProvider = (teamId?: string): Promise<AiProviderConfig> =>
  f(`${RESULTS_URL}/system/ai-provider${teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''}`).then(orgJson<AiProviderConfig>());

export const setAiProvider = (provider: AiProviderName, fallbacks: AiProviderName[]): Promise<{ provider: AiProviderName; fallbacks: AiProviderName[] }> =>
  f(`${RESULTS_URL}/system/ai-provider`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, fallbacks }),
  }).then(orgJson<{ provider: AiProviderName; fallbacks: AiProviderName[] }>());

export const setTeamAiProvider = (teamId: string, provider: AiProviderName, fallbacks: AiProviderName[]): Promise<{ provider: AiProviderName; fallbacks: AiProviderName[]; isOverride: boolean }> =>
  f(`${RESULTS_URL}/teams/${teamId}/ai-provider`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, fallbacks }),
  }).then(orgJson<{ provider: AiProviderName; fallbacks: AiProviderName[]; isOverride: boolean }>());

export const clearTeamAiProvider = (teamId: string): Promise<{ success: boolean }> =>
  f(`${RESULTS_URL}/teams/${teamId}/ai-provider`, { method: 'DELETE' }).then(orgJson<{ success: boolean }>());

export const getAuditLog = (teamId: string): Promise<{ entries: AuditLogEntry[] }> =>
  f(`${RESULTS_URL}/teams/${teamId}/audit-log`).then(orgJson<{ entries: AuditLogEntry[] }>());

export const eraseTeamData = (teamId: string): Promise<EraseTeamDataResult> =>
  f(`${RESULTS_URL}/teams/${teamId}/data`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).then(orgJson<EraseTeamDataResult>());
