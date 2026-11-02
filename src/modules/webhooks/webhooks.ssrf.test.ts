import { describe, expect, it } from 'vitest';
import { assertPublicHost, isBlockedIp, urlProblem } from './webhooks.ssrf.js';

describe('isBlockedIp', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254', // cloud metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '64:ff9b::7f00:1',
    'not-an-ip',
  ])('blocks %s', (ip) => expect(isBlockedIp(ip)).toBe(true));

  // A mapped address is judged as the IPv4 address it wraps.
  it('allows a mapped public IPv4 and blocks a mapped private one', () => {
    expect(isBlockedIp('::ffff:8.8.8.8')).toBe(false);
    expect(isBlockedIp('::ffff:192.168.1.1')).toBe(true);
  });

  it('allows a public IPv6 literal', () => expect(isBlockedIp('2606:4700:4700::1111')).toBe(false));

  // Regression: a ::ffff:0:0/96 blocklist rule made node's BlockList report every plain IPv4 address as blocked.
  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1'])('allows public IPv4 %s', (ip) => expect(isBlockedIp(ip)).toBe(false));
});

describe('urlProblem', () => {
  it('accepts a public https URL', () => {
    expect(urlProblem('https://example.com/hook')).toBeNull();
  });
  it('rejects bad URLs', () => {
    expect(urlProblem('nope')).toBe('Invalid URL');
    expect(urlProblem(`https://example.com/${'a'.repeat(2048)}`)).toBe('URL is too long');
    expect(urlProblem('ftp://example.com')).toBe('URL must use https');
    expect(urlProblem('https://user:pw@example.com')).toBe('URL must not contain credentials');
  });
  it.each([
    'https://127.0.0.1/x',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[fe80::1]/',
    'https://2130706433/', // decimal form is normalised by URL to 127.0.0.1
  ])('rejects private literal %s', (u) => expect(urlProblem(u)).toBe('URL points to a private or reserved address'));
});

describe('public IPv4 destinations', () => {
  it('urlProblem accepts https://8.8.8.8/hook', () => expect(urlProblem('https://8.8.8.8/hook')).toBeNull());
  it('assertPublicHost accepts 8.8.8.8', async () => {
    await assertPublicHost('https://8.8.8.8/');
  });
});

describe('assertPublicHost', () => {
  it('rejects private literals and accepts a public IPv6 one without DNS', async () => {
    await expect(assertPublicHost('https://127.0.0.1/')).rejects.toThrow(/private or reserved/);
    await expect(assertPublicHost('https://[::1]/')).rejects.toThrow(/private or reserved/);
    await expect(assertPublicHost('https://[2606:4700:4700::1111]/')).resolves.toBeUndefined();
  });
});
