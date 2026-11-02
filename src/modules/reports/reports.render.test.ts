import { describe, expect, it } from 'vitest';
import { renderTables, toTables } from './reports.render.js';

const evil = '<script>alert("x")</script>&\'';

describe('renderTables', () => {
  const range = { from: '2026-01-01', to: '2026-03-31' };

  it('escapes the name, titles, columns and every cell in html', () => {
    const { html } = renderTables({ name: evil, range, tables: [{ title: evil, columns: [evil], rows: [[evil, 1, null]] }] });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;');
    expect(html).toContain('<td>1</td><td></td>');
  });

  it('keeps cell line breaks out of the plain text rows', () => {
    const { text, subject } = renderTables({ name: 'A', range, tables: [{ title: 'T', columns: ['C'], rows: [['one\nfake | row']] }] });
    expect(text.split('\n')).toContain('one fake | row');
    expect(subject).toBe('Report: A');
  });

  it('renders report output into tables, escaping stage names', () => {
    const tables = toTables({
      type: 'leads-funnel',
      data: { range, total: 4, converted: 1, conversionRate: 0.25, byStatus: [{ status: evil, count: 4 }], bySource: [] },
    });
    const { html, text } = renderTables({ name: 'Leads', range, tables });
    expect(html).toContain('25.0%');
    expect(html).not.toContain('<script>');
    expect(text).toContain('Leads | Converted | Conversion rate');
  });
});
