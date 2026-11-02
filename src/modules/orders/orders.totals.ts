export type Discount = { type: 'percent'; value: number } | { type: 'fixed'; value: number };

export type OrderTotals = { subtotalMinor: number; discountMinor: number; taxMinor: number; totalMinor: number };

// Everything is integer minor units. Percentages are basis points (1% = 100), so there is no float drift;
// each percentage amount is rounded once, half-up. Tax applies after the discount.
export function calculateTotals(lines: { unitPriceMinor: number; quantity: number }[], discount: Discount | null | undefined, taxRateBps: number): OrderTotals {
  const subtotalMinor = lines.reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0);

  let discountMinor = 0;
  if (discount?.type === 'percent') discountMinor = Math.round((subtotalMinor * discount.value) / 10_000);
  if (discount?.type === 'fixed') discountMinor = discount.value;
  if (discountMinor > subtotalMinor) throw new RangeError('Discount is larger than the subtotal');

  const taxable = subtotalMinor - discountMinor;
  const taxMinor = Math.round((taxable * taxRateBps) / 10_000);
  return { subtotalMinor, discountMinor, taxMinor, totalMinor: taxable + taxMinor };
}

if (process.argv[1]?.endsWith('orders.totals.ts')) {
  const eq = (actual: unknown, wanted: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
  };
  const lines = [
    { unitPriceMinor: 1999, quantity: 3 },
    { unitPriceMinor: 500, quantity: 1 },
  ]; // 6497
  eq(calculateTotals(lines, null, 0), { subtotalMinor: 6497, discountMinor: 0, taxMinor: 0, totalMinor: 6497 });
  eq(calculateTotals(lines, { type: 'percent', value: 1000 }, 0), { subtotalMinor: 6497, discountMinor: 650, taxMinor: 0, totalMinor: 5847 }); // 649.7 -> 650
  eq(calculateTotals(lines, { type: 'fixed', value: 497 }, 1800), { subtotalMinor: 6497, discountMinor: 497, taxMinor: 1080, totalMinor: 7080 }); // 6000 * 18%
  eq(calculateTotals([{ unitPriceMinor: 1, quantity: 1 }], null, 5000), { subtotalMinor: 1, discountMinor: 0, taxMinor: 1, totalMinor: 2 }); // 0.5 rounds up
  eq(calculateTotals(lines, { type: 'percent', value: 10_000 }, 1800), { subtotalMinor: 6497, discountMinor: 6497, taxMinor: 0, totalMinor: 0 });
  let rejected = false;
  try {
    calculateTotals(lines, { type: 'fixed', value: 6498 }, 0);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('oversized discount should be rejected');
  console.log('totals ok');
}
