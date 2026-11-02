import { index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

// Shared fixed-window counters for the per-user / per-organization API limits, so every API instance counts into the same rows.
// The migration creates this table UNLOGGED (no WAL; counters are disposable and may be lost in a crash).
export const rateLimitCounters = pgTable(
  'rate_limit_counters',
  {
    key: text('key').notNull(), // 'u:<userId>' or 'o:<organizationId>'
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] }), index('rate_limit_counters_window_idx').on(t.windowStart)],
);
