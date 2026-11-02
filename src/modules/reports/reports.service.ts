import { withTransaction } from '@/config/database.js';
import type { PermissionKey } from '@/shared/constants/permissions.js';
import { activeUserEmails } from '@/modules/mail/mail.service.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@/shared/errors/index.js';
import { fillMonthly, monthKeys } from './reports.buckets.js';
import { nextRunAt } from './reports.next-run.js';
import { reportsRepository } from './reports.repository.js';
import type { LeadsReport, PipelineReport, ReportOutput, RevenueReport } from './reports.types.js';
import { REPORT_TYPES, reportParamsSchemas, resolveRange, scheduleShapeSchema } from './reports.validation.js';
import type { CreateSavedInput, CreateScheduleInput, ReportQuery, ReportType, UpdateSavedInput, UpdateScheduleInput } from './reports.validation.js';

const MAX_SAVED_PER_USER = 50;
const MAX_SCHEDULES_PER_USER = 20;

export const REPORT_PERMISSIONS: Record<ReportType, PermissionKey> = {
  'revenue-by-month': 'invoices.view',
  'pipeline-velocity': 'deals.view',
  'leads-funnel': 'leads.view',
};

export const isReportType = (value: string): value is ReportType => REPORT_TYPES.some((t) => t === value);

const round1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

type Actor = { organizationId: string; userId: string };

// Scheduled reports hold company data, so they may only be mailed to active users of the organization.
async function assertInternalRecipients(organizationId: string, recipients: string[]) {
  const ok = new Set(await activeUserEmails(organizationId, recipients));
  const outside = recipients.filter((r) => !ok.has(r.toLowerCase()));
  if (outside.length) throw new BadRequestError(`Recipients must be users of this organization: ${outside.join(', ')}`, 'RECIPIENT_NOT_ALLOWED');
}

class ReportsService {
  async revenueByMonth({ organizationId, query }: { organizationId: string; query: ReportQuery }): Promise<RevenueReport> {
    const range = resolveRange(query);
    const entries = await reportsRepository.revenueEntries({ organizationId, range });
    return { range: { from: range.from, to: range.to }, rows: fillMonthly(monthKeys(range.start, range.end), entries) };
  }

  // There is no stage-history table, so nothing here is derived from stage transitions.
  async pipelineVelocity({ organizationId, query }: { organizationId: string; query: ReportQuery }): Promise<PipelineReport> {
    const range = resolveRange(query);
    const [stages, closed, wonByCurrency] = await Promise.all([
      reportsRepository.stageSnapshot({ organizationId }),
      reportsRepository.closedTotals({ organizationId, range }),
      reportsRepository.wonByCurrency({ organizationId, range }),
    ]);
    const decided = closed.won + closed.lost;
    return {
      range: { from: range.from, to: range.to },
      stages: stages.map((s) => ({ ...s, avgAgeDays: round1(s.avgAgeDays) })),
      summary: { won: closed.won, lost: closed.lost, winRate: decided ? closed.won / decided : null, avgDaysToWon: round1(closed.avgDaysToWon) },
      wonByCurrency,
      notes: [
        'Stage counts, values and average age are a snapshot of deals as they are now; the average age of an open deal is days since it was created, not days in its current stage (no stage history is stored).',
        'A deal counts as won or lost in the range its record was last updated in, because there is no closed-at date; a later edit to a closed deal moves it to that later range.',
        'Days to won is the time from creation to the last update of won deals, an approximation of time to close.',
        'Win rate is won / (won + lost) for deals closed in the range; it is null when none closed.',
      ],
    };
  }

  async leadsFunnel({ organizationId, query }: { organizationId: string; query: ReportQuery }): Promise<LeadsReport> {
    const range = resolveRange(query);
    const [status, source] = await Promise.all([
      reportsRepository.leadsBy('status', { organizationId, range }),
      reportsRepository.leadsBy('source', { organizationId, range }),
    ]);
    const byStatus = status.map((r) => ({ status: r.key, count: r.count }));
    const total = byStatus.reduce((sum, r) => sum + r.count, 0);
    const converted = byStatus.find((r) => r.status === 'converted')?.count ?? 0;
    return {
      range: { from: range.from, to: range.to },
      total,
      converted,
      conversionRate: total ? converted / total : null,
      byStatus,
      bySource: source.map((r) => ({ source: r.key, count: r.count })),
    };
  }

  // Params are re-validated on every run: stored jsonb is not trusted to still match the schema.
  async run({ organizationId, type, params }: { organizationId: string; type: ReportType; params: unknown }): Promise<ReportOutput> {
    const query = reportParamsSchemas[type].parse(params);
    if (type === 'revenue-by-month') return { type, data: await this.revenueByMonth({ organizationId, query }) };
    if (type === 'pipeline-velocity') return { type, data: await this.pipelineVelocity({ organizationId, query }) };
    return { type, data: await this.leadsFunnel({ organizationId, query }) };
  }

