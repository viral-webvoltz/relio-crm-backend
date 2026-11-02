import { and, count, desc, eq, getTableColumns, gte, lte } from 'drizzle-orm';
import { db, type DbExecutor } from '@/config/database.js';
import { contacts, users } from '@/database/schema/index.js';
import { portalAppointments } from '@/database/schema/portal-extras.js';
import type { AppointmentListQuery } from './appointments.validation.js';

const columns = { ...getTableColumns(portalAppointments), contactFirstName: contacts.firstName, contactLastName: contacts.lastName };

class AppointmentsRepository {
  async list(organizationId: string, { page, limit, status, contactId, from, to }: AppointmentListQuery) {
    const where = and(
      eq(portalAppointments.organizationId, organizationId),
      status ? eq(portalAppointments.status, status) : undefined,
      contactId ? eq(portalAppointments.contactId, contactId) : undefined,
      from ? gte(portalAppointments.startsAt, from) : undefined,
      to ? lte(portalAppointments.startsAt, to) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      db
        .select(columns)
        .from(portalAppointments)
        .innerJoin(contacts, eq(contacts.id, portalAppointments.contactId))
        .where(where)
        .orderBy(desc(portalAppointments.startsAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ value: count() }).from(portalAppointments).where(where),
    ]);
    return { rows, total: total?.value ?? 0 };
  }

  async find(organizationId: string, id: string) {
    const [row] = await db
      .select(columns)
      .from(portalAppointments)
      .innerJoin(contacts, eq(contacts.id, portalAppointments.contactId))
      .where(and(eq(portalAppointments.organizationId, organizationId), eq(portalAppointments.id, id)));
    return row;
  }

  // Row lock so two staff members cannot both move the same appointment out of the same status.
  async findForUpdate(organizationId: string, id: string, executor: DbExecutor) {
    const [row] = await executor
      .select({ id: portalAppointments.id, status: portalAppointments.status })
      .from(portalAppointments)
      .where(and(eq(portalAppointments.organizationId, organizationId), eq(portalAppointments.id, id)))
      .for('update');
    return row;
  }

  async update(organizationId: string, id: string, values: Partial<typeof portalAppointments.$inferInsert>, executor: DbExecutor) {
    await executor
      .update(portalAppointments)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(portalAppointments.organizationId, organizationId), eq(portalAppointments.id, id)));
  }

  async activeUserExists(organizationId: string, id: string, executor: DbExecutor) {
    const [row] = await executor
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.organizationId, organizationId), eq(users.id, id), eq(users.isActive, true)));
    return Boolean(row);
  }
}

export const appointmentsRepository = new AppointmentsRepository();
