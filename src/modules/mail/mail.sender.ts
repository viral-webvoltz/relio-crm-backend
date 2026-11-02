import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import { db } from '@/config/database.js';
import { env } from '@/config/env.js';
import { activities } from '@/database/schema/activities.js';
import { emailOutbox } from '@/database/schema/mail.js';
import { logger } from '@/shared/utils/logger.js';
import { sendViaGmail } from './gmail.client.js';
import { mailSettings } from './mail.settings.js';
import { oneLine } from './mail.templates.js';

const POLL_MS = 5_000;
const BATCH = 10;
const MAX_ATTEMPTS = 5;
const LEASE_SECONDS = 300; // a row stuck in 'sending' (crashed process) becomes due again after this
const backoffMs = (attempts: number) => Math.min(2 ** attempts * 30_000, 60 * 60_000);

// Claims one due row (queued, or a 'sending' row whose lease expired) so parallel instances never double-send.
function claim() {
  const due = db
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(and(inArray(emailOutbox.status, ['queued', 'sending']), lte(emailOutbox.nextAttemptAt, sql`now()`)))
    .orderBy(emailOutbox.nextAttemptAt)
    .limit(1)
    .for('update', { skipLocked: true });
  return db
    .update(emailOutbox)
    .set({ status: 'sending', attempts: sql`${emailOutbox.attempts} + 1`, nextAttemptAt: sql`now() + ${LEASE_SECONDS} * interval '1 second'` })
    .where(eq(emailOutbox.id, sql`(${due})`))
    .returning();
}

// Each organization sends through its own Gmail account when it has set one up; otherwise through the server-wide SMTP settings, if any.
// Always started: whether there is anything to send with is decided per message, so saving Gmail settings needs no restart.
export function startMailer(): () => void {
  const smtp = env.SMTP_URL && env.MAIL_FROM ? nodemailer.createTransport(env.SMTP_URL) : undefined;
  const smtpFrom = env.MAIL_FROM ? oneLine(env.MAIL_FROM) : undefined;
  let running = false;

  const deliver = async (mail: typeof emailOutbox.$inferSelect) => {
    const message = {
      to: oneLine(mail.toEmail),
      subject: oneLine(mail.subject),
      html: mail.bodyHtml,
      text: mail.bodyText,
      messageId: mail.messageId ?? undefined,
      replyTo: mail.replyTo ?? undefined,
      inReplyTo: mail.inReplyTo ?? undefined,
      references: mail.inReplyTo ?? undefined,
      headers: mail.headers ?? undefined,
    };
    const gmail = await mailSettings.gmailFor(mail.organizationId);
    if (gmail) {
      const sent = await sendViaGmail(gmail, message);
      // Replies to this email arrive in the same Gmail thread, which is how they are matched back even if headers were rewritten.
      if (sent.threadId && mail.messageId) {
        await db
          .update(activities)
          .set({ threadId: sent.threadId })
          .where(and(eq(activities.organizationId, mail.organizationId), eq(activities.messageId, mail.messageId.replace(/^<|>$/g, ''))));
      }
      return;
    }
    if (smtp && smtpFrom) return void (await smtp.sendMail({ ...message, from: smtpFrom }));
    throw new Error('Email sending is not set up for this organization');
  };

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (let i = 0; i < BATCH; i++) {
        const [mail] = await claim();
        if (!mail) break;
        try {
          await deliver(mail);
          await db.update(emailOutbox).set({ status: 'sent', sentAt: new Date(), lastError: null }).where(eq(emailOutbox.id, mail.id));
        } catch (err) {
          const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
          const failed = mail.attempts >= MAX_ATTEMPTS;
          logger.warn({ emailId: mail.id, attempts: mail.attempts, err: message }, failed ? 'Email failed permanently' : 'Email send failed, will retry');
          await db
            .update(emailOutbox)
            .set({ status: failed ? 'failed' : 'queued', lastError: message, nextAttemptAt: new Date(Date.now() + backoffMs(mail.attempts)) })
            .where(eq(emailOutbox.id, mail.id));
        }
      }
    } catch (err) {
      logger.error({ err }, 'Mailer tick failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), POLL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    smtp?.close();
  };
}
