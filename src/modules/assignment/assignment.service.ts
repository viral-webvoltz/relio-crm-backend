import { and, asc, count, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { db, withTransaction } from '@/config/database.js';
import { assignmentRules, leads, supportTickets, teamMembers, teams, users, type AssignmentTarget } from '@/database/schema/index.js';
import { notify } from '@/modules/notifications/notifier.js';
import { evaluateGroup, type Rule } from '@/modules/workflows/workflows.conditions.js';
import { BadRequestError, ConflictError, NotFoundError } from '@/shared/errors/index.js';
import { isUniqueViolation } from '@/database/soft-delete.js';
import { logger } from '@/shared/utils/logger.js';
import { leastLoaded, nextRoundRobin } from './assignment.pick.js';
import type { AssignmentResource, CreateRuleInput, CreateTeamInput, UpdateRuleInput, UpdateTeamInput } from './assignment.validation.js';

type Rule_ = typeof assignmentRules.$inferSelect;
export type Picked = { userId: string; ruleId: string; ruleName: string };

const OPEN_STATUSES = {
  leads: { column: leads.status, notIn: ['converted', 'unqualified'] },
  tickets: { column: supportTickets.status, in: ['open', 'pending'] },
} as const;

class AssignmentService {
  // ---- teams ----

  async listTeams(organizationId: string) {
    return db
      .select({ id: teams.id, name: teams.name, description: teams.description, createdAt: teams.createdAt, memberCount: count(teamMembers.userId) })
      .from(teams)
      .leftJoin(teamMembers, eq(teamMembers.teamId, teams.id))
      .where(eq(teams.organizationId, organizationId))
      .groupBy(teams.id)
      .orderBy(asc(teams.name));
  }

  async getTeam(organizationId: string, id: string) {
    const team = await this.findTeam(organizationId, id);
    const members = await db
      .select({ id: users.id, fullName: users.fullName, email: users.email, isActive: users.isActive })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(eq(teamMembers.teamId, id))
      .orderBy(asc(users.fullName));
    return { ...team, members };
  }

  async createTeam({ organizationId, input }: { organizationId: string; input: CreateTeamInput }) {
    try {
      const [team] = await db
        .insert(teams)
        .values({ organizationId, ...input })
        .returning();
      return team!;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('A team with this name already exists', 'TEAM_EXISTS');
      throw err;
    }
  }

  async updateTeam({ organizationId, id, input }: { organizationId: string; id: string; input: UpdateTeamInput }) {
    try {
      const [team] = await db
        .update(teams)
        .set(input)
        .where(and(eq(teams.organizationId, organizationId), eq(teams.id, id)))
        .returning();
      if (!team) throw new NotFoundError('Team not found');
      return team;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError('A team with this name already exists', 'TEAM_EXISTS');
      throw err;
    }
  }

  // Replaces the whole member list. Only active people of this organization can be members.
  async setMembers({ organizationId, id, userIds }: { organizationId: string; id: string; userIds: string[] }) {
    await this.findTeam(organizationId, id);
    await withTransaction(async (tx) => {
      if (userIds.length) {
        const found = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.organizationId, organizationId), eq(users.isActive, true), inArray(users.id, userIds)));
        if (found.length !== userIds.length) throw new BadRequestError('Every member must be an active user of this organization', 'INVALID_MEMBER');
      }
      await tx.delete(teamMembers).where(eq(teamMembers.teamId, id));
      if (userIds.length) await tx.insert(teamMembers).values(userIds.map((userId) => ({ teamId: id, userId, organizationId })));
    });
    return this.getTeam(organizationId, id);
  }

  async removeTeam({ organizationId, id }: { organizationId: string; id: string }) {
    await this.findTeam(organizationId, id);
    const [inUse] = await db
      .select({ name: assignmentRules.name })
      .from(assignmentRules)
      .where(and(eq(assignmentRules.organizationId, organizationId), sql`${assignmentRules.target}->>'teamId' = ${id}`))
      .limit(1);
    if (inUse) throw new ConflictError(`The rule "${inUse.name}" assigns to this team; change or delete it first`, 'TEAM_IN_USE');
    await db.delete(teams).where(eq(teams.id, id));
  }

  // ---- rules ----

  listRules({ organizationId, resource }: { organizationId: string; resource?: AssignmentResource | undefined }) {
    return db
      .select()
      .from(assignmentRules)
      .where(and(eq(assignmentRules.organizationId, organizationId), resource ? eq(assignmentRules.resource, resource) : undefined))
      .orderBy(asc(assignmentRules.resource), asc(assignmentRules.position), asc(assignmentRules.createdAt));
  }

  async createRule({ organizationId, input }: { organizationId: string; input: CreateRuleInput }) {
    await this.checkTarget(organizationId, input.target);
    const [last] = await db
      .select({ value: sql<number>`coalesce(max(${assignmentRules.position}), -1)`.mapWith(Number) })
      .from(assignmentRules)
      .where(and(eq(assignmentRules.organizationId, organizationId), eq(assignmentRules.resource, input.resource)));
    const [rule] = await db
      .insert(assignmentRules)
      .values({ organizationId, ...input, position: (last?.value ?? -1) + 1 })
      .returning();
    return rule!;
  }

  async updateRule({ organizationId, id, input }: { organizationId: string; id: string; input: UpdateRuleInput }) {
    if (input.target) await this.checkTarget(organizationId, input.target);
    // A new target restarts the rotation: the old cursor pointed into the old team.
    const [rule] = await db
      .update(assignmentRules)
      .set({ ...input, ...(input.target && { lastUserId: null }), updatedAt: new Date() })
      .where(and(eq(assignmentRules.organizationId, organizationId), eq(assignmentRules.id, id)))
      .returning();
    if (!rule) throw new NotFoundError('Rule not found');
    return rule;
  }

  async removeRule({ organizationId, id }: { organizationId: string; id: string }) {
    const deleted = await db
      .delete(assignmentRules)
      .where(and(eq(assignmentRules.organizationId, organizationId), eq(assignmentRules.id, id)))
      .returning({ id: assignmentRules.id });
    if (deleted.length === 0) throw new NotFoundError('Rule not found');
  }

  // The given order becomes the evaluation order. Every rule of that resource must be listed, so nothing is left in limbo.
  async reorder({ organizationId, resource, ids }: { organizationId: string; resource: AssignmentResource; ids: string[] }) {
    await withTransaction(async (tx) => {
      const existing = await tx
        .select({ id: assignmentRules.id })
        .from(assignmentRules)
        .where(and(eq(assignmentRules.organizationId, organizationId), eq(assignmentRules.resource, resource)));
      if (existing.length !== ids.length || existing.some((r) => !ids.includes(r.id))) {
        throw new BadRequestError('List every rule of this resource, each once', 'INVALID_ORDER');
      }
      for (const [position, id] of ids.entries()) await tx.update(assignmentRules).set({ position }).where(eq(assignmentRules.id, id));
    });
    return this.listRules({ organizationId, resource });
  }

  // ---- choosing ----

  // Who should get a new record: the first active rule that matches decides. dryRun reports the choice without moving the rotation on.
  async pick({
    organizationId,
    resource,
    values,
    dryRun = false,
  }: {
    organizationId: string;
    resource: AssignmentResource;
    values: Record<string, unknown>;
    dryRun?: boolean;
  }): Promise<Picked | null> {
    const rules = await db
      .select()
      .from(assignmentRules)
      .where(and(eq(assignmentRules.organizationId, organizationId), eq(assignmentRules.resource, resource), eq(assignmentRules.isActive, true)))
      .orderBy(asc(assignmentRules.position), asc(assignmentRules.createdAt));
    for (const rule of rules) {
      if (!evaluateGroup(rule.conditions.mode, rule.conditions.rules as Rule[], values, [])) continue;
      const userId = await this.choose(rule, resource, dryRun);
      if (userId) return { userId, ruleId: rule.id, ruleName: rule.name }; // a matching rule whose team is empty falls through to the next
    }
    return null;
  }

  // For the places that create records: routing must never be the reason a lead or ticket cannot be created.
  async safePick(args: { organizationId: string; resource: AssignmentResource; values: Record<string, unknown> }): Promise<Picked | null> {
    try {
      return await this.pick(args);
    } catch (err) {
      logger.error({ err, resource: args.resource }, 'Auto-assignment failed; the record is created unassigned');
      return null;
    }
  }

  // Routes the records that are still unassigned, oldest first.
  async applyToUnassigned({ organizationId, resource, limit }: { organizationId: string; resource: AssignmentResource; limit: number }) {
    const rows =
      resource === 'leads'
        ? await db
            .select()
            .from(leads)
            .where(
              and(
                eq(leads.organizationId, organizationId),
                isNull(leads.assignedTo),
                isNull(leads.deletedAt),
                notInArray(leads.status, ['converted', 'unqualified']),
              ),
            )
            .orderBy(asc(leads.createdAt))
            .limit(limit)
        : await db
            .select()
            .from(supportTickets)
            .where(
              and(eq(supportTickets.organizationId, organizationId), isNull(supportTickets.assignedTo), inArray(supportTickets.status, ['open', 'pending'])),
            )
            .orderBy(asc(supportTickets.createdAt))
            .limit(limit);
    let assigned = 0;
    for (const row of rows) {
      const picked = await this.safePick({ organizationId, resource, values: row });
      if (!picked) continue;
      if (resource === 'leads')
        await db
          .update(leads)
          .set({ assignedTo: picked.userId, updatedAt: new Date() })
          .where(and(eq(leads.id, row.id), isNull(leads.assignedTo)));
      else
        await db
          .update(supportTickets)
          .set({ assignedTo: picked.userId, updatedAt: new Date() })
          .where(and(eq(supportTickets.id, row.id), isNull(supportTickets.assignedTo)));
      await this.tell(
        organizationId,
        resource,
        row.id,
        picked.userId,
        'subject' in row ? row.subject : [row.firstName, row.lastName].filter(Boolean).join(' '),
      );
      assigned++;
    }
    return { checked: rows.length, assigned, unassigned: rows.length - assigned };
  }

  // The assignee hears about a record that was routed to them.
  tell(organizationId: string, resource: AssignmentResource, recordId: string, userId: string, label: string) {
    return notify({
      organizationId,
      userId,
      type: resource === 'leads' ? 'lead_assigned' : 'ticket_assigned',
      title: resource === 'leads' ? 'A lead was assigned to you' : 'A ticket was assigned to you',
      body: label,
      link: resource === 'leads' ? `/leads/${recordId}` : `/support/${recordId}`,
      relatedType: resource === 'leads' ? 'lead' : 'ticket',
      relatedId: recordId,
    });
  }

  // ---- helpers ----

  private async choose(rule: Rule_, resource: AssignmentResource, dryRun: boolean): Promise<string | null> {
    const target = rule.target;
    if (target.type === 'user') return (await this.activeMembers(rule.organizationId, { userIds: [target.userId] }))[0] ?? null;

    const members = await this.activeMembers(rule.organizationId, { teamId: target.teamId });
    if (members.length === 0) return null;
    if (target.strategy === 'least_loaded') return leastLoaded(await this.loads(rule.organizationId, resource, members));
    if (dryRun) return nextRoundRobin(members, rule.lastUserId);

    // Round robin moves a shared cursor, so the rule row is locked while the next person is chosen: two records created at the same
    // moment cannot both land on the same person.
    return withTransaction(async (tx) => {
      const [locked] = await tx.select({ lastUserId: assignmentRules.lastUserId }).from(assignmentRules).where(eq(assignmentRules.id, rule.id)).for('update');
      const next = nextRoundRobin(members, locked?.lastUserId ?? null);
      if (next) await tx.update(assignmentRules).set({ lastUserId: next }).where(eq(assignmentRules.id, rule.id));
      return next;
    });
  }

  private async activeMembers(organizationId: string, which: { teamId: string } | { userIds: string[] }): Promise<string[]> {
    const base = and(eq(users.organizationId, organizationId), eq(users.isActive, true));
    if ('userIds' in which)
      return (
        await db
          .select({ id: users.id })
          .from(users)
          .where(and(base, inArray(users.id, which.userIds)))
      ).map((r) => r.id);
    return (
      await db
        .select({ id: users.id })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId))
        .where(and(base, eq(teamMembers.teamId, which.teamId)))
    ).map((r) => r.id);
  }

  // Open items per member (members with none count as zero).
  private async loads(organizationId: string, resource: AssignmentResource, members: string[]) {
    const rows =
      resource === 'leads'
        ? await db
            .select({ userId: leads.assignedTo, open: count() })
            .from(leads)
            .where(
              and(
                eq(leads.organizationId, organizationId),
                isNull(leads.deletedAt),
                inArray(leads.assignedTo, members),
                notInArray(leads.status, [...OPEN_STATUSES.leads.notIn]),
              ),
            )
            .groupBy(leads.assignedTo)
        : await db
            .select({ userId: supportTickets.assignedTo, open: count() })
            .from(supportTickets)
            .where(
              and(
                eq(supportTickets.organizationId, organizationId),
                inArray(supportTickets.assignedTo, members),
                inArray(supportTickets.status, [...OPEN_STATUSES.tickets.in]),
              ),
            )
            .groupBy(supportTickets.assignedTo);
    const byUser = new Map(rows.map((r) => [r.userId, r.open]));
    return members.map((userId) => ({ userId, open: byUser.get(userId) ?? 0 }));
  }

  private async findTeam(organizationId: string, id: string) {
    const [team] = await db
      .select()
      .from(teams)
      .where(and(eq(teams.organizationId, organizationId), eq(teams.id, id)));
    if (!team) throw new NotFoundError('Team not found');
    return team;
  }

  private async checkTarget(organizationId: string, target: AssignmentTarget) {
    if (target.type === 'team')
      await this.findTeam(organizationId, target.teamId).catch(() => Promise.reject(new BadRequestError('Team not found', 'INVALID_TARGET')));
    else if ((await this.activeMembers(organizationId, { userIds: [target.userId] })).length === 0)
      throw new BadRequestError('User not found', 'INVALID_TARGET');
  }
}

export const assignmentService = new AssignmentService();
