import { customType, index, integer, pgTable, text, timestamp, uuid, boolean } from 'drizzle-orm/pg-core';
import { contacts } from './crm.js';
import { organizations, users } from './identity.js';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

export const portalNotices = pgTable(
  'portal_notices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body').notNull(),
    isPublished: boolean('is_published').notNull().default(false),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('portal_notices_org_published_idx').on(t.organizationId, t.isPublished, t.publishedAt.desc())],
);

export const portalDocuments = pgTable(
  'portal_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    content: bytea('content').notNull(),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('portal_documents_org_contact_created_idx').on(t.organizationId, t.contactId, t.createdAt.desc())],
);

export const appointmentStatuses = ['requested', 'confirmed', 'declined', 'cancelled', 'completed'] as const;
export type AppointmentStatus = (typeof appointmentStatuses)[number];

export const portalAppointments = pgTable(
  'portal_appointments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    notes: text('notes'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    durationMinutes: integer('duration_minutes').notNull().default(30),
    status: text('status', { enum: appointmentStatuses }).notNull().default('requested'),
    assignedTo: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),
    staffNotes: text('staff_notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('portal_appointments_org_contact_starts_idx').on(t.organizationId, t.contactId, t.startsAt),
    index('portal_appointments_org_status_starts_idx').on(t.organizationId, t.status, t.startsAt),
  ],
);
