import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/config/database.js';
import { notifications, permissions, rolePermissions, userRoles, users } from '@/database/schema/index.js';
import { logger } from '@/shared/utils/logger.js';

type Person = { id: string; name: string };

// Scheduled and overdue workflows have no person acting, so they run as the user who created them ("assign to actor" and
// notifications need a real user). `problem` says why that user cannot be used; `willRunAs` is who would actually run it now.
export type RunAs = { problem: 'missing' | 'inactive' | null; creator: Person | null; willRunAs: Person | null };

// The longest-standing active user who may edit workflows (settings.manage): the sensible person to take over an orphaned schedule.
async function fallbackAdmin(organizationId: string): Promise<Person | null> {
  const [row] = await db
    .select({ id: users.id, name: users.fullName })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(and(eq(users.organizationId, organizationId), eq(users.isActive, true), eq(permissions.key, 'settings.manage')))
    .orderBy(asc(users.createdAt))
    .limit(1);
  return row ?? null;
}

// Memoises the fallback lookup, so describing many workflows of one organization costs one admin query at most.
export function runAsResolver(organizationId: string) {
  let fallback: Promise<Person | null> | undefined;
  return async (createdBy: string | null): Promise<RunAs> => {
    const [creator] = createdBy
      ? await db
          .select({ id: users.id, name: users.fullName, isActive: users.isActive })
          .from(users)
          .where(and(eq(users.id, createdBy), eq(users.organizationId, organizationId)))
          .limit(1)
      : [];
    if (creator?.isActive) return { problem: null, creator: { id: creator.id, name: creator.name }, willRunAs: { id: creator.id, name: creator.name } };
    fallback ??= fallbackAdmin(organizationId);
    return {
      problem: creator ? 'inactive' : 'missing',
      creator: creator ? { id: creator.id, name: creator.name } : null,
      willRunAs: await fallback,
    };
  };
}

const FALLBACK_RECIPIENTS = 3;

// Who should hear that a workflow needs attention: its creator, else an active admin, else (when the organization has no admin at all)
// the longest-standing active users, since somebody has to be able to escalate it.
async function recipientsFor(organizationId: string, createdBy: string | null): Promise<string[]> {
  const { willRunAs } = await runAsResolver(organizationId)(createdBy);
  if (willRunAs) return [willRunAs.id];
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.isActive, true)))
    .orderBy(asc(users.createdAt))
    .limit(FALLBACK_RECIPIENTS);
  return rows.map((r) => r.id);
}

// Never throws. dedupeKey makes a repeat (a retry, a second instance) a no-op for each recipient.
export async function notifyWorkflowOwners({
  organizationId,
  createdBy,
  title,
  body,
  dedupeKey,
}: {
  organizationId: string;
  createdBy: string | null;
  title: string;
  body: string;
  dedupeKey: string;
}): Promise<void> {
  try {
    const recipients = await recipientsFor(organizationId, createdBy);
    if (recipients.length === 0) return;
    await db
      .insert(notifications)
      .values(recipients.map((userId) => ({ organizationId, userId, type: 'workflow', title, body, dedupeKey })))
      .onConflictDoNothing();
  } catch (err) {
    logger.error({ err, dedupeKey }, 'Failed to notify workflow owners');
  }
}
