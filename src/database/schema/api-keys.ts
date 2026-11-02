import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations, users } from './identity.js';

// A key lets a script or an integration call the API without a person's login. It acts as the person who created it, limited to the
// scopes chosen (and never beyond what that person can do today). Only a hash of the key is stored; the key itself is shown once.
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    keyPrefix: text('key_prefix').notNull(), // the first characters of the key, so a person can tell their keys apart
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull(), // permission keys, e.g. contacts.view
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'cascade' }), // the key dies with the person
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('api_keys_hash_uq').on(t.keyHash), index('api_keys_org_idx').on(t.organizationId, t.createdAt.desc())],
);