  private assertCan(permissions: string[], type: ReportType) {
    if (!permissions.includes(REPORT_PERMISSIONS[type])) throw new ForbiddenError();
  }

  // Parses params with the report's own schema and rejects ranges the report itself would reject.
  private cleanParams(type: ReportType, params: unknown) {
    const query = reportParamsSchemas[type].parse(params);
    resolveRange(query);
    return query;
  }

  listSaved(actor: Actor) {
    return reportsRepository.listSaved(actor);
  }

  createSaved({ organizationId, userId, permissions, input }: Actor & { permissions: string[]; input: CreateSavedInput }) {
    this.assertCan(permissions, input.reportType);
    const params = this.cleanParams(input.reportType, input.params);
    return withTransaction(async (tx) => {
      await reportsRepository.lockOwner(`saved_reports:${userId}`, tx);
      if ((await reportsRepository.countSaved({ organizationId, userId }, tx)) >= MAX_SAVED_PER_USER) {
        throw new ConflictError('Saved report limit reached', 'SAVED_REPORT_LIMIT');
      }
      return reportsRepository.createSaved({ organizationId, ownerId: userId, name: input.name, reportType: input.reportType, params }, tx);
    });
  }

  async updateSaved({ organizationId, userId, id, input }: Actor & { id: string; input: UpdateSavedInput }) {
    const existing = await reportsRepository.findSaved({ organizationId, userId, id });
    if (!existing || !isReportType(existing.reportType)) throw new NotFoundError('Saved report not found');
    const set: { name?: string; params?: ReportQuery } = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.params !== undefined) set.params = this.cleanParams(existing.reportType, input.params);
    const row = await reportsRepository.updateSaved({ organizationId, userId, id, set });
    if (!row) throw new NotFoundError('Saved report not found');
    return row;
  }

  async removeSaved({ organizationId, userId, id }: Actor & { id: string }) {
    if (!(await reportsRepository.removeSaved({ organizationId, userId, id }))) throw new NotFoundError('Saved report not found');
  }

  async runSaved({ organizationId, userId, permissions, id }: Actor & { permissions: string[]; id: string }) {
    const saved = await reportsRepository.findSaved({ organizationId, userId, id });
    if (!saved || !isReportType(saved.reportType)) throw new NotFoundError('Saved report not found');
    this.assertCan(permissions, saved.reportType);
    return this.run({ organizationId, type: saved.reportType, params: saved.params });
  }

  // ---- schedules ----

  listSchedules(actor: Actor) {
    return reportsRepository.listSchedules(actor);
  }

  async createSchedule({ organizationId, userId, permissions, input }: Actor & { permissions: string[]; input: CreateScheduleInput }) {
    const saved = await reportsRepository.findSaved({ organizationId, userId, id: input.savedReportId });
    if (!saved || !isReportType(saved.reportType)) throw new NotFoundError('Saved report not found');
    this.assertCan(permissions, saved.reportType);
    const shape = scheduleShapeSchema.parse(input);
    await assertInternalRecipients(organizationId, shape.recipients);
    return withTransaction(async (tx) => {
      await reportsRepository.lockOwner(`report_schedules:${userId}`, tx);
      if ((await reportsRepository.countSchedules({ organizationId, userId }, tx)) >= MAX_SCHEDULES_PER_USER) {
        throw new ConflictError('Report schedule limit reached', 'REPORT_SCHEDULE_LIMIT');
      }
      return reportsRepository.createSchedule(
        { organizationId, ownerId: userId, savedReportId: saved.id, ...shape, nextRunAt: nextRunAt(shape, new Date()) },
        tx,
      );
    });
  }

  async updateSchedule({ organizationId, userId, id, input }: Actor & { id: string; input: UpdateScheduleInput }) {
    const existing = await reportsRepository.findSchedule({ organizationId, userId, id });
    if (!existing) throw new NotFoundError('Report schedule not found');
    // Merge onto the stored row and re-validate the whole shape, so a patch cannot leave an inconsistent schedule.
    const shape = scheduleShapeSchema.parse({
      frequency: existing.frequency,
      hourUtc: existing.hourUtc,
      dayOfWeek: existing.dayOfWeek,
      dayOfMonth: existing.dayOfMonth,
      recipients: existing.recipients,
      isActive: existing.isActive,
      ...input,
    });
    await assertInternalRecipients(organizationId, shape.recipients);
    const row = await reportsRepository.updateSchedule({ organizationId, userId, id, set: { ...shape, nextRunAt: nextRunAt(shape, new Date()) } });
    if (!row) throw new NotFoundError('Report schedule not found');
    return row;
  }

  async removeSchedule({ organizationId, userId, id }: Actor & { id: string }) {
    if (!(await reportsRepository.removeSchedule({ organizationId, userId, id }))) throw new NotFoundError('Report schedule not found');
  }
}

export const reportsService = new ReportsService();
