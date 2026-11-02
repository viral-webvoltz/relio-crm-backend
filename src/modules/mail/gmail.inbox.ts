import { extractAddress, extractReplyToken, parseInbound } from '@/modules/inbound-email/inbound-email.parse.js';
import { inboundEmailService } from '@/modules/inbound-email/inbound-email.service.js';
import { logger } from '@/shared/utils/logger.js';
import { GmailPermissionError, gmailGet, type GmailCredentials } from './gmail.client.js';
import { mailSettings } from './mail.settings.js';

const TICK_MS = 60_000;
const FIRST_RUN_MS = 20_000;
const FIRST_LOOKBACK = 'newer_than:2d'; // an account that has never been read starts with the last two days
const OVERLAP_SECONDS = 300; // each pass re-reads a little of the previous one; storing a reply twice is refused by its Message-ID
const PER_PASS = 100;

type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: { name: string; value: string }[] };
type Message = { id: string; threadId?: string; payload?: Part };

const decode = (data?: string) => (data ? Buffer.from(data, 'base64url').toString('utf8') : '');

function findPart(part: Part | undefined, mimeType: string): string {
  if (!part) return '';
  if (part.mimeType === mimeType && part.body?.data) return decode(part.body.data);
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return '';
}

// The plain-text version when there is one; otherwise the HTML with its tags taken out.
function bodyText(payload: Part | undefined) {
  const plain = findPart(payload, 'text/plain');
  if (plain) return plain;
  return findPart(payload, 'text/html')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ');
}

function toInbound(message: Message, organizationId: string) {
  const headers = Object.fromEntries((message.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
  return parseInbound({
    from: headers['from'] ?? '',
    to: [headers['to'], headers['delivered-to'], headers['x-original-to']].filter((v): v is string => Boolean(v)),
    subject: headers['subject'] ?? '',
    text: bodyText(message.payload),
    messageId: headers['message-id'] ?? `<gmail-${message.id}@gmail.invalid>`,
    inReplyTo: headers['in-reply-to'],
    references: headers['references'],
    headers,
    organizationId,
    threadId: message.threadId,
  });
}

async function readInbox(accountId: string, organizationId: string, lastSyncedAt: Date | null, credentials: GmailCredentials) {
  const startedAt = new Date();
  const after = lastSyncedAt ? `after:${Math.floor(lastSyncedAt.getTime() / 1000) - OVERLAP_SECONDS}` : FIRST_LOOKBACK;
  const list = await gmailGet<{ messages?: { id: string }[] }>(credentials, `messages?q=${encodeURIComponent(`in:inbox ${after}`)}&maxResults=${PER_PASS}`);

  for (const { id } of list.messages ?? []) {
    const message = await gmailGet<Message>(credentials, `messages/${id}?format=full`);
    const email = toInbound(message, organizationId);
    if (!email) continue;
    // Only mail that answers something we sent: it carries our reply address, or it is a reply to a message. Other mail is not the CRM's business.
    const isReply = email.to.some((t) => extractReplyToken(t)) || Boolean(email.inReplyTo);
    if (!isReply || extractAddress(email.from) === credentials.fromEmail.toLowerCase()) continue;
    try {
      await inboundEmailService.process(email);
    } catch (err) {
      logger.error({ err, accountId }, 'Failed to process a reply read from Gmail');
    }
  }
  await mailSettings.markSynced(accountId, { at: startedAt, error: null });
}

// Reads each connected Gmail inbox for answers to emails the CRM sent, and hands them to the same code that handles the inbound email hook:
// the reply is stored on the lead or contact, the status moves, and the assignee is told.
// ponytail: every instance reads every inbox; a duplicate is harmless (refused by Message-ID), a lock would only save some API calls.
export function startGmailInboxSync(): () => void {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const account of await mailSettings.accountsToSync()) {
        try {
          await readInbox(account.id, account.organizationId, account.lastSyncedAt, account.credentials);
        } catch (err) {
          const error = err instanceof GmailPermissionError ? err.message : `Could not read this inbox: ${err instanceof Error ? err.message : 'unknown error'}`.slice(0, 300);
          if (!(err instanceof GmailPermissionError)) logger.warn({ err, accountId: account.id }, 'Gmail inbox read failed');
          await mailSettings.markSynced(account.id, { at: new Date(), error }).catch(() => {});
        }
      }
    } catch (err) {
      logger.error({ err }, 'Gmail inbox sync failed');
    } finally {
      running = false;
    }
  };

  const first = setTimeout(() => void tick(), FIRST_RUN_MS);
  const timer = setInterval(() => void tick(), TICK_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
