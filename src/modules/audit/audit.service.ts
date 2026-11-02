import { audit } from '@/shared/utils/audit.js';
import { auditRepository } from './audit.repository.js';
import type { AuditListQuery } from './audit.validation.js';

export interface RequestAuditEntry {
  organizationId: string;
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string | null;
  changes: unknown;
  diff?: Record<string, { from: unknown; to: unknown }> | null;
  statusCode: number;
  requestId: string | undefined;
  ipAddress: string | undefined;
  apiKeyId?: string | undefined;
}

class AuditService {
  // Goes through the shared audit() helper (which never throws), so request-level rows land in the same table as the explicit ones.
  recordRequest({ changes, diff, statusCode, requestId, ipAddress, apiKeyId, ...entry }: RequestAuditEntry) {
    return audit({
      ...entry,
      metadata: { source: 'request', statusCode, requestId, ipAddress, changes, ...(apiKeyId && { apiKeyId }), ...(diff && { diff }) },
    });
  }

  list({ organizationId, query }: { organizationId: string; query: AuditListQuery }) {
    return auditRepository.list({ organizationId, query });
  }
}

export const auditService = new AuditService();
