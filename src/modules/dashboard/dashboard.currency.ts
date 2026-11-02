// No FX: every money figure is kept per currency. The flat fields use the "primary" currency.
export type Money = { currency: string; amount: number };

const FALLBACK_CURRENCY = 'USD'; // only when there is no money data at all

export function totalsByCurrency(rows: Money[]) {
  const totals = new Map<string, number>();
  for (const { currency, amount } of rows) totals.set(currency, (totals.get(currency) ?? 0) + amount);
  return totals;
}

// The currency with the largest summed amount across the given groups; ties go to the alphabetically first.
export function primaryCurrency(...groups: Money[][]) {
  let best: { currency: string; amount: number } | null = null;
  for (const [currency, amount] of totalsByCurrency(groups.flat())) {
    if (!best || amount > best.amount || (amount === best.amount && currency < best.currency)) best = { currency, amount };
  }
  return best?.currency ?? FALLBACK_CURRENCY;
}

export const currenciesOf = (...groups: Money[][]) => [...new Set(groups.flat().map((m) => m.currency))].sort();

export const amountIn = (rows: Money[], currency: string) => totalsByCurrency(rows).get(currency) ?? 0;

export const compareIn = (now: Money[], before: Money[], currency: string) => ({ value: amountIn(now, currency), previous: amountIn(before, currency) });

// paid minus refunded, per currency
export const net = (paid: Money[], refunded: Money[]): Money[] => [...paid, ...refunded.map((m) => ({ ...m, amount: -m.amount }))];
