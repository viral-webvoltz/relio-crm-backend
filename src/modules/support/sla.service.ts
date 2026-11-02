import { and, eq, sql } from 'drizzle-orm';
import { db, withTransaction, type DbExecutor } from '@/config/database.js';
import { slaPolicies, supportTickets } from '@/database/schema/index.js';
import { audit } from '@/shared/utils/audit.js';
import { defaultPolicy, dueDates, firstResponseState, resolutionState, type SlaPolicy } from './sla.policy.js';
import type { SlaPolicyInput } from './sla.validation.js';
import type { TicketPriority } from './tickets.sla.js';

const APPLY_LIMIT = 5_000;

type Ticket = typeof supportTickets.$inferSelect;

class SlaService {
  async getPolicy(organizationId: string, executor: DbExecutor = db): Promise<SlaPolicy & { isDefault: boolean }> {
    const [row] = await executor.select().from(slaPolicies).where(eq(slaPolicies.organizationId, organizationId));
    if (!row) return { ...defaultPolicy, isDefault: true };
    return { targets: row.targets, businessHours: row.businessHours, warnAtPercent: row.warnAtPercent, isDefault: false };
  }

  // The two deadlines for a ticket of this priority counted from `from` (its creation), under the organization's policy.
  async dueFor(organizationId: string, priority: TicketPriority, from: Date, executor: DbExecutor = db) {
    const { firstResponseDueAt, resolutionDueAt } = dueDates(await this.getPolicy(organizationId, executor), priority, from);
    return { slaDueAt: resolutionDueAt, firstResponseDueAt };
  }

  // What the ticket screen shows next to a ticket.
  describe(ticket: Ticket, policy: SlaPolicy, now = new Date()) {
    return {
      resolution: { dueAt: ticket.slaDueAt, resolvedAt: ticket.resolvedAt, state: resolutionState(ticket, policy.warnAtPercent, now) },
      firstResponse: ticket.firstResponseDueAt
        ? { dueAt: ticket.firstResponseDueAt, respondedAt: ticket.firstRespondedAt, state: firstResponseState(ticket, policy.warnAtPercent, now) }
        : null,
    };
  }

  async putPolicy({ organizationId, userId, input }: { organizationId: string; userId: string; input: SlaPolicyInput }) {
    const { applyToOpen, ...policy } = input;
    const updated = await withTransaction(async (tx) => {
      const values = {
        targets: policy.targets,
        businessHours: policy.businessHours,
        warnAtPercent: policy.warnAtPercent,
        updatedBy: userId,
        updatedAt: new Date(),
      };
      await tx
        .insert(slaPolicies)
        .values({ organizationId, ...values })
        .onConflictDoUpdate({ target: slaPolicies.organizationId, set: values });
      const moved = applyToOpen ? await this.applyToOpen(tx, organizationId, policy) : 0;
      await audit(
        { organizationId, actorUserId: userId, action: 'sla.policy_updated', targetType: 'sla_policy', metadata: { applyToOpen, ticketsMoved: moved } },
        tx,
      );
      return moved;
    });
    return { ...(await this.getPolicy(organizationId)), ticketsMoved: updated };
  }

  // Recomputes both deadlines of every open or pending ticket from its creation time, and re-arms its alerts.
  private async applyToOpen(tx: DbExecutor, organizationId: string, policy: SlaPolicy) {
    const open = await tx
      .select({
        id: supportTickets.id,
        priority: supportTickets.priority,
        createdAt: supportTickets.createdAt,
        hasFirstTarget: sql<boolean>`${supportTickets.firstResponseDueAt} is not null`,
      })
      .from(supportTickets)
      .where(and(eq(supportTickets.organizationId, organizationId), sql`${supportTickets.status} in ('open', 'pending')`))
      .limit(APPLY_LIMIT);
    for (const t of open) {
      const { firstResponseDueAt, resolutionDueAt } = dueDates(policy, t.priority as TicketPriority, t.createdAt);
      await tx
        .update(supportTickets)
        .set({
          slaDueAt: resolutionDueAt,
          // Tickets that predate first-response tracking stay without a first-reply target, so this cannot raise a flood of alerts.
          ...(t.hasFirstTarget && { firstResponseDueAt }),
          slaWarnedAt: null,
          slaBreachNotifiedAt: null,
          firstResponseBreachNotifiedAt: null,
        })
        .where(eq(supportTickets.id, t.id));
    }
    return open.length;
  }

  // Compliance over the last `days` days (by ticket creation), plus what needs attention right now.
  async summary({ organizationId, days }: { organizationId: string; days: number }) {
    const policy = await this.getPolicy(organizationId);
    const window = sql`${supportTickets.createdAt} >= now() - ${days} * interval '1 day'`;
    const org = eq(supportTickets.organizationId, organizationId);
    const result = await db.execute<{
      priority: string;
      total: number;
      resolved: number;
      resolved_in_time: number;
      replied: number;
      replied_in_time: number;
      avg_first_response_minutes: number | null;
    }>(sql`
      select priority,
             count(*)::int as total,
             (count(*) filter (where resolved_at is not null))::int as resolved,
             (count(*) filter (where resolved_at is not null and resolved_at <= sla_due_at))::int as resolved_in_time,
             (count(*) filter (where first_response_due_at is not null and first_responded_at is not null))::int as replied,
             (count(*) filter (where first_response_due_at is not null and first_responded_at <= first_response_due_at))::int as replied_in_time,
             round((avg(extract(epoch from (first_responded_at - created_at)) / 60) filter (where first_responded_at is not null))::numeric, 1)::float as avg_first_response_minutes
      from support_tickets where ${org} and ${window} group by priority`);
    const [attention] = (
      await db.execute<{ breached: number; at_risk: number; first_response_breached: number }>(sql`
        select (count(*) filter (where sla_due_at < now()))::int as breached,
               (count(*) filter (where sla_due_at >= now() and created_at + (sla_due_at - created_at) * (${policy.warnAtPercent} / 100.0)::float8 <= now()))::int as at_risk,
               (count(*) filter (where first_response_due_at < now() and first_responded_at is null))::int as first_response_breached
        from support_tickets where ${org} and status = 'open'`)
    ).rows;

    const byPriority = result.rows.map((r) => ({
      priority: r.priority,
      tickets: r.total,
      resolved: r.resolved,
      resolvedInTime: r.resolved_in_time,
      resolutionRate: r.resolved ? Math.round((r.resolved_in_time / r.resolved) * 100) : null,
      firstReplyRate: r.replied ? Math.round((r.replied_in_time / r.replied) * 100) : null,
      avgFirstResponseMinutes: r.avg_first_response_minutes,
    }));
    const sum = (pick: (r: (typeof result.rows)[number]) => number) => result.rows.reduce((n, r) => n + pick(r), 0);
    const resolved = sum((r) => r.resolved);
    const replied = sum((r) => r.replied);
    return {
      days,
      tickets: sum((r) => r.total),
      resolved,
      resolutionRate: resolved ? Math.round((sum((r) => r.resolved_in_time) / resolved) * 100) : null,
      firstReplyRate: replied ? Math.round((sum((r) => r.replied_in_time) / replied) * 100) : null,
      now: { breached: attention?.breached ?? 0, atRisk: attention?.at_risk ?? 0, firstResponseBreached: attention?.first_response_breached ?? 0 },
      byPriority,
    };
  }
}

export const slaService = new SlaService();
