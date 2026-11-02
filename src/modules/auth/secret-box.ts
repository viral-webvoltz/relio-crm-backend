import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// Encrypts small secrets (the 2FA seed) before they are stored, so a copy of the database alone does not hand out working second factors.
// AES-256-GCM, with a key derived from the server secret; the stored form carries its own version, nonce and authentication tag.
const keyFrom = (serverSecret: string) => Buffer.from(hkdfSync('sha256', serverSecret, 'crm-secret-box', 'totp-seed-v1', 32));

export function seal(plain: string, serverSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(serverSecret), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

// Throws if the value was altered or the key is wrong.
export function open(sealed: string, serverSecret: string): string {
  const [version, iv, tag, ciphertext] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Unrecognised sealed value');
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(serverSecret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
