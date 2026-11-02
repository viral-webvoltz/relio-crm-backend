import { and, asc, count, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { db } from '@/config/database.js';
import { deals, goals, leads, orders, organizations, pipelineStages, quotes, supportTickets, teamMembers, teams, users } from '@/database/schema/index.js';
import { localDate } from '@/modules/subscriptions/subscriptions.schedule.js';
import { BadRequestError, NotFoundError } from '@/shared/errors/index.js';
import { goalState, periodRange, elapsedShare } from './goals.period.js';
import { type CreateGoalInput, type GoalListQuery, type LeaderboardQuery, type Metric, type UpdateGoalInput } from './goals.validation.js';

type Goal = typeof goals.$inferSelect;
type Measure = {
  organizationId: string;
  metric: Metric;
  startDate: string;
  endDate: string;
  timezone: string;
  currency: string | null;
  userIds?: string[] | undefined;
};

const sumOf = (column: Parameters<typeof sql>[1]) => sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);

class GoalsService {
  async list({ organizationId, query }: { organizationId: string; query: GoalListQuery }) {
    const timezone = await this.timezoneOf(organizationId);
    const today = localDate(new Date(), timezone);
    const rows = await db
      .select()
      .from(goals)
      .where(
        and(
          eq(goals.organizationId, organizationId),
          query.metric ? eq(goals.metric, query.metric) : undefined,
          query.userId ? eq(goals.userId, query.userId) : undefined,
          query.when === 'current' ? sql`${goals.endDate} >= ${today}` : query.when === 'past' ? sql`${goals.endDate} < ${today}` : undefined,
        ),
      )
      .orderBy(asc(goals.endDate), asc(goals.name))
      .limit(200);
    return Promise.all(rows.map(async (goal) => ({ ...goal, progress: await this.progress(goal, timezone, today) })));
  }

  // The goal, how it is going, and who contributed (for a team or organization goal).
  async getById({ organizationId, id }: { organizationId: string; id: string }) {
    const goal = await this.find(organizationId, id);
    const timezone = await this.timezoneOf(organizationId);
    const today = localDate(new Date(), timezone);
    const members = await this.scopeUsers(goal);
    const rows = await this.measure({
      organizationId,
      metric: goal.metric as Metric,
      startDate: goal.startDate,
      endDate: goal.endDate,
      timezone,
      currency: goal.currency,
      userIds: members,
    });
    const names = await this.names(rows.flatMap((r) => (r.userId ? [r.userId] : [])));
    return {
      ...goal,
      progress: await this.progress(goal, timezone, today),
      contributors: rows
        .filter((r) => r.userId)
        .map((r) => ({ userId: r.userId!, name: names.get(r.userId!) ?? 'Unknown', value: r.value }))
        .sort((a, b) => b.value - a.value),
    };
  }

  async create({ organizationId, userId, input }: { organizationId: string; userId: string; input: CreateGoalInput }) {
    if (input.scope.type === 'user' && !(await this.activeUser(organizationId, input.scope.userId)))
      throw new BadRequestError('User not found', 'INVALID_SCOPE');
    if (input.scope.type === 'team' && !(await this.teamExists(organizationId, input.scope.teamId)))
      throw new BadRequestError('Team not found', 'INVALID_SCOPE');

    const timezone = await this.timezoneOf(organizationId);
    const range =
      input.period === 'custom'
        ? { startDate: input.startDate!, endDate: input.endDate! }
        : periodRange(input.period, input.on ?? localDate(new Date(), timezone));
    const [goal] = await db
      .insert(goals)
      .values({
        organizationId,
        name: input.name,
        metric: input.metric,
        scopeType: input.scope.type,
        userId: input.scope.type === 'user' ? input.scope.userId : null,
        teamId: input.scope.type === 'team' ? input.scope.teamId : null,
        periodType: input.period,
        ...range,
        target: input.target,
        currency: input.currency,
        createdBy: userId,
      })
      .returning();
    return goal!;
  }

