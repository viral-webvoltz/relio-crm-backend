import { eq } from 'drizzle-orm';
import { db } from '@/config/database.js';
import { activities, companies, contacts, deals, invoices, leads, orders, products, quotes, supportTickets, tasks } from '@/database/schema/index.js';

export type Snapshot = Record<string, unknown>;
export type FieldChange = { from: unknown; to: unknown };

const sensitiveKey = /password|token|secret|hash/i;
// Bookkeeping columns that change on every write and say nothing about what the user did.
const ignoredKeys = new Set(['updatedAt', 'updated_at']);
const maxValueLength = 500;
const maxDiffBytes = 10_000;

const first = async (rows: Promise<Snapshot[]>) => (await rows)[0];

// Route segment -> loader. Only records whose before/after state is worth keeping; ids are globally unique, and the audit entry is only
// written when the request succeeded, which already implies the record belonged to the caller's organization.
const loaders: Record<string, (id: string) => Promise<Snapshot | undefined>> = {
  leads: (id) => first(db.select().from(leads).where(eq(leads.id, id)).limit(1)),
  contacts: (id) => first(db.select().from(contacts).where(eq(contacts.id, id)).limit(1)),
  companies: (id) => first(db.select().from(companies).where(eq(companies.id, id)).limit(1)),
  deals: (id) => first(db.select().from(deals).where(eq(deals.id, id)).limit(1)),
  tasks: (id) => first(db.select().from(tasks).where(eq(tasks.id, id)).limit(1)),
  products: (id) => first(db.select().from(products).where(eq(products.id, id)).limit(1)),
  activities: (id) => first(db.select().from(activities).where(eq(activities.id, id)).limit(1)),
  orders: (id) => first(db.select().from(orders).where(eq(orders.id, id)).limit(1)),
  quotes: (id) => first(db.select().from(quotes).where(eq(quotes.id, id)).limit(1)),
  invoices: (id) => first(db.select().from(invoices).where(eq(invoices.id, id)).limit(1)),
  tickets: (id) => first(db.select().from(supportTickets).where(eq(supportTickets.id, id)).limit(1)),
};

export const hasSnapshotLoader = (entity: string) => entity in loaders;

export async function loadSnapshot(entity: string, id: string) {
  const loader = loaders[entity];
  return loader ? loader(id) : undefined;
}

const printable = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.length > maxValueLength) return `${value.slice(0, maxValueLength)}…`;
  if (typeof value === 'object' && value !== null) {
    const text = JSON.stringify(value);
    return text.length > maxValueLength ? '[large value]' : value;
  }
  return value;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a instanceof Date ? a.toISOString() : a) === JSON.stringify(b instanceof Date ? b.toISOString() : b);

// Fields whose value differs between the two snapshots, as { field: { from, to } }. Secrets are never copied, only flagged as changed.
export function diffSnapshots(before: Snapshot, after: Snapshot): Record<string, FieldChange> | null {
  const diff: Record<string, FieldChange> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (ignoredKeys.has(key) || same(before[key], after[key])) continue;
    diff[key] = sensitiveKey.test(key) ? { from: '[redacted]', to: '[redacted]' } : { from: printable(before[key]), to: printable(after[key]) };
  }
  if (Object.keys(diff).length === 0) return null;
  return JSON.stringify(diff).length > maxDiffBytes ? { _truncated: { from: null, to: `${Object.keys(diff).length} fields changed` } } : diff;
}
