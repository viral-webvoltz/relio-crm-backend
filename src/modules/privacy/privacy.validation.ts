import { z } from 'zod';

// Who the request is about: an email address (finds the contacts and leads that use it) or one specific contact.
const subject = z.object({ email: z.email().max(254).optional(), contactId: z.uuid().optional() });
const hasSubject = (s: { email?: string | undefined; contactId?: string | undefined }) => s.email !== undefined || s.contactId !== undefined;
const needSubject = { message: 'Send an email or a contactId', path: ['email'] };

export const exportSubjectSchema = subject.strict().refine(hasSubject, needSubject);

// Erasing cannot be undone, so it must be asked for twice: the same subject again as `confirm`, or a dry run first.
export const eraseSubjectSchema = subject
  .extend({ dryRun: z.boolean().default(false), confirm: z.string().trim().min(1).max(254).optional() })
  .strict()
  .refine(hasSubject, needSubject)
  .refine((s) => s.dryRun || (s.confirm !== undefined && s.confirm.toLowerCase() === (s.email ?? s.contactId ?? '').toLowerCase()), {
    message: 'To erase for real, repeat the email (or contactId) in "confirm"; or send dryRun: true to see what would go',
    path: ['confirm'],
  });

const days = z.number().int().min(30).max(3650).nullable(); // never less than a month: a typo must not wipe the log
export const retentionSchema = z.object({ auditLogDays: days, emailLogDays: days, notificationDays: days }).strict();

export type SubjectInput = z.infer<typeof exportSubjectSchema>;
export type EraseInput = z.infer<typeof eraseSubjectSchema>;
export type RetentionInput = z.infer<typeof retentionSchema>;
