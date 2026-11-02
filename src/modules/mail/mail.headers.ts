import { randomUUID } from 'node:crypto';

// Domain of the MAIL_FROM address ("Name <a@b.com>" or "a@b.com"), else 'localhost'.
export function messageIdDomain(from: string | undefined): string {
  const m = from?.match(/@([A-Za-z0-9.-]+)>?\s*$/);
  return m?.[1] ?? 'localhost';
}

export const newMessageId = (from: string | undefined) => `<${randomUUID()}@${messageIdDomain(from)}>`;

// support@example.com + token -> support+token@example.com. Undefined when the base is not a plain address.
export function plusAddress(address: string | undefined, token: string): string | undefined {
  const m = address?.trim().match(/^([^@\s+<>]+)@([^@\s<>]+)$/);
  return m ? `${m[1]}+${token}@${m[2]}` : undefined;
}
