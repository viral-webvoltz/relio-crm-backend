import { lookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isBlockedIp } from './webhooks.ssrf.js';

// The connection itself resolves the name through this function, so the address that is validated is the address that is dialled.
// (Checking first and letting fetch resolve again would leave a window for a DNS server to answer differently the second time.)
export const safeLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 4);
    if (addresses.length === 0 || addresses.some((a) => isBlockedIp(a.address))) {
      return callback(Object.assign(new Error('Destination resolves to a private or reserved address'), { code: 'EBLOCKED' }), '', 4);
    }
    if (options.all) return callback(null, addresses as never, undefined as never);
    const [first] = addresses;
    return callback(null, first?.address ?? '', first?.family ?? 4);
  });
};

// One request with a pinned, validated address. Resolves with the status code; the response body is never read and redirects are
// reported, never followed. IP-literal hosts skip name resolution, so they are checked directly here.
export function sendRequest({
  url,
  method,
  body,
  headers = {},
  timeoutMs,
}: {
  url: string;
  method: string;
  body?: string | undefined;
  headers?: Record<string, string>;
  timeoutMs: number;
}): Promise<number> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isBlockedIp(host)) return Promise.reject(Object.assign(new Error('Destination is a private or reserved address'), { code: 'EBLOCKED' }));
  return new Promise((resolve, reject) => {
    const request = new URL(url).protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        method,
        lookup: safeLookup,
        timeout: timeoutMs,
        headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers, 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        res.destroy();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('timeout', () => req.destroy(new Error('The request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

export const isBlockedError = (err: unknown) => typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EBLOCKED';
