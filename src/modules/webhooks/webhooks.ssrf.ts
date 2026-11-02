import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { env } from '@/config/env.js';

const blocked = new BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3], // multicast + reserved (224.0.0.0 - 255.255.255.255)
] as const)
  blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64
  ['100::', 64], // discard
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const)
  blocked.addSubnet(addr, prefix, 'ipv6');

// An IPv4-mapped IPv6 address (::ffff:a.b.c.d, or ::ffff:hhhh:hhhh as URL parsing normalises it) is judged as the IPv4 address it wraps.
// This cannot be a ::ffff:0:0/96 blocklist rule: BlockList also matches plain IPv4 addresses against it, which would block every IPv4 destination.
const unwrapMappedIpv4 = (address: string) => {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (dotted?.[1]) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex?.[1] || !hex[2]) return null;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
};

export const isBlockedIp = (address: string): boolean => {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6) {
    const mapped = unwrapMappedIpv4(address);
    if (mapped) return isBlockedIp(mapped);
  }
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
};

// Static checks, run when an endpoint is saved. Returns an error message or null.
export function urlProblem(raw: string): string | null {
  if (raw.length > 2048) return 'URL is too long';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Invalid URL';
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && env.NODE_ENV !== 'production')) return 'URL must use https';
  if (url.username || url.password) return 'URL must not contain credentials';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isBlockedIp(host)) return 'URL points to a private or reserved address';
  return null;
}

// Resolve-and-check helper. Delivery itself no longer relies on it: webhooks.http.ts validates the address the connection actually uses.
export async function assertPublicHost(raw: string) {
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some((a) => isBlockedIp(a.address))) throw new Error('Destination resolves to a private or reserved address');
}
