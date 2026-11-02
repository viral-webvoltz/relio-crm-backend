import { describe, expect, it } from 'vitest';
import { open, seal } from './secret-box.js';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  hotp,
  normalizeRecoveryCode,
  otpauthUrl,
  stepAt,
  verifyTotp,
} from './totp.js';

// RFC 6238 appendix B: the SHA-1 secret is the ASCII string "12345678901234567890", and the published 8-digit codes end in the 6-digit ones.
const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));
const at = (seconds: number) => new Date(seconds * 1000);

describe('base32', () => {
  it('matches the RFC 4648 test vectors and round-trips random bytes', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(base32Decode('mzxw6ytboi======').toString()).toBe('foobar');
    const bytes = Buffer.from(Array.from({ length: 20 }, (_, i) => (i * 37 + 11) % 256));
    expect(Buffer.compare(base32Decode(base32Encode(bytes)), bytes)).toBe(0);
    expect(() => base32Decode('not base32!')).toThrow();
  });

  it('makes a 32-character secret from 160 random bits', () => {
    expect(generateSecret()).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateSecret()).not.toBe(generateSecret());
  });
});

describe('TOTP (RFC 6238 test vectors)', () => {
  it('produces the published codes', () => {
    for (const [seconds, code] of [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
      [20000000000, '353130'],
    ] as const) {
      expect(hotp(rfcSecret, stepAt(at(seconds)))).toBe(code);
    }
  });

  it('accepts the current step and one either side, no more', () => {
    const now = at(1111111111);
    const step = stepAt(now);
    expect(verifyTotp({ secret: rfcSecret, code: hotp(rfcSecret, step), now })).toBe(step);
    expect(verifyTotp({ secret: rfcSecret, code: hotp(rfcSecret, step - 1), now })).toBe(step - 1);
    expect(verifyTotp({ secret: rfcSecret, code: hotp(rfcSecret, step + 1), now })).toBe(step + 1);
    expect(verifyTotp({ secret: rfcSecret, code: hotp(rfcSecret, step - 2), now })).toBeNull();
    expect(verifyTotp({ secret: rfcSecret, code: hotp(rfcSecret, step + 2), now })).toBeNull();
  });

  it('refuses a code that was already used, or an older one', () => {
    const now = at(1111111111);
    const step = stepAt(now);
    expect(verifyTotp({ secret: rfcSecret, code: hotp(rfcSecret, step), now, lastUsedStep: step })).toBeNull(); // replay
    expect(verifyTotp({ secret: rfcSecret, code: hotp(rfcSecret, step - 1), now, lastUsedStep: step })).toBeNull(); // older than the last one
    expect(verifyTotp({ secret: rfcSecret, code: hotp(rfcSecret, step + 1), now, lastUsedStep: step })).toBe(step + 1);
  });

  it('rejects anything that is not six digits', () => {
    for (const code of ['', '12345', '1234567', 'abcdef', '12 456', '０８１８０４'])
      expect(verifyTotp({ secret: rfcSecret, code, now: at(1111111109) })).toBeNull();
  });

  it('builds the link an authenticator app scans', () => {
    const url = otpauthUrl({ secret: 'ABC234', issuer: 'My CRM', account: 'a+b@x.test' });
    expect(url).toBe('otpauth://totp/My%20CRM:a%2Bb%40x.test?secret=ABC234&issuer=My%20CRM&algorithm=SHA1&digits=6&period=30');
  });
});

describe('recovery codes', () => {
  it('makes ten distinct codes without look-alike characters', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
  });

  it('matches however it is typed', () => {
    expect(normalizeRecoveryCode(' abcde-fghjk ')).toBe('ABCDEFGHJK');
    expect(hashRecoveryCode('abcde-fghjk')).toBe(hashRecoveryCode('ABCDEFGHJK'));
    expect(hashRecoveryCode('abcde-fghjk')).not.toBe(hashRecoveryCode('abcde-fghjm'));
  });
});

describe('secret box', () => {
  const key = 'k'.repeat(40);

  it('round-trips and uses a fresh nonce each time', () => {
    const a = seal('JBSWY3DPEHPK3PXP', key);
    expect(open(a, key)).toBe('JBSWY3DPEHPK3PXP');
    expect(seal('JBSWY3DPEHPK3PXP', key)).not.toBe(a);
    expect(a).not.toContain('JBSWY3DPEHPK3PXP');
  });

  it('refuses a wrong key, a tampered value and garbage', () => {
    const sealed = seal('secret', key);
    expect(() => open(sealed, 'z'.repeat(40))).toThrow();
    const [v, iv, tag, ct] = sealed.split('.');
    expect(() => open([v, iv, tag, Buffer.from('x').toString('base64url')].join('.'), key)).toThrow();
    expect(() => open([v, iv, ct, tag].join('.'), key)).toThrow();
    expect(() => open('nonsense', key)).toThrow();
  });
});
