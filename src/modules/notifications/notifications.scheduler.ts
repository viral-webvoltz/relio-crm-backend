import { sql } from 'drizzle-orm';
import { db } from '@/config/database.js';
import { organizations } from '@/database/schema/identity.js';
import { logger } from '@/shared/utils/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 30_000;

// Set-based inserts; the unique (user_id, dedupe_key) index makes reruns and parallel instances no-ops.
// Dates use the database's current_date so every instance agrees on "today".
const notifyTasks = (organizationId: string) =>
  db.execute(sql`
  insert into notifications (organization_id, user_id, type, title, body, link, related_type, related_id, dedupe_key)
  select t.organization_id, t.assigned_to, 'task_due',
         case when t.due_date < current_date then 'Task overdue' else 'Task due today' end,
         t.title, '/tasks', 'task', t.id, 'task_due:' || t.id || ':' || current_date
  from tasks t
  join users u on u.id = t.assigned_to and u.is_active
  where t.organization_id = ${organizationId} and t.status = 'open' and t.assigned_to is not null
    and t.due_date is not null and t.due_date <= current_date and t.deleted_at is null
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing`);

// Once per invoice, ever (the key has no date), to the user who created it. Invoices without a creator are skipped.
const notifyInvoices = (organizationId: string) =>
  db.execute(sql`
  insert into notifications (organization_id, user_id, type, title, body, link, related_type, related_id, dedupe_key)
  select i.organization_id, i.created_by, 'invoice_overdue', 'Invoice overdue',
         'Invoice #' || i.invoice_number || ' was due on ' || i.due_date, '/invoices/' || i.id, 'invoice', i.id,
         'invoice_overdue:' || i.id
  from invoices i
  join users u on u.id = i.created_by and u.is_active
  where i.organization_id = ${organizationId} and i.status in ('unpaid', 'partial') and i.due_date < current_date
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing`);

export async function runNotificationChecks() {
  const orgs = await db.select({ id: organizations.id }).from(organizations);
  for (const { id } of orgs) {
    try {
      await notifyTasks(id);
      await notifyInvoices(id);
    } catch (err) {
      logger.error({ err, organizationId: id }, 'Notification checks failed for organization');
    }
  }
}

export function startNotificationScheduler() {
  const run = () => runNotificationChecks().catch((err) => logger.error({ err }, 'Notification checks failed'));
  const first = setTimeout(run, FIRST_RUN_DELAY_MS);
  const timer = setInterval(run, DAY_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
