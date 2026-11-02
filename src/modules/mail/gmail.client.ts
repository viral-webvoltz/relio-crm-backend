import { createHash } from 'node:crypto';
import nodemailer, { type SendMailOptions } from 'nodemailer';

export type GmailCredentials = {
  fromEmail: string;
  fromName: string | null;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

// Sent through the Gmail API over HTTPS rather than SMTP: smtp.gmail.com is blocked on some hosts, HTTPS is not. Needs the Gmail API enabled
// on the OAuth client's Google Cloud project and the gmail.send scope on the refresh token. nodemailer only builds the MIME message.
const mimeBuilder = nodemailer.createTransport({ streamTransport: true, buffer: true });

const tokens = new Map<string, { value: string; expiresAt: number }>();

// Google's own wording ("Unauthorized") does not say what to fix, so the common refusals are explained.
function refusal(status: number, code?: string, description?: string) {
  const why: Record<string, string> = {
    unauthorized_client: 'The refresh token was created with a different client ID than the one saved here. Create it again using this exact client ID and secret (in the OAuth Playground, tick "Use your own OAuth credentials").',
    invalid_client: 'The client ID or client secret is wrong. Copy both again from Google Cloud.',
    invalid_grant: 'The refresh token has expired or been revoked. Create a new one and save it.',
  };
  return `Google rejected the credentials (${status}${code ? ` ${code}` : ''}). ${(code && why[code]) ?? description ?? 'Check the client ID, client secret and refresh token.'}`;
}

async function accessToken(c: GmailCredentials): Promise<string> {
  const cacheKey = `${c.clientId}:${createHash('sha256').update(c.refreshToken).digest('hex').slice(0, 16)}`;
  const cached = tokens.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) throw new Error(refusal(res.status, data.error, data.error_description));
  tokens.set(cacheKey, { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 });
  return data.access_token;
}

// `"Name" <address>`, with anything that could break the header stripped from the name.
export function fromHeader(c: Pick<GmailCredentials, 'fromEmail' | 'fromName'>) {
  const name = c.fromName?.replace(/["\r\n<>]/g, '').trim();
  return name ? `"${name}" <${c.fromEmail}>` : c.fromEmail;
}

// Returns Gmail's ids for the sent message; the thread id lets a reply in the same conversation be matched back to it.
export async function sendViaGmail(c: GmailCredentials, message: Omit<SendMailOptions, 'from'>): Promise<{ id: string; threadId: string | null }> {
  const built = (await mimeBuilder.sendMail({ ...message, from: fromHeader(c) })) as unknown as { message: Buffer };
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${await accessToken(c)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: built.message.toString('base64url') }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Gmail send failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const sent = (await res.json().catch(() => ({}))) as { id?: string; threadId?: string };
  return { id: sent.id ?? '', threadId: sent.threadId ?? null };
}

export class GmailPermissionError extends Error {}

// Read-only call to the Gmail API. A 403 means the refresh token was granted without the gmail.readonly scope.
export async function gmailGet<T>(c: GmailCredentials, path: string): Promise<T> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { authorization: `Bearer ${await accessToken(c)}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 403 || res.status === 401) {
    throw new GmailPermissionError('Gmail has not allowed this connection to read mail. Reconnect it with the gmail.readonly permission.');
  }
  if (!res.ok) throw new Error(`Gmail read failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}
