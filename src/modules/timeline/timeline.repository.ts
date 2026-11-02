import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '@/config/database.js';
import type { DbExecutor } from '@/config/database.js';
import { contacts } from '@/database/schema/crm.js';
import { activities, tasks } from '@/database/schema/activities.js';
import { invoices } from '@/database/schema/invoices.js';
import { orders } from '@/database/schema/orders.js';
import { deals } from '@/database/schema/sales.js';
import { supportTickets } from '@/database/schema/support.js';
import { users } from '@/database/schema/identity.js';
import { money } from '@/modules/mail/mail.templates.js';
import { PER_SOURCE_CAP } from './timeline.merge.js';
import type { TimelineItem } from './timeline.merge.js';

type Scope = { organizationId: string; contactId: string };
type Sources = Scope & { permissions: readonly string[] };

class TimelineRepository {
  async contactExists({ organizationId, contactId }: Scope, executor: DbExecutor = db) {
    const [row] = await executor
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, contactId), isNull(contacts.deletedAt)));
    return Boolean(row);
  }

  // One capped, tenant-scoped query per source; the service merges them.
  async sources({ organizationId, contactId, permissions }: Sources, executor: DbExecutor = db): Promise<TimelineItem[][]> {
    // A source is only queried when the caller may view that resource on its own; contacts.view alone must not reveal money or tickets.
    const can = (key: string) => permissions.includes(key);
    const none = Promise.resolve([]);
    const [acts, taskRows, dealRows, orderRows, invoiceRows, ticketRows] = await Promise.all([
      !can('activities.view')
        ? none
        : executor
            .select({ a: activities, actor: users.fullName })
            .from(activities)
            .leftJoin(users, eq(users.id, activities.createdBy))
            .where(and(eq(activities.organizationId, organizationId), eq(activities.relatedType, 'contact'), eq(activities.relatedId, contactId)))
            .orderBy(desc(activities.occurredAt))
            .limit(PER_SOURCE_CAP),
      !can('tasks.view')
        ? none
        : executor
            .select({ t: tasks, actor: users.fullName })
            .from(tasks)
            .leftJoin(users, eq(users.id, tasks.assignedTo))
            .where(and(eq(tasks.organizationId, organizationId), eq(tasks.relatedType, 'contact'), eq(tasks.relatedId, contactId), isNull(tasks.deletedAt)))
            .orderBy(desc(tasks.createdAt))
            .limit(PER_SOURCE_CAP),
      !can('deals.view')
        ? none
        : executor
            .select({ d: deals, actor: users.fullName })
            .from(deals)
            .leftJoin(users, eq(users.id, deals.ownerId))
            .where(and(eq(deals.organizationId, organizationId), eq(deals.contactId, contactId), isNull(deals.deletedAt)))
            .orderBy(desc(deals.createdAt))
            .limit(PER_SOURCE_CAP),
      !can('orders.view')
        ? none
        : executor
            .select({ o: orders, actor: users.fullName })
            .from(orders)
            .leftJoin(users, eq(users.id, orders.createdBy))
            .where(and(eq(orders.organizationId, organizationId), eq(orders.contactId, contactId)))
            .orderBy(desc(orders.createdAt))
            .limit(PER_SOURCE_CAP),
      !can('invoices.view')
        ? none
        : executor
            .select({ i: invoices, actor: users.fullName })
            .from(invoices)
            .innerJoin(orders, and(eq(orders.id, invoices.orderId), eq(orders.organizationId, organizationId)))
            .leftJoin(users, eq(users.id, invoices.createdBy))
            .where(and(eq(invoices.organizationId, organizationId), eq(orders.contactId, contactId)))
            .orderBy(desc(invoices.createdAt))
            .limit(PER_SOURCE_CAP),
      !can('tickets.view')
        ? none
        : executor
            .select({ s: supportTickets, actor: users.fullName })
            .from(supportTickets)
            .leftJoin(users, eq(users.id, supportTickets.createdBy))
            .where(and(eq(supportTickets.organizationId, organizationId), eq(supportTickets.contactId, contactId)))
            .orderBy(desc(supportTickets.createdAt))
            .limit(PER_SOURCE_CAP),
    ]);

    return [
      acts.map(({ a, actor }) => ({
        type: a.type,
        at: a.occurredAt,
        title: a.subject,
        summary: a.body,
        entityType: 'activity',
        entityId: a.id,
        actorName: actor,
      })),
      taskRows.map(({ t, actor }) => ({
        type: 'task',
        at: t.createdAt,
        title: t.title,
        summary: `${t.status}, ${t.priority} priority${t.dueDate ? `, due ${t.dueDate}` : ''}`,
        entityType: 'task',
        entityId: t.id,
        actorName: actor,
      })),
      dealRows.map(({ d, actor }) => ({
        type: 'deal',
        at: d.createdAt,
        title: d.title,
        summary: money(d.valueMinor, d.currency),
        entityType: 'deal',
        entityId: d.id,
        actorName: actor,
      })),
      orderRows.map(({ o, actor }) => ({
        type: 'order',
        at: o.createdAt,
        title: `Order #${o.orderNumber}`,
        summary: `${o.status}, total ${money(o.totalMinor, o.currency)}`,
        entityType: 'order',
        entityId: o.id,
        actorName: actor,
      })),
      invoiceRows.map(({ i, actor }) => ({
        type: 'invoice',
        at: i.createdAt,
        title: `Invoice #${i.invoiceNumber}`,
        summary: `${i.status}, total ${money(i.totalMinor, i.currency)}`,
        entityType: 'invoice',
        entityId: i.id,
        actorName: actor,
      })),
      ticketRows.map(({ s, actor }) => ({
        type: 'ticket',
        at: s.createdAt,
        title: `#${s.ticketNumber} ${s.subject}`,
        summary: `${s.status}, ${s.priority} priority`,
        entityType: 'ticket',
        entityId: s.id,
        actorName: actor,
      })),
    ];
  }
}

export const timelineRepository = new TimelineRepository();
