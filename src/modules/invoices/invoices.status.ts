// Invoice status follows the money: nothing paid = unpaid, some = partial, all = paid. "void" is set by hand and never recomputed.
export function statusForPayment(totalMinor: number, paidMinor: number): 'unpaid' | 'partial' | 'paid' {
  if (paidMinor >= totalMinor) return 'paid'; // also covers a zero-value invoice
  return paidMinor > 0 ? 'partial' : 'unpaid';
}

if (process.argv[1]?.endsWith('invoices.status.ts')) {
  const eq = (actual: string, wanted: string) => {
    if (actual !== wanted) throw new Error(`expected ${wanted}, got ${actual}`);
  };
  eq(statusForPayment(1000, 0), 'unpaid');
  eq(statusForPayment(1000, 1), 'partial');
  eq(statusForPayment(1000, 999), 'partial');
  eq(statusForPayment(1000, 1000), 'paid');
  eq(statusForPayment(0, 0), 'paid');
  console.log('invoice status ok');
}
