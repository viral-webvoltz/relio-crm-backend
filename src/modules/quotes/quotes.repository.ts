import { and, asc, count, desc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm';
import { db, type DbExecutor } from '@/config/database.js';
import { companies, contacts, deals, notifications, orders, organizations, products, quoteItems, quoteSequences, quotes } from '@/database/schema/index.js';
import { likeContains } from '@/shared/utils/like.js';
import { orderByClause } from '@/shared/utils/sorting.js';
import type { QuoteListQuery } from './quotes.validation.js';

type NewQuote = typeof quotes.$inferInsert;
type NewQuoteItem = typeof quoteItems.$inferInsert;

const quoteScope = (organizationId: string, id: string) => and(eq(quotes.organizationId, organizationId), eq(quotes.id, id));

// "Open" = still answerable: not past its valid-until date. A sent quote past it reads as expired.
const open = sql`(${quotes.validUntil} is null or ${quotes.validUntil} >= current_date)`;

function listWhere(organizationId: string, { search, status, contactId, dealId }: QuoteListQuery) {
  const statusFilter =
    status === 'expired'
      ? and(eq(quotes.status, 'sent'), sql`${quotes.validUntil} < current_date`)
      : status === 'sent'
        ? and(eq(quotes.status, 'sent'), open)
        : status
          ? eq(quotes.status, status)
          : undefined;
  const searchFilter = !search
    ? undefined
    : /^(q-?)?\d+$/i.test(search)
      ? eq(quotes.quoteNumber, Number(search.replace(/\D/g, '')))
      : ilike(quotes.customerName, likeContains(search));
  return and(
    eq(quotes.organizationId, organizationId),
    statusFilter,
    searchFilter,
    contactId ? eq(quotes.contactId, contactId) : undefined,
    dealId ? eq(quotes.dealId, dealId) : undefined,
  );
}

class QuotesRepository {
  async list({ organizationId, query }: { organizationId: string; query: QuoteListQuery }) {
    const { page, limit, sort, dir } = query;
    const where = listWhere(organizationId, query);
    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(quotes)
        .where(where)
        .orderBy(
          ...orderByClause(
            {
              quoteNumber: quotes.quoteNumber,
              customer: quotes.customerName,
              status: quotes.status,
              total: quotes.totalMinor,
              validUntil: quotes.validUntil,
              createdAt: quotes.createdAt,
            },
            { sort, dir },
            [desc(quotes.quoteNumber)],
          ),
        )
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ value: count() }).from(quotes).where(where),
    ]);
    return { rows, total: total?.value ?? 0 };
  }

  async findById({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [quote] = await executor.select().from(quotes).where(quoteScope(organizationId, id));
    return quote;
  }

  async lockById({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [quote] = await executor.select().from(quotes).where(quoteScope(organizationId, id)).for('update');
    return quote;
  }

  findItems({ quoteId }: { quoteId: string }, executor: DbExecutor = db) {
    return executor.select().from(quoteItems).where(eq(quoteItems.quoteId, quoteId)).orderBy(asc(quoteItems.position));
  }

  async findByTokenHash({ tokenHash }: { tokenHash: string }, executor: DbExecutor = db) {
    const [row] = await executor
      .select({ quote: quotes, organizationName: organizations.name })
      .from(quotes)
      .innerJoin(organizations, eq(organizations.id, quotes.organizationId))
      .where(eq(quotes.publicTokenHash, tokenHash));
    return row;
  }

  async findOrderNumber({ id }: { id: string }) {
    const [row] = await db.select({ orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, id));
    return row?.orderNumber ?? null;
  }

  // The upsert locks the organization's counter row until commit, so numbers are unique and gap-free.
  async nextQuoteNumber({ organizationId }: { organizationId: string }, executor: DbExecutor = db) {
    const [sequence] = await executor
      .insert(quoteSequences)
      .values({ organizationId, lastNumber: 1001 })
      .onConflictDoUpdate({ target: quoteSequences.organizationId, set: { lastNumber: sql`${quoteSequences.lastNumber} + 1` } })
      .returning();
    return sequence!.lastNumber;
  }

  async insert(values: NewQuote, executor: DbExecutor = db) {
    const [quote] = await executor.insert(quotes).values(values).returning();
    return quote!;
  }

  async insertItems(values: NewQuoteItem[], executor: DbExecutor = db) {
    await executor.insert(quoteItems).values(values);
  }

  async deleteItems({ quoteId }: { quoteId: string }, executor: DbExecutor = db) {
    await executor.delete(quoteItems).where(eq(quoteItems.quoteId, quoteId));
  }

  async update({ id, set }: { id: string; set: Partial<NewQuote> }, executor: DbExecutor = db) {
    const [quote] = await executor
      .update(quotes)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(quotes.id, id))
      .returning();
    return quote!;
  }

  async remove({ id }: { id: string }, executor: DbExecutor = db) {
    await executor.delete(quotes).where(eq(quotes.id, id));
  }

  // The customer answer: one conditional UPDATE, so two simultaneous clicks (or accept against reject) cannot both win.
  async respond(
    { tokenHash, status, name, note }: { tokenHash: string; status: 'accepted' | 'rejected'; name: string | null; note: string | null },
    executor: DbExecutor = db,
  ) {
    const [quote] = await executor
      .update(quotes)
      .set({ status, respondedAt: new Date(), respondedByName: name, responseNote: note, updatedAt: new Date() })
      .where(and(eq(quotes.publicTokenHash, tokenHash), eq(quotes.status, 'sent'), open))
      .returning();
    return quote;
  }

  async findContact({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [row] = await executor
      .select({ firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email })
      .from(contacts)
      .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, id), isNull(contacts.deletedAt)));
    return row;
  }

  async findCompanyName({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [row] = await executor
      .select({ name: companies.name })
      .from(companies)
      .where(and(eq(companies.organizationId, organizationId), eq(companies.id, id), isNull(companies.deletedAt)));
    return row;
  }

  async dealExists({ organizationId, id }: { organizationId: string; id: string }, executor: DbExecutor = db) {
    const [row] = await executor
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.organizationId, organizationId), eq(deals.id, id), isNull(deals.deletedAt)));
    return Boolean(row);
  }

  findProducts({ organizationId, ids }: { organizationId: string; ids: string[] }, executor: DbExecutor = db) {
    return executor
      .select({
        id: products.id,
        name: products.name,
        sku: products.sku,
        priceMinor: products.priceMinor,
        currency: products.currency,
        isActive: products.isActive,
      })
      .from(products)
      .where(and(eq(products.organizationId, organizationId), inArray(products.id, ids), isNull(products.deletedAt)));
  }

  async notify(values: typeof notifications.$inferInsert) {
    await db.insert(notifications).values(values);
  }
}

export const quotesRepository = new QuotesRepository();
