import type { PermissionKey } from '@/shared/constants/permissions.js';

// The trusted identity `authenticate` attaches to req.auth.
export interface AuthContext {
  userId: string;
  organizationId: string;
  email: string;
  fullName: string;
  permissions: PermissionKey[];
  // Set when the request was made with an API key rather than a login session.
  apiKeyId?: string;
}
