import { and, asc, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '@/config/database.js';
import { companies, contacts } from '@/database/schema/crm.js';
import { deals, leads } from '@/database/schema/sales.js';
import type { PermissionKey } from '@/shared/constants/permissions.js';
import { searchPatterns } from './search.validation.js';
import type { SearchType } from './search.validation.js';

export interface SearchHit {
  id: string;
  type: SearchType;
  title: string;
  subtitle: string | null;
  rank: number;
}

export const VIEW_PERMISSION: Record<SearchType, PermissionKey> = {
  contacts: 'contacts.view',
  leads: 'leads.view',
  companies: 'companies.view',
  deals: 'deals.view',
};

// These display expressions are the exact ones in src/database/search-indexes.sql, so the trigram GIN indexes serve the ilike filters.
const fullName = (first: SQL.Aliased | SQL | object, last: SQL.Aliased | SQL | object) => sql`btrim(${first} || ' ' || coalesce(${last}, ''))`;
const contactName = fullName(contacts.firstName, contacts.lastName);
const leadName = fullName(leads.firstName, leads.lastName);

type Pat = ReturnType<typeof searchPatterns>;

// Ordering: exact (2) > prefix (1) > substring (0), then trigram similarity, then name, then id: fully deterministic.
const tier = (name: SQL, q: string, p: Pat) => sql<number>`(case when lower(${name}) = lower(${q}) then 2 when ${name} ilike ${p.prefix} then 1 else 0 end)`;
const score = (name: SQL, q: string, p: Pat) => sql<number>`(${tier(name, q, p)} + similarity(${name}, ${q}))::float8`;

class SearchService {
  async search({ organizationId, q, types, limit }: { organizationId: string; q: string; types: SearchType[]; limit: number }) {
    const p = searchPatterns(q);
    const jobs: Record<SearchType, () => Promise<SearchHit[]>> = {
      contacts: async () => {
        const rank = score(contactName, q, p);
        const rows = await db
          .select({ id: contacts.id, title: sql<string>`${contactName}`, subtitle: contacts.email, rank })
          .from(contacts)
          .where(
            and(eq(contacts.organizationId, organizationId), isNull(contacts.deletedAt), or(ilike(contactName, p.contains), ilike(contacts.email, p.contains))),
          )
          .orderBy(desc(rank), asc(contactName), asc(contacts.id))
          .limit(limit);
        return rows.map((r) => ({ ...r, type: 'contacts' as const }));
      },
      leads: async () => {
        const rank = score(leadName, q, p);
        const rows = await db
          .select({ id: leads.id, title: sql<string>`${leadName}`, subtitle: sql<string | null>`coalesce(${leads.companyName}, ${leads.email})`, rank })
          .from(leads)
          .where(
            and(
              eq(leads.organizationId, organizationId),
              isNull(leads.deletedAt),
              or(ilike(leadName, p.contains), ilike(leads.email, p.contains), ilike(leads.companyName, p.contains)),
            ),
          )
          .orderBy(desc(rank), asc(leadName), asc(leads.id))
          .limit(limit);
        return rows.map((r) => ({ ...r, type: 'leads' as const }));
      },
      companies: async () => {
        const rank = score(sql`${companies.name}`, q, p);
        const rows = await db
          .select({ id: companies.id, title: companies.name, subtitle: companies.phone, rank })
          .from(companies)
          .where(and(eq(companies.organizationId, organizationId), isNull(companies.deletedAt), ilike(companies.name, p.contains)))
          .orderBy(desc(rank), asc(companies.name), asc(companies.id))
          .limit(limit);
        return rows.map((r) => ({ ...r, type: 'companies' as const }));
      },
      deals: async () => {
        const rank = score(sql`${deals.title}`, q, p);
        const rows = await db
          .select({ id: deals.id, title: deals.title, subtitle: sql<string | null>`null`, rank })
          .from(deals)
          .where(and(eq(deals.organizationId, organizationId), isNull(deals.deletedAt), ilike(deals.title, p.contains)))
          .orderBy(desc(rank), asc(deals.title), asc(deals.id))
          .limit(limit);
        return rows.map((r) => ({ ...r, type: 'deals' as const }));
      },
    };
    const results = await Promise.all(types.map(async (t) => [t, await jobs[t]()] as const));
    return Object.fromEntries(results);
  }
}

export const searchService = new SearchService();
