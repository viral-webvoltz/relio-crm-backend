import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/config/env.js';

// The reply-to plus-address of an email sent from a lead or contact carries its own activity id plus a short MAC, so a reply finds its
// conversation with no stored token and nobody can forge an address for someone else's record. 32 hex id + 12 hex mac = 44 chars.
const mac = (id: string) => createHmac('sha256', env.JWT_SECRET).update(`record-email:${id}`).digest('hex').slice(0, 12);

export const makeReplyToken = (activityId: string) => activityId.replaceAll('-', '') + mac(activityId);

// Returns the activity id, or undefined when the token is not one of ours.
export function readReplyToken(token: string): string | undefined {
  if (!/^[a-f0-9]{44}$/.test(token)) return undefined;
  const h = token.slice(0, 32);
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  const given = Buffer.from(token.slice(32));
  const expected = Buffer.from(mac(id));
  return given.length === expected.length && timingSafeEqual(given, expected) ? id : undefined;
}
