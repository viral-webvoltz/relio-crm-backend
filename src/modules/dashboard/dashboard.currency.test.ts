import { describe, expect, it } from 'vitest';
import { amountIn, compareIn, currenciesOf, net, primaryCurrency } from './dashboard.currency.js';

const m = (currency: string, amount: number) => ({ currency, amount });

describe('primaryCurrency', () => {
  it('picks the largest summed currency across groups', () => {
    expect(primaryCurrency([m('USD', 100), m('EUR', 80)], [m('EUR', 50)])).toBe('EUR');
  });
  it('breaks ties alphabetically', () => {
    expect(primaryCurrency([m('USD', 100), m('EUR', 100)])).toBe('EUR');
  });
  it('falls back to USD with no data', () => {
    expect(primaryCurrency([])).toBe('USD');
  });
});

describe('grouping helpers', () => {
  it('sums per currency and compares windows', () => {
    expect(amountIn([m('USD', 1), m('USD', 2), m('EUR', 5)], 'USD')).toBe(3);
    expect(compareIn([m('EUR', 5)], [], 'EUR')).toEqual({ value: 5, previous: 0 });
    expect(compareIn([], [], 'GBP')).toEqual({ value: 0, previous: 0 });
  });
  it('lists currencies sorted and nets refunds', () => {
    expect(currenciesOf([m('USD', 1)], [m('EUR', 1), m('USD', 2)])).toEqual(['EUR', 'USD']);
    expect(amountIn(net([m('USD', 100)], [m('USD', 30)]), 'USD')).toBe(70);
  });
});
