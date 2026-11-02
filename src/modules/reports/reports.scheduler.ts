import { and, eq, inArray, lte } from 'drizzle-orm';
import { db } from '@/config/database.js';
import { users } from '@/database/schema/index.js';
import { reportSchedules, savedReports } from '@/database/schema/reports.js';
import { authRepository } from '@/modules/auth/auth.repository.js';
import { activeUserEmails, canSendMail, queueEmail } from '@/modules/mail/mail.service.js';
import { logger } from '@/shared/utils/logger.js';
import { nextRunAt } from './reports.next-run.js';
import { renderTables, toTables } from './reports.render.js';
import { REPORT_PERMISSIONS, isReportType, reportsService } from './reports.service.js';

const TICK_MS = 60_000;
const BATCH = 20;
const LEASE_MS = 15 * 60_000; // a claimed schedule that crashes mid-run is retried after this

let warnedNoMail = false;

// Claims due schedules atomically (other instances skip locked rows) by pushing next_run_at out as a lease.
function claimDue(now: Date) {
  const due = db
    .select({ id: reportSchedules.id })
    .from(reportSchedules)
    .where(and(eq(reportSchedules.isActive, true), lte(reportSchedules.nextRunAt, now)))
    .orderBy(reportSchedules.nextRunAt)
    .limit(BATCH)
    .for('update', { skipLocked: true });
  return db
    .update(reportSchedules)
    .set({ lastRunAt: now, nextRunAt: new Date(now.getTime() + LEASE_MS) })
    .where(inArray(reportSchedules.id, due))
    .returning();
}

type Claimed = Awaited<ReturnType<typeof claimDue>>[number];

async function sendOne(schedule: Claimed) {
  const [saved] = await db.select().from(savedReports).where(eq(savedReports.id, schedule.savedReportId)).limit(1);
  if (!saved || !isReportType(saved.reportType)) return;
  const [owner] = await db
    .select({ isActive: users.isActive })
    .from(users)
    .where(and(eq(users.id, schedule.ownerId), eq(users.organizationId, schedule.organizationId)));
  if (!owner?.isActive) return;
  const permissions = await authRepository.listUserPermissionKeys({ userId: schedule.ownerId });
  if (!permissions.includes(REPORT_PERMISSIONS[saved.reportType])) {
    logger.warn({ scheduleId: schedule.id }, 'Report schedule skipped: owner no longer holds the report permission');
    return;
  }

  const output = await reportsService.run({ organizationId: schedule.organizationId, type: saved.reportType, params: saved.params });
  const mail = renderTables({ name: saved.name, range: output.data.range, tables: toTables(output) });
  // Re-checked at send time: schedules created before the internal-only rule, or for users since deactivated, must not leak.
  for (const to of await activeUserEmails(schedule.organizationId, schedule.recipients)) {
    await queueEmail({
      organizationId: schedule.organizationId,
      kind: 'report',
      to,
      ...mail,
      relatedType: 'report_schedule',
      relatedId: schedule.id,
    });
  }
}

export async function runDueSchedules(now = new Date()) {
  const claimed = await claimDue(now);
  for (const schedule of claimed) {
    try {
      if (await canSendMail(schedule.organizationId)) await sendOne(schedule);
      else if (!warnedNoMail) {
        warnedNoMail = true;
        logger.warn('Mail is not configured: scheduled report emails are skipped');
      }
    } catch (err) {
      logger.error({ err, scheduleId: schedule.id }, 'Scheduled report failed');
    }
    try {
      await db
        .update(reportSchedules)
        .set({ nextRunAt: nextRunAt(schedule, now) })
        .where(eq(reportSchedules.id, schedule.id));
    } catch (err) {
      logger.error({ err, scheduleId: schedule.id }, 'Failed to advance report schedule');
    }
  }
}

export function startReportScheduler() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDueSchedules();
    } catch (err) {
      logger.error({ err }, 'Report scheduler tick failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
