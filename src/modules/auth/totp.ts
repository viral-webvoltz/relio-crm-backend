import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

// Time-based one-time passwords (RFC 6238 over RFC 4226): HMAC-SHA1, 30-second steps, 6 digits. What every authenticator app speaks.
export const STEP_SECONDS = 30;
export const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/=+$/, '').toUpperCase()) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Not a base32 string');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const generateSecret = () => base32Encode(randomBytes(20)); // 160 bits, the size RFC 4226 recommends

// The one-time code for a counter value, with the given number of digits (RFC 4226 dynamic truncation).
export function hotp(secret: string, counter: number, digits = DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = mac[mac.length - 1]! & 15;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export const stepAt = (time: Date | number) => Math.floor((typeof time === 'number' ? time : time.getTime()) / 1000 / STEP_SECONDS);

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Accepts the code of the current step and one step either side (clock drift). Returns the step it matched, or null.
// `lastUsedStep` makes a code single-use: the same code cannot be replayed, nor an older one.
export function verifyTotp({
  secret,
  code,
  now = new Date(),
  lastUsedStep = null,
  window = 1,
}: {
  secret: string;
  code: string;
  now?: Date;
  lastUsedStep?: number | null;
  window?: number;
}): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = stepAt(now);
  let matched: number | null = null;
  for (let step = current - window; step <= current + window; step++) {
    // every step is compared, so the time taken does not reveal which one matched
    if (safeEqual(hotp(secret, step), code) && matched === null) matched = step;
  }
  return matched !== null && (lastUsedStep === null || matched > lastUsedStep) ? matched : null;
}

// What an authenticator app scans.
export const otpauthUrl = ({ secret, issuer, account }: { secret: string; issuer: string; account: string }) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;

// Recovery codes: ten one-time codes for when the phone is lost. No look-alike characters (0/O, 1/I/L).
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const RECOVERY_CODE_COUNT = 10;
export const generateRecoveryCodes = (count = RECOVERY_CODE_COUNT) =>
  Array.from({ length: count }, () => {
    const pick = () => Array.from({ length: 5 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('');
    return `${pick()}-${pick()}`;
  });
// Stored as a hash (they are high-entropy random codes, so a plain SHA-256 is enough). Typed in any case, with or without the dash.
export const normalizeRecoveryCode = (code: string) => code.replace(/[\s-]/g, '').toUpperCase();
export const hashRecoveryCode = (code: string) => createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
