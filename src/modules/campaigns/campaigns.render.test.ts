import { describe, expect, it } from 'vitest';
import { extractLinks, hasUnsubscribe, renderCampaign, rewriteLinks, SAMPLE_RECIPIENT, withOpenPixel } from './campaigns.render.js';

const html = `<p>Hi {{first_name}}</p><a href="https://shop.example.com/sale?a=1&amp;b=2">Sale</a> <a href='http://x.test/'>x</a> <a href="mailto:me@x.test">mail</a> <a href="{{unsubscribe_link}}">Unsubscribe</a> <a href="https://shop.example.com/sale?a=1&amp;b=2">again</a>`;

describe('campaign rendering', () => {
  it('finds each web link once, decoding entities, and ignores mailto and placeholders', () => {
    expect(extractLinks(html)).toEqual(['https://shop.example.com/sale?a=1&b=2', 'http://x.test/']);
  });

  it('rewrites only the tracked links and leaves placeholders alone', () => {
    const out = rewriteLinks(html, (url) => (url.startsWith('https://shop') ? 'https://api.test/c/1/tok' : undefined));
    expect(out).toContain('href="https://api.test/c/1/tok"');
    expect(out).toContain("href='http://x.test/'");
    expect(out).toContain('href="{{unsubscribe_link}}"');
    expect(out).not.toContain('shop.example.com');
  });

  it('puts the open pixel before </body>, or at the end', () => {
    expect(withOpenPixel('<body>x</body>', 'https://api.test/o/t.gif')).toMatch(/x<img src="https:\/\/api.test\/o\/t.gif"[^>]*><\/body>/);
    expect(withOpenPixel('x', 'https://api.test/o/t.gif').startsWith('x<img')).toBe(true);
  });

  it('fills only the allowed placeholders and escapes values in HTML', () => {
    const out = renderCampaign(
      { subject: 'Hi {{first_name}}', bodyHtml: '<p>{{first_name}} {{secret}}</p>', bodyText: '{{first_name}} {{unsubscribe_link}}' },
      { ...SAMPLE_RECIPIENT, first_name: '<b>Al</b>' },
    );
    expect(out.html).toBe('<p>&lt;b&gt;Al&lt;/b&gt; </p>');
    expect(out.text).toBe(`<b>Al</b> ${SAMPLE_RECIPIENT.unsubscribe_link}`);
    expect(out.subject).toBe('Hi <b>Al</b>');
  });

  it('requires an unsubscribe link in both bodies', () => {
    expect(hasUnsubscribe({ bodyHtml: '{{unsubscribe_link}}', bodyText: '{{ unsubscribe_link }}' })).toBe(true);
    expect(hasUnsubscribe({ bodyHtml: '{{unsubscribe_link}}', bodyText: 'no' })).toBe(false);
  });
});
