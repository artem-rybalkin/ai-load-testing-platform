import type { OrgRole, TeamRole, TeamQuota, TeamUsage } from '@alt/shared';
import { f, orgJson, RESULTS_URL } from './core';

export type { OrgRole };

export interface OrgMemberRow { userId: string; email: string; name: string | null; role: OrgRole }
export interface OrgTeamSummary { id: string; name: string; quota: TeamQuota; usage: TeamUsage }
export interface OrgDetail {
  org: { id: string; name: string; createdAt: string };
  members: OrgMemberRow[];
  teams: OrgTeamSummary[];
  role: OrgRole;
}

export const createOrg = (name: string): Promise<{ id: string; name: string; role: OrgRole }> =>
  f(`${RESULTS_URL}/orgs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(orgJson<{ id: string; name: string; role: OrgRole }>());

export const getOrg = (orgId: string): Promise<OrgDetail> =>
  f(`${RESULTS_URL}/orgs/${orgId}`).then(orgJson<OrgDetail>());

export const addOrgMember = (orgId: string, email: string, role: OrgRole = 'member'): Promise<{ success: boolean }> =>
  f(`${RESULTS_URL}/orgs/${orgId}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, role }),
  }).then(orgJson<{ success: boolean }>());

export const updateOrgMemberRole = (orgId: string, userId: string, role: OrgRole): Promise<{ success: boolean }> =>
  f(`${RESULTS_URL}/orgs/${orgId}/members/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  }).then(orgJson<{ success: boolean }>());

export const removeOrgMember = (orgId: string, userId: string): Promise<{ success: boolean }> =>
  f(`${RESULTS_URL}/orgs/${orgId}/members/${userId}`, { method: 'DELETE' }).then(orgJson<{ success: boolean }>());

export const createOrgTeam = (orgId: string, name: string): Promise<{ id: string; name: string; role: TeamRole }> =>
  f(`${RESULTS_URL}/orgs/${orgId}/teams`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(orgJson<{ id: string; name: string; role: TeamRole }>());
