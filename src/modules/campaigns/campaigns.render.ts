import { esc, renderWith, type TemplateContent } from '@/modules/mail/mail.templates.js';

export const campaignVariables = ['first_name', 'last_name', 'full_name', 'email', 'unsubscribe_link'] as const;

export const SAMPLE_RECIPIENT = {
  first_name: 'Alex',
  last_name: 'Example',
  full_name: 'Alex Example',
  email: 'alex@example.com',
  unsubscribe_link: 'https://app.example.com/unsubscribe/sample',
};

const linkPattern = /href\s*=\s*(["'])(https?:\/\/.*?)\1/gi;
const decode = (url: string) => url.replaceAll('&amp;', '&');

const isHttpUrl = (value: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

// The distinct web links in the HTML body (what click tracking will cover). Placeholders such as {{unsubscribe_link}} are not links yet.
export function extractLinks(html: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(linkPattern)) {
    const url = decode(match[2] ?? '');
    if (isHttpUrl(url)) urls.add(url);
  }
  return [...urls];
}

// Swaps each tracked link for its redirect URL. Do this before filling placeholders, so personal values are never mistaken for links.
export function rewriteLinks(html: string, redirectFor: (url: string) => string | undefined): string {
  return html.replace(linkPattern, (whole, quote: string, url: string) => {
    const redirect = redirectFor(decode(url));
    return redirect ? `href=${quote}${esc(redirect)}${quote}` : whole;
  });
}

export function withOpenPixel(html: string, src: string): string {
  const pixel = `<img src="${esc(src)}" width="1" height="1" alt="" style="display:none">`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${pixel}</body>`) : html + pixel;
}

export type Recipient = { first_name: string; last_name: string; full_name: string; email: string; unsubscribe_link: string };

export const renderCampaign = (content: TemplateContent, recipient: Recipient) => renderWith(content, campaignVariables, recipient);

// A bulk email without an unsubscribe link is not allowed to leave.
export const hasUnsubscribe = (content: Pick<TemplateContent, 'bodyHtml' | 'bodyText'>) =>
  /\{\{\s*unsubscribe_link\s*\}\}/.test(content.bodyHtml) && /\{\{\s*unsubscribe_link\s*\}\}/.test(content.bodyText);

export const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
