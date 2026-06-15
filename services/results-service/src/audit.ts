import { Pool } from 'pg';
import { log } from './logger';

export type AuditAction = 'view' | 'export_pdf' | 'export_csv' | 'delete';
export type AuditResourceType = 'test_result' | 'script';

export interface AuditEntry {
  teamId?: string | null;
  userId?: string | null;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId: string;
}

// A failed audit write must never fail the request it's logging — errors are swallowed.
export const recordAudit = async (pool: Pool, entry: AuditEntry): Promise<void> => {
  try {
    await pool.query(
      `INSERT INTO audit_log (team_id, user_id, action, resource_type, resource_id) VALUES ($1, $2, $3, $4, $5)`,
      [entry.teamId ?? null, entry.userId ?? null, entry.action, entry.resourceType, entry.resourceId]
    );
  } catch (err) {
    log.warn({ err, entry }, 'Failed to write audit log entry');
  }
};
