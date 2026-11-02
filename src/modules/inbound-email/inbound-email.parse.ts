import { z } from 'zod';

export const MAX_TEXT = 20_000;

// Normalised shape any provider adapter must produce (POSTed as JSON to /inbound/email):
//   { from, to: string | string[], subject, text, html?, messageId, inReplyTo?, references?: string | string[],
//     headers?: { Name: value } | [{ Name, Value }], organizationId? }
// html is accepted but ignored: only text is ever stored.
const headersSchema = z.union([z.record(z.string(), z.string()), z.array(z.object({ Name: z.string(), Value: z.string() }))]);

const normalisedSchema = z.object({
  from: z.string().min(1).max(998),
  to: z.union([z.string(), z.array(z.string())]),
  subject: z.string().max(998).default(''),
  text: z.string().default(''),
  html: z.string().optional(),
  messageId: z.string().min(1).max(998),
  inReplyTo: z.string().max(998).optional(),
  references: z.union([z.string(), z.array(z.string())]).optional(),
  headers: headersSchema.optional(),
  organizationId: z.uuid().optional(),
  threadId: z.string().max(200).optional(), // Gmail inbox reading only
});

const opt = z.string().nullish();
const postmarkSchema = z.object({
  From: z.string(),
  FromFull: z.object({ Email: z.string() }).nullish(),
  To: opt,
  ToFull: z.array(z.object({ Email: z.string() })).nullish(),
  OriginalRecipient: opt,
  Subject: opt,
  TextBody: opt,
  HtmlBody: opt,
  MessageID: z.string(),
  Headers: z.array(z.object({ Name: z.string(), Value: z.string() })).nullish(),
});

export type InboundEmail = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  messageId: string; // bare, no angle brackets
  inReplyTo?: string;
  references: string[];
  headers: Record<string, string>; // lower-case names
  organizationId?: string;
  threadId?: string;
};

export const normId = (id: string) => id.trim().replace(/^<|>$/g, '');
const splitIds = (value: string) =>
  value
    .split(/[\s,]+/)
    .map(normId)
    .filter(Boolean);
const asList = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function toHeaderMap(headers: z.infer<typeof headersSchema> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = Array.isArray(headers) ? headers.map((h) => [h.Name, h.Value] as const) : Object.entries(headers ?? {});
  for (const [name, value] of entries) out[name.toLowerCase()] = value;
  return out;
}

// Postmark inbound field names -> normalised shape. Postmark's own MessageID is not the RFC Message-ID, so the header wins.
export function adaptPostmark(raw: z.infer<typeof postmarkSchema>) {
  const headers = toHeaderMap(raw.Headers);
  const to = raw.ToFull?.length ? raw.ToFull.map((t) => t.Email) : [raw.To ?? '']; // OriginalRecipient is the real envelope target (plus-address survives)
  if (raw.OriginalRecipient) to.unshift(raw.OriginalRecipient);
  return {
    from: raw.FromFull?.Email || raw.From,
    to,
    subject: raw.Subject ?? '',
    text: raw.TextBody ?? '',
    html: raw.HtmlBody ?? undefined,
    messageId: headers['message-id'] ?? raw.MessageID,
    inReplyTo: headers['in-reply-to'],
    references: headers['references'],
    headers,
  };
}

// Returns undefined when the body is neither shape.
export function parseInbound(body: unknown): InboundEmail | undefined {
  const pm = postmarkSchema.safeParse(body);
  const candidate = pm.success ? adaptPostmark(pm.data) : body;
  const parsed = normalisedSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  const p = parsed.data;
  const headers = toHeaderMap(p.headers);
  const inReplyTo = p.inReplyTo ?? headers['in-reply-to'];
  return {
    from: p.from,
    to: asList(p.to),
    subject: p.subject.trim(),
    text: p.text,
    messageId: normId(p.messageId),
    inReplyTo: inReplyTo ? normId(inReplyTo) : undefined,
    references: [...asList(p.references ?? headers['references']).flatMap(splitIds)],
    headers,
    organizationId: p.organizationId,
    threadId: p.threadId,
  };
}

// "Name <a@b.com>" or "a@b.com" -> lower-case address.
export function extractAddress(value: string): string | undefined {
  const m = value.match(/<([^<>\s]+@[^<>\s]+)>/) ?? value.trim().match(/^([^<>\s,;]+@[^<>\s,;]+)$/);
  return m?.[1]?.toLowerCase();
}

// local+token@domain -> token (lowercase hex: 20 chars for tickets, see support.repository newReplyToken; 44 for record emails, see record-emails.token).
export function extractReplyToken(address: string): string | undefined {
  return address.toLowerCase().match(/\+([a-f0-9]{20,64})@/)?.[1];
}

// Auto-replies, bulk mail and bounces must never create or extend tickets (mail loops).
export function isAutomated(from: string, headers: Record<string, string>): boolean {
  const auto = headers['auto-submitted']?.trim().toLowerCase();
  if (auto && auto !== 'no') return true;
  if (/^(bulk|junk|list)\b/i.test(headers['precedence']?.trim() ?? '')) return true;
  const local = extractAddress(from)?.split('@')[0] ?? '';
  return /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)/.test(local);
}

// Heuristic: keep the new text, drop the quoted history. Stops at the first "On ... wrote:" line,
// "Original Message" divider or ">" quote line. Plain text only; capped at MAX_TEXT.
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const wrapped = `${line} ${lines[i + 1] ?? ''}`; // clients wrap long attribution lines
    if (
      line.startsWith('>') ||
      /^-{2,}\s*(original message|forwarded message)\s*-{2,}\s*$/i.test(line.trim()) ||
      /^on\s.+\swrote:\s*$/i.test(line.trim()) ||
      /^on\s.+\swrote:\s*$/i.test(wrapped.trim())
    )
      break;
    kept.push(line);
  }
  return kept.join('\n').trim().slice(0, MAX_TEXT);
}
