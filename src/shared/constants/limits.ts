// Largest money amount (minor units) accepted anywhere. An order line is price x quantity (<= 100,000), which must stay
// below Number.MAX_SAFE_INTEGER (2^53) and the bigint column, so totals never lose precision.
export const MAX_MONEY_MINOR = 10_000_000_000_000; // 1e13 -> 1e18 worst-case line total
