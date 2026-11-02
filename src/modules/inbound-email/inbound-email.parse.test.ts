import { describe, expect, it } from 'vitest';
import { adaptPostmark, extractAddress, extractReplyToken, isAutomated, parseInbound, stripQuotedReply } from './inbound-email.parse.js';

describe('stripQuotedReply', () => {
  it('cuts at "On ... wrote:" and quote blocks', () => {
    expect(stripQuotedReply('Thanks!\r\n\r\nOn Mon, 1 Jan 2026, Support <s@x.com> wrote:\r\n> old')).toBe('Thanks!');
    expect(stripQuotedReply('Hi\n> quoted\nmore')).toBe('Hi');
  });
  it('handles a wrapped attribution line and caps length', () => {
    expect(stripQuotedReply('Yes\nOn Mon, 1 Jan 2026 at 10:00, Support\n<s@x.com> wrote:\n> x')).toBe('Yes');
    expect(stripQuotedReply('a'.repeat(30_000))).toHaveLength(20_000);
  });
});

describe('postmark adapter', () => {
  it('maps fields and prefers the Message-ID header', () => {
    const raw = {
      From: 'A <a@x.com>',
      To: 'support@y.com',
      Subject: 'Hello',
      TextBody: 'body',
      HtmlBody: '<b>x</b>',
      MessageID: 'pm-id',
      Headers: [
        { Name: 'Message-ID', Value: '<abc@x.com>' },
        { Name: 'In-Reply-To', Value: '<prev@y.com>' },
        { Name: 'References', Value: '<r1@y.com> <prev@y.com>' },
      ],
    };
    const email = parseInbound(raw);
    expect(email).toMatchObject({ from: 'A <a@x.com>', messageId: 'abc@x.com', inReplyTo: 'prev@y.com', references: ['r1@y.com', 'prev@y.com'], text: 'body' });
    expect(adaptPostmark({ From: 'a@x.com', MessageID: 'm' }).messageId).toBe('m');
  });
  it('accepts the normalised shape and rejects junk', () => {
    expect(parseInbound({ from: 'a@x.com', to: 'b@y.com', subject: 's', text: 't', messageId: '<m@x>' })?.messageId).toBe('m@x');
    expect(parseInbound({ nope: 1 })).toBeUndefined();
  });
});

describe('addresses and tokens', () => {
  it('extracts addresses', () => {
    expect(extractAddress('Alex <Alex@X.com>')).toBe('alex@x.com');
    expect(extractAddress('nonsense')).toBeUndefined();
  });
  it('extracts the plus-address token', () => {
    const t = 'a1b2c3d4e5f6a7b8c9d0';
    expect(extractReplyToken(`Support <support+${t.toUpperCase()}@y.com>`)).toBe(t);
    expect(extractReplyToken('support@y.com')).toBeUndefined();
    expect(extractReplyToken('support+short@y.com')).toBeUndefined();
  });
});

describe('isAutomated', () => {
  it('flags auto mail and system senders', () => {
    expect(isAutomated('a@x.com', { 'auto-submitted': 'auto-replied' })).toBe(true);
    expect(isAutomated('a@x.com', { 'auto-submitted': 'no' })).toBe(false);
    expect(isAutomated('a@x.com', { precedence: 'bulk' })).toBe(true);
    expect(isAutomated('MAILER-DAEMON@x.com', {})).toBe(true);
    expect(isAutomated('No-Reply <no-reply@x.com>', {})).toBe(true);
    expect(isAutomated('alex@x.com', {})).toBe(false);
  });
});
