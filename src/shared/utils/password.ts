import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import bcrypt from 'bcryptjs';

// scrypt from node:crypto runs on the libuv thread pool, so hashing never stalls the event loop.
// Format: scrypt$N$r$p$salt$hash (params travel with the hash so they can be raised later).
// Legacy bcrypt hashes ("$2…") still verify and are upgraded on the next successful login (see needsRehash).
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const opts = (n: number, r: number, p: number): ScryptOptions => ({ N: n, r, p, maxmem: 256 * n * r });

const derive = (password: string, salt: Buffer, n: number, r: number, p: number) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password.normalize('NFKC'), salt, KEY_LEN, opts(n, r, p), (err, key) => (err ? reject(err) : resolve(key))));

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string) {
  if (stored.startsWith('$2')) return bcrypt.compare(password, stored);
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const needsRehash = (stored: string) => !stored.startsWith(`scrypt$${N}$${R}$${P}$`);

// Compared against when the account does not exist, so response time does not reveal it.
let dummy: Promise<string> | undefined;
export const dummyHash = () => (dummy ??= hashPassword('not-a-real-password'));
