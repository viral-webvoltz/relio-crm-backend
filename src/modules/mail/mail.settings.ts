import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '@/config/database.js';
import { env } from '@/config/env.js';
import { isUniqueViolation } from '@/database/soft-delete.js';
import { organizationMailSettings as accounts } from '@/database/schema/mail.js';
import { open, seal } from '@/modules/auth/secret-box.js';
import { ConflictError, NotFoundError } from '@/shared/errors/index.js';
import type { GmailCredentials } from './gmail.client.js';

export const serverSmtpConfigured = Boolean(env.SMTP_URL && env.MAIL_FROM);

type Row = typeof accounts.$inferSelect;

export type MailAccountInput = { fromEmail: string; fromName: string | null; clientId: string; clientSecret?: string; refreshToken?: string };

const TTL_MS = 30_000;

const credentials = (row: Row): GmailCredentials => ({
  fromEmail: row.fromEmail,
  fromName: row.fromName,
  clientId: row.clientId,
  clientSecret: open(row.clientSecretSealed, env.JWT_SECRET),
  refreshToken: open(row.refreshTokenSealed, env.JWT_SECRET),
});

// What the settings page may see: never the secrets, only the fields that identify the account.
const view = (row: Row) => ({
  id: row.id,
  fromEmail: row.fromEmail,
  fromName: row.fromName,
  clientId: row.clientId,
  isActive: row.isActive,
  lastSyncedAt: row.lastSyncedAt,
  syncError: row.syncError,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const duplicate = (err: unknown): never => {
  if (isUniqueViolation(err)) throw new ConflictError('This Gmail address is already added', 'MAIL_ACCOUNT_EXISTS');
  throw err;
};

class MailSettingsService {
  // The mailer asks for the active account on every message; a short cache keeps that off the database. Any change clears it at once.
  private cache = new Map<string, { at: number; value: GmailCredentials | null }>();

  async gmailFor(organizationId: string): Promise<GmailCredentials | null> {
    const hit = this.cache.get(organizationId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const [row] = await db.select().from(accounts).where(and(eq(accounts.organizationId, organizationId), eq(accounts.isActive, true)));
    const value = row ? credentials(row) : null;
    this.cache.set(organizationId, { at: Date.now(), value });
    return value;
  }

  // Where replies should be sent so they come back to the CRM: the server's inbound address if it has one, otherwise the Gmail account itself
  // (Gmail delivers name+anything@gmail.com to name@gmail.com, so a plus-address token reaches the inbox the CRM reads).
  async inboundAddress(organizationId: string) {
    return process.env.INBOUND_EMAIL_ADDRESS ?? (await this.gmailFor(organizationId))?.fromEmail;
  }

  // Every account whose inbox should be read for replies, with what the reader needs.
  async accountsToSync() {
    const rows = await db.select().from(accounts);
    return rows.flatMap((row) => {
      try {
        return [{ id: row.id, organizationId: row.organizationId, lastSyncedAt: row.lastSyncedAt, credentials: credentials(row) }];
      } catch {
        return []; // stored with a different server secret: this account cannot be read until it is re-entered
      }
    });
  }

  async markSynced(id: string, { at, error }: { at: Date; error: string | null }) {
    await db.update(accounts).set({ syncError: error, ...(error === null && { lastSyncedAt: at }) }).where(eq(accounts.id, id));
  }

  async credentialsFor(organizationId: string, id: string): Promise<GmailCredentials> {
    const [row] = await db.select().from(accounts).where(and(eq(accounts.organizationId, organizationId), eq(accounts.id, id)));
    if (!row) throw new NotFoundError('Email account not found');
    return credentials(row);
  }

  async list(organizationId: string) {
    const rows = await db.select().from(accounts).where(eq(accounts.organizationId, organizationId)).orderBy(desc(accounts.isActive), asc(accounts.createdAt));
    const source = rows.some((r) => r.isActive) ? ('organization' as const) : serverSmtpConfigured ? ('server' as const) : ('none' as const);
    return { source, accounts: rows.map(view) };
  }

  // The first account added becomes the active one, so a single account works without a further step.
  async create(organizationId: string, input: Required<MailAccountInput>) {
    const hasAny = (await db.$count(accounts, eq(accounts.organizationId, organizationId))) > 0;
    const [row] = await db
      .insert(accounts)
      .values({
        organizationId,
        fromEmail: input.fromEmail,
        fromName: input.fromName,
        clientId: input.clientId,
        clientSecretSealed: seal(input.clientSecret, env.JWT_SECRET),
        refreshTokenSealed: seal(input.refreshToken, env.JWT_SECRET),
        isActive: !hasAny,
      })
      .returning()
      .catch(duplicate);
    this.cache.delete(organizationId);
    return view(row!);
  }

  async update(organizationId: string, id: string, input: MailAccountInput) {
    const [row] = await db
      .update(accounts)
      .set({
        fromEmail: input.fromEmail,
        fromName: input.fromName,
        clientId: input.clientId,
        ...(input.clientSecret && { clientSecretSealed: seal(input.clientSecret, env.JWT_SECRET) }),
        ...(input.refreshToken && { refreshTokenSealed: seal(input.refreshToken, env.JWT_SECRET) }),
        updatedAt: new Date(),
      })
      .where(and(eq(accounts.organizationId, organizationId), eq(accounts.id, id)))
      .returning()
      .catch(duplicate);
    if (!row) throw new NotFoundError('Email account not found');
    this.cache.delete(organizationId);
    return view(row);
  }

  // Exactly one account is active at a time; switching takes effect for the next email sent.
  async activate(organizationId: string, id: string) {
    await db.transaction(async (tx) => {
      await tx.update(accounts).set({ isActive: false }).where(and(eq(accounts.organizationId, organizationId), eq(accounts.isActive, true)));
      const rows = await tx
        .update(accounts)
        .set({ isActive: true, updatedAt: new Date() })
        .where(and(eq(accounts.organizationId, organizationId), eq(accounts.id, id)))
        .returning({ id: accounts.id });
      if (rows.length === 0) throw new NotFoundError('Email account not found'); // rolls the first update back too
    });
    this.cache.delete(organizationId);
  }

  // Removing the active account hands over to the most recently added one left, so sending does not silently stop.
  async remove(organizationId: string, id: string) {
    await db.transaction(async (tx) => {
      const [gone] = await tx
        .delete(accounts)
        .where(and(eq(accounts.organizationId, organizationId), eq(accounts.id, id)))
        .returning({ isActive: accounts.isActive });
      if (!gone) throw new NotFoundError('Email account not found');
      if (!gone.isActive) return;
      const [next] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.organizationId, organizationId)).orderBy(desc(accounts.createdAt)).limit(1);
      if (next) await tx.update(accounts).set({ isActive: true }).where(eq(accounts.id, next.id));
    });
    this.cache.delete(organizationId);
  }
}

export const mailSettings = new MailSettingsService();

// True when mail for this organization can go out: through its active Gmail account, or through the server's SMTP settings.
export async function canSendMail(organizationId: string) {
  return serverSmtpConfigured || Boolean(await mailSettings.gmailFor(organizationId));
}
