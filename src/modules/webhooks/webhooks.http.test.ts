import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// A local server stands in for the receiver, so the "private address" rule is switched off for this file only.
// The refusal itself is covered in webhooks.ssrf.test.ts and workflows.events.test.ts.
vi.mock('./webhooks.ssrf.js', () => ({ isBlockedIp: () => false }));

const { sendRequest } = await import('./webhooks.http.js');

describe('sendRequest (the connection used by webhooks and workflow HTTP steps)', () => {
  let server: Server;
  let base: string;
  let seen: { method?: string | undefined; headers: IncomingHttpHeaders; body: string } | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        seen = { method: req.method, headers: req.headers, body };
        if (req.url === '/redirect') return void res.writeHead(302, { location: 'http://169.254.169.254/' }).end();
        if (req.url === '/slow') return; // never answers
        res.writeHead(req.url === '/fail' ? 500 : 204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it('sends the method, custom headers and JSON body, and returns the status', async () => {
    const status = await sendRequest({
      url: `${base}/hook`,
      method: 'POST',
      body: '{"a":1}',
      headers: { 'x-webhook-event': 'leads.create' },
      timeoutMs: 2_000,
    });
    expect(status).toBe(204);
    expect(seen?.method).toBe('POST');
    expect(seen?.body).toBe('{"a":1}');
    expect(seen?.headers['x-webhook-event']).toBe('leads.create');
    expect(seen?.headers['content-type']).toBe('application/json');
    expect(seen?.headers['content-length']).toBe('7');
  });

  it('reports error statuses and redirects without following them', async () => {
    expect(await sendRequest({ url: `${base}/fail`, method: 'GET', timeoutMs: 2_000 })).toBe(500);
    expect(await sendRequest({ url: `${base}/redirect`, method: 'GET', timeoutMs: 2_000 })).toBe(302);
  });

  it('gives up when the server never answers', async () => {
    await expect(sendRequest({ url: `${base}/slow`, method: 'GET', timeoutMs: 200 })).rejects.toThrow();
  });
});
