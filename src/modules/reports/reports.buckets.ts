export type MonthlyField = 'invoicedMinor' | 'collectedMinor' | 'orderCount' | 'orderTotalMinor';
export type MonthlyRow = { month: string; currency: string | null } & Record<MonthlyField, number>;
export type MonthlyEntry = { month: string; currency: string; field: MonthlyField; value: number };

// 'YYYY-MM' for every UTC month touched by [start, end).
export function monthKeys(start: Date, end: Date) {
  const keys: string[] = [];
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  const lastMs = end.getTime() - 1;
  while (Date.UTC(y, m, 1) <= lastMs) {
    keys.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    m += 1;
    if (m === 12) {
      m = 0;
      y += 1;
    }
  }
  return keys;
}

// Sums grouped SQL rows into one row per (month, currency) and zero-fills every month so charts are continuous.
// Currencies come from the data; with none at all, each month gets a single zero row with a null currency.
// Entries outside `months` are ignored; entries for the same cell are added (collected = payments + negative refunds).
export function fillMonthly(months: string[], entries: MonthlyEntry[]): MonthlyRow[] {
  const inRange = new Set(months);
  const currencies = [...new Set(entries.filter((e) => inRange.has(e.month)).map((e) => e.currency))].sort();
  const cells = new Map<string, MonthlyRow>();
  const blank = (month: string, currency: string | null): MonthlyRow => ({
    month,
    currency,
    invoicedMinor: 0,
    collectedMinor: 0,
    orderCount: 0,
    orderTotalMinor: 0,
  });
  for (const month of months) for (const currency of currencies.length ? currencies : [null]) cells.set(`${month}|${currency}`, blank(month, currency));
  for (const e of entries) {
    const cell = cells.get(`${e.month}|${e.currency}`);
    if (cell) cell[e.field] += e.value;
  }
  return [...cells.values()];
}
