import { and, asc, eq, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db } from '@/config/database.js';
import { notifications, permissions, rolePermissions, userRoles, users } from '@/database/schema/index.js';
import { enqueueWebhookEvent } from '@/modules/webhooks/webhooks.dispatcher.js';
import { enqueueWorkflowEvent } from '@/modules/workflows/workflows.events.js';
import { logger } from '@/shared/utils/logger.js';

const TICK_MS = 60_000;
const BATCH = 100;
const ADMINS = 5;

type Claimed = {
  id: string;
  organization_id: string;
  ticket_number: number;
  subject: string;
  priority: string;
  status: string;
  assigned_to: string | null;
  sla_due_at: Date;
  first_response_due_at: Date | null;
};
const returning = sql`returning t.id, t.organization_id, t.ticket_number, t.subject, t.priority, t.status, t.assigned_to, t.sla_due_at, t.first_response_due_at`;

// Each kind of alert is claimed with one UPDATE ... skip locked that stamps the ticket, so several instances running this at once raise
// every alert exactly once (the notification dedupe key is a second guard).
const claims = {
  // Past warnAtPercent of the way to the deadline, but not yet late.
  sla_warning: () => sql`
    update support_tickets t set sla_warned_at = now()
    from (select s.id from support_tickets s left join sla_policies p on p.organization_id = s.organization_id
          where s.status = 'open' and s.sla_warned_at is null and s.sla_due_at >= now()
            and s.created_at + (s.sla_due_at - s.created_at) * (coalesce(p.warn_at_percent, 80) / 100.0)::float8 <= now()
          order by s.sla_due_at limit ${BATCH} for update of s skip locked) due
    where t.id = due.id ${returning}`,
  sla_breached: () => sql`
    update support_tickets t set sla_breach_notified_at = now()
    from (select s.id from support_tickets s
          where s.status = 'open' and s.sla_breach_notified_at is null and s.sla_due_at < now()
          order by s.sla_due_at limit ${BATCH} for update of s skip locked) due
    where t.id = due.id ${returning}`,
  first_response_breached: () => sql`
    update support_tickets t set first_response_breach_notified_at = now()
    from (select s.id from support_tickets s
          where s.status = 'open' and s.first_response_breach_notified_at is null and s.first_responded_at is null and s.first_response_due_at < now()
          order by s.first_response_due_at limit ${BATCH} for update of s skip locked) due
    where t.id = due.id ${returning}`,
} as const;

type Kind = keyof typeof claims;

const text = (kind: Kind, t: Claimed) => {
  const ticket = `Ticket #${t.ticket_number}`;
  if (kind === 'sla_warning') return { title: `${ticket} is close to its SLA deadline`, body: t.subject };
  if (kind === 'sla_breached') return { title: `${ticket} breached its SLA`, body: t.subject };
  return { title: `${ticket} has no reply past its first-response target`, body: t.subject };
};

// The longest-standing active users who can manage settings: who an alert escalates to when it is serious or nobody owns the ticket.
async function admins(organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(and(eq(users.organizationId, organizationId), eq(users.isActive, true), eq(permissions.key, 'settings.manage')))
    .orderBy(asc(users.createdAt))
    .limit(ADMINS);
  return [...new Set(rows.map((r) => r.id))];
}

async function activeAmong(organizationId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.isActive, true), inArray(users.id, ids)));
  return rows.map((r) => r.id);
}

async function raise(kind: Kind, tickets: Claimed[]) {
  const adminsByOrg = new Map<string, Promise<string[]>>();
  for (const t of tickets) {
    try {
      const owner = await activeAmong(t.organization_id, t.assigned_to ? [t.assigned_to] : []);
      // A warning goes to whoever owns the ticket (or the admins when nobody does); a breach also goes to the admins.
      let recipients = owner;
      if (kind !== 'sla_warning' || owner.length === 0) {
        if (!adminsByOrg.has(t.organization_id)) adminsByOrg.set(t.organization_id, admins(t.organization_id));
        recipients = [...new Set([...owner, ...(await adminsByOrg.get(t.organization_id)!)])];
      }
      const due = (kind === 'first_response_breached' ? t.first_response_due_at : t.sla_due_at) ?? t.sla_due_at;
      const { title, body } = text(kind, t);
      if (recipients.length > 0) {
        await db
          .insert(notifications)
          .values(
            recipients.map((userId) => ({
              organizationId: t.organization_id,
              userId,
              type: 'ticket_sla',
              title,
              body,
              link: `/support/${t.id}`,
              relatedType: 'ticket',
              relatedId: t.id,
              dedupeKey: `${kind}:${t.id}:${new Date(due).getTime()}`,
            })),
          )
          .onConflictDoNothing();
      }
      const values = {
        id: t.id,
        ticketNumber: t.ticket_number,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        assignedTo: t.assigned_to,
        slaDueAt: t.sla_due_at,
        firstResponseDueAt: t.first_response_due_at,
      };
      const event = `tickets.${kind}`;
      void enqueueWebhookEvent({ organizationId: t.organization_id, event, data: values });
      // A workflow runs as somebody: the ticket's owner, else the first admin. A ticket nobody can act for only fires the webhook.
      const actorId = owner[0] ?? recipients[0];
      if (actorId) await enqueueWorkflowEvent({ organizationId: t.organization_id, actorId, event, id: t.id, values, changed: [], depth: 0 });
    } catch (err) {
      logger.error({ err, ticketId: t.id, kind }, 'Failed to raise SLA alert');
    }
  }
}

// One pass: raises every alert that has come due. Exported so tests can run it.
export async function scanSla(): Promise<Record<Kind, number>> {
  const counts = { sla_warning: 0, sla_breached: 0, first_response_breached: 0 };
  for (const kind of Object.keys(claims) as Kind[]) {
    const { rows } = await db.execute<Claimed>(claims[kind]());
    counts[kind] = rows.length;
    await raise(kind, rows);
  }
  return counts;
}

export function startSlaScheduler(): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await scanSla();
    } catch (err) {
      logger.error({ err }, 'SLA scan failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
