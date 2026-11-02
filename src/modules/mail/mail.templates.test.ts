import { describe, expect, it } from 'vitest';
import { messageIdDomain, plusAddress } from './mail.headers.js';
import { defaultTemplates, renderTemplate, unknownPlaceholders } from './mail.templates.js';

describe('renderTemplate', () => {
  it('escapes html values, sanitises subject, leaves unknown placeholders empty', () => {
    const out = renderTemplate({ subject: 'Hi {{subject}} {{nope}}', bodyHtml: '<p>{{reply_body}}{{nope}}</p>', bodyText: '{{reply_body}}' }, 'ticket_reply', {
      subject: 'a\r\nBcc: x@evil.com',
      reply_body: '<script>"x"</script>',
    });
    expect(out.subject).toBe('Hi a Bcc: x@evil.com');
    expect(out.html).toBe('<p>&lt;script&gt;&quot;x&quot;&lt;/script&gt;</p>');
    expect(out.text).toBe('<script>"x"</script>');
  });
  it('does not rescan substituted values and ignores variables outside the allow-list', () => {
    const out = renderTemplate({ subject: 's', bodyHtml: '{{subject}}|{{items}}', bodyText: 't' }, 'ticket_received', {
      subject: '{{ticket_number}}',
      items: 'secret',
    });
    expect(out.html).toBe('{{ticket_number}}|');
  });
  it('defaults render', () => {
    expect(renderTemplate(defaultTemplates.ticket_reply, 'ticket_reply', { ticket_number: 5, subject: 'S', reply_body: 'b' }).subject).toBe('Re: [#5] S');
  });
  it('lists unknown placeholders', () => {
    expect(unknownPlaceholders('{{a}} {{ b }} {{c}}', ['a'])).toEqual(['b', 'c']);
  });
});

describe('mail headers', () => {
  it('derives the Message-ID domain', () => {
    expect(messageIdDomain('Acme <noreply@acme.io>')).toBe('acme.io');
    expect(messageIdDomain('x@acme.io')).toBe('acme.io');
    expect(messageIdDomain(undefined)).toBe('localhost');
  });
  it('builds plus-addresses', () => {
    expect(plusAddress('support@x.com', 'tok')).toBe('support+tok@x.com');
    expect(plusAddress(undefined, 'tok')).toBeUndefined();
  });
});
