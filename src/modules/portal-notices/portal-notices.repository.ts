import { and, count, desc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { db } from '@/config/database.js';
import { portalNotices } from '@/database/schema/portal-extras.js';
import type { ListQuery } from '@/shared/pagination/index.js';

class PortalNoticesRepository {
  async list(organizationId: string, { page, limit }: ListQuery) {
    const where = eq(portalNotices.organizationId, organizationId);
    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(portalNotices)
        .where(where)
        .orderBy(desc(portalNotices.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ value: count() }).from(portalNotices).where(where),
    ]);
    return { rows, total: total?.value ?? 0 };
  }

  async find(organizationId: string, id: string) {
    const [row] = await db
      .select()
      .from(portalNotices)
      .where(and(eq(portalNotices.organizationId, organizationId), eq(portalNotices.id, id)));
    return row;
  }

  async insert(values: typeof portalNotices.$inferInsert) {
    const [row] = await db.insert(portalNotices).values(values).returning();
    return row;
  }

  async update(organizationId: string, id: string, values: Partial<typeof portalNotices.$inferInsert>) {
    const [row] = await db
      .update(portalNotices)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(portalNotices.organizationId, organizationId), eq(portalNotices.id, id)))
      .returning();
    return row;
  }

  async delete(organizationId: string, id: string) {
    const rows = await db
      .delete(portalNotices)
      .where(and(eq(portalNotices.organizationId, organizationId), eq(portalNotices.id, id)))
      .returning({ id: portalNotices.id });
    return rows.length > 0;
  }

  // Customer side: published, already live and not expired. Only the allow-listed columns are selected.
  async listVisible(organizationId: string, { page, limit }: ListQuery) {
    const now = new Date();
    const where = and(
      eq(portalNotices.organizationId, organizationId),
      eq(portalNotices.isPublished, true),
      lte(portalNotices.publishedAt, now),
      or(isNull(portalNotices.expiresAt), gt(portalNotices.expiresAt, now)),
    );
    const [rows, [total]] = await Promise.all([
      db
        .select({
          id: portalNotices.id,
          title: portalNotices.title,
          body: portalNotices.body,
          publishedAt: portalNotices.publishedAt,
          expiresAt: portalNotices.expiresAt,
        })
        .from(portalNotices)
        .where(where)
        .orderBy(desc(portalNotices.publishedAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ value: count() }).from(portalNotices).where(where),
    ]);
    return { rows, total: total?.value ?? 0 };
  }
}

export const portalNoticesRepository = new PortalNoticesRepository();
