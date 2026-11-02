import { esc, money } from '@/modules/mail/mail.templates.js';
import type { ReportOutput } from './reports.types.js';

export type ReportTable = { title: string; columns: string[]; rows: (string | number | null)[][] };

const amount = (minor: number, currency: string | null) => {
  if (!currency) return String(minor);
  try {
    return money(minor, currency);
  } catch {
    return `${minor} ${currency}`; // not a valid ISO currency code
  }
};
const pct = (rate: number | null) => (rate == null ? '-' : `${(rate * 100).toFixed(1)}%`);

export function toTables(output: ReportOutput): ReportTable[] {
  if (output.type === 'revenue-by-month') {
    return [
      {
        title: 'Revenue by month',
        columns: ['Month', 'Currency', 'Invoiced', 'Collected', 'Orders', 'Order total'],
        rows: output.data.rows.map((r) => [
          r.month,
          r.currency,
          amount(r.invoicedMinor, r.currency),
          amount(r.collectedMinor, r.currency),
          r.orderCount,
          amount(r.orderTotalMinor, r.currency),
        ]),
      },
    ];
  }
  if (output.type === 'pipeline-velocity') {
    const d = output.data;
    return [
      {
        title: 'Stages',
        columns: ['Stage', 'Kind', 'Currency', 'Deals', 'Value', 'Avg age (days)'],
        rows: d.stages.map((s) => [s.stage, s.kind, s.currency, s.dealCount, amount(s.valueMinor, s.currency), s.avgAgeDays]),
      },
      {
        title: 'Summary',
        columns: ['Won', 'Lost', 'Win rate', 'Avg days to won'],
        rows: [[d.summary.won, d.summary.lost, pct(d.summary.winRate), d.summary.avgDaysToWon]],
      },
      {
        title: 'Won deals',
        columns: ['Currency', 'Deals', 'Value', 'Average value'],
        rows: d.wonByCurrency.map((w) => [w.currency, w.count, amount(w.valueMinor, w.currency), amount(w.avgValueMinor, w.currency)]),
      },
      { title: 'Notes', columns: ['Note'], rows: d.notes.map((n) => [n]) },
    ];
  }
  const d = output.data;
  return [
    { title: 'Summary', columns: ['Leads', 'Converted', 'Conversion rate'], rows: [[d.total, d.converted, pct(d.conversionRate)]] },
    { title: 'By status', columns: ['Status', 'Leads'], rows: d.byStatus.map((s) => [s.status, s.count]) },
    { title: 'By source', columns: ['Source', 'Leads'], rows: d.bySource.map((s) => [s.source, s.count]) },
  ];
}

const cell = (v: string | number | null) => (v == null ? '' : String(v));

// Every dynamic value goes through esc(); the text part strips line breaks so a cell cannot forge rows.
export function renderTables({ name, range, tables }: { name: string; range: { from: string; to: string }; tables: ReportTable[] }) {
  const html = [
    `<h2>${esc(name)}</h2>`,
    `<p>${esc(range.from)} to ${esc(range.to)} (UTC)</p>`,
    ...tables.map(
      (t) =>
        `<h3>${esc(t.title)}</h3><table cellpadding="4" cellspacing="0" border="1"><tr>${t.columns.map((c) => `<th align="left">${esc(c)}</th>`).join('')}</tr>${t.rows
          .map((r) => `<tr>${r.map((v) => `<td>${esc(cell(v))}</td>`).join('')}</tr>`)
          .join('')}</table>`,
    ),
  ].join('\n');
  const flat = (v: string) => v.replace(/[\r\n]+/g, ' ');
  const text = [
    flat(name),
    `${range.from} to ${range.to} (UTC)`,
    ...tables.flatMap((t) => ['', flat(t.title), t.columns.map(flat).join(' | '), ...t.rows.map((r) => r.map((v) => flat(cell(v))).join(' | '))]),
  ].join('\n');
  return { subject: `Report: ${name}`, html, text };
}