  async update({ organizationId, id, input }: { organizationId: string; id: string; input: UpdateGoalInput }) {
    const [goal] = await db
      .update(goals)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(goals.organizationId, organizationId), eq(goals.id, id)))
      .returning();
    if (!goal) throw new NotFoundError('Goal not found');
    return goal;
  }

  async remove({ organizationId, id }: { organizationId: string; id: string }) {
    const deleted = await db
      .delete(goals)
      .where(and(eq(goals.organizationId, organizationId), eq(goals.id, id)))
      .returning({ id: goals.id });
    if (deleted.length === 0) throw new NotFoundError('Goal not found');
  }

  // Who is leading on a metric this month, quarter or year. Only active people appear.
  async leaderboard({ organizationId, query }: { organizationId: string; query: LeaderboardQuery }) {
    const timezone = await this.timezoneOf(organizationId);
    const range = periodRange(query.period, query.on ?? localDate(new Date(), timezone));
    const rows = await this.measure({ organizationId, metric: query.metric, ...range, timezone, currency: query.currency ?? null });
    const ids = rows.flatMap((r) => (r.userId ? [r.userId] : []));
    const active = ids.length
      ? await db
          .select({ id: users.id, name: users.fullName })
          .from(users)
          .where(and(eq(users.organizationId, organizationId), eq(users.isActive, true), inArray(users.id, ids)))
      : [];
    const names = new Map(active.map((u) => [u.id, u.name]));
    const ranked = rows
      .filter((r) => r.userId && names.has(r.userId) && r.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, query.limit)
      .map((r, i) => ({ rank: i + 1, userId: r.userId!, name: names.get(r.userId!)!, value: r.value }));
    return { metric: query.metric, period: query.period, ...range, currency: query.currency ?? null, entries: ranked };
  }

  // ---- progress ----

  private async progress(goal: Goal, timezone: string, today: string) {
    const rows = await this.measure({
      organizationId: goal.organizationId,
      metric: goal.metric as Metric,
      startDate: goal.startDate,
      endDate: goal.endDate,
      timezone,
      currency: goal.currency,
      userIds: await this.scopeUsers(goal),
    });
    const actual = rows.reduce((sum, r) => sum + r.value, 0);
    const state = goalState({ actual, target: goal.target, startDate: goal.startDate, endDate: goal.endDate, today });
    return {
      actual,
      target: goal.target,
      percent: Math.round((actual / goal.target) * 100),
      state,
      // Where a straight line towards the target would be today: what "ahead" and "behind" are measured against.
      expected: Math.round(goal.target * elapsedShare(goal.startDate, goal.endDate, today)),
      remaining: Math.max(0, goal.target - actual),
    };
  }

  // The people a goal counts: one user, a team's members, or (undefined) everybody.
  private async scopeUsers(goal: Goal): Promise<string[] | undefined> {
    if (goal.scopeType === 'user') return [goal.userId!];
    if (goal.scopeType === 'team')
      return (await db.select({ id: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.teamId, goal.teamId!))).map((r) => r.id);
    return undefined;
  }

  // The value of a metric over the period, per person. Dates are whole days on the organization's own clock.
  private async measure({
    organizationId,
    metric,
    startDate,
    endDate,
    timezone,
    currency,
    userIds,
  }: Measure): Promise<{ userId: string | null; value: number }[]> {
    if (userIds && userIds.length === 0) return []; // an empty team has produced nothing
    const from = sql`(${startDate}::date)::timestamp at time zone ${timezone}`;
    const to = sql`((${endDate}::date + 1)::timestamp at time zone ${timezone})`;
    const within = (column: Parameters<typeof gte>[0]) => and(gte(column, from), lt(column, to));
    const only = (column: Parameters<typeof inArray>[0]) => (userIds ? inArray(column, userIds) : undefined);

    switch (metric) {
      case 'revenue_won':
      case 'deals_won':
        return db
          .select({ userId: deals.ownerId, value: metric === 'revenue_won' ? sumOf(deals.valueMinor) : count() })
          .from(deals)
          .innerJoin(pipelineStages, eq(pipelineStages.id, deals.stageId))
          .where(
            and(
              eq(deals.organizationId, organizationId),
              isNull(deals.deletedAt),
              eq(pipelineStages.kind, 'won'),
              within(deals.updatedAt),
              metric === 'revenue_won' && currency ? eq(deals.currency, currency) : undefined,
              only(deals.ownerId),
            ),
          )
          .groupBy(deals.ownerId);
      case 'orders_value':
        return db
          .select({ userId: orders.createdBy, value: sumOf(orders.totalMinor) })
          .from(orders)
          .where(
            and(
              eq(orders.organizationId, organizationId),
              ne(orders.status, 'cancelled'),
              within(orders.createdAt),
              currency ? eq(orders.currency, currency) : undefined,
              only(orders.createdBy),
            ),
          )
          .groupBy(orders.createdBy);
      case 'leads_converted':
        return db
          .select({ userId: leads.assignedTo, value: count() })
          .from(leads)
          .where(and(eq(leads.organizationId, organizationId), isNull(leads.deletedAt), within(leads.convertedAt), only(leads.assignedTo)))
          .groupBy(leads.assignedTo);
      case 'quotes_accepted':
        return db
          .select({ userId: quotes.createdBy, value: count() })
          .from(quotes)
          .where(and(eq(quotes.organizationId, organizationId), eq(quotes.status, 'accepted'), within(quotes.respondedAt), only(quotes.createdBy)))
          .groupBy(quotes.createdBy);
      case 'tickets_resolved':
        return db
          .select({ userId: supportTickets.assignedTo, value: count() })
          .from(supportTickets)
          .where(
            and(
              eq(supportTickets.organizationId, organizationId),
              inArray(supportTickets.status, ['resolved', 'closed']),
              within(supportTickets.resolvedAt),
              only(supportTickets.assignedTo),
            ),
          )
          .groupBy(supportTickets.assignedTo);
    }
  }

  // ---- helpers ----

  private async find(organizationId: string, id: string) {
    const [goal] = await db
      .select()
      .from(goals)
      .where(and(eq(goals.organizationId, organizationId), eq(goals.id, id)));
    if (!goal) throw new NotFoundError('Goal not found');
    return goal;
  }

  private async timezoneOf(organizationId: string) {
    const [row] = await db.select({ timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, organizationId));
    return row?.timezone ?? 'UTC';
  }

  private async names(ids: string[]) {
    if (ids.length === 0) return new Map<string, string>();
    return new Map((await db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]));
  }

  private async activeUser(organizationId: string, id: string) {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.organizationId, organizationId), eq(users.id, id), eq(users.isActive, true)));
    return Boolean(row);
  }

  private async teamExists(organizationId: string, id: string) {
    const [row] = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.organizationId, organizationId), eq(teams.id, id)));
    return Boolean(row);
  }
}

export const goalsService = new GoalsService();
