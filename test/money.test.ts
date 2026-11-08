import { describe, expect, it } from 'vitest';
import { parseMoney } from '../src/shared/money';

describe('parseMoney', () => {
  it.each([
    ['12 500,50 Kč', 12500.5, 'CZK'],
    ['12.500,50 CZK', 12500.5, 'CZK'],
    ['€ 1,234.56', 1234.56, 'EUR'],
    ['1 234 EUR', 1234, 'EUR'],
    ['$99.90', 99.9, 'USD'],
    ['12 500,50 Kč', 12500.5, 'CZK'],
    ['1.234.567,89 Kč', 1234567.89, 'CZK'],
    ['0,125 EUR', 0.125, 'EUR'],
    ['1500', 1500, undefined],
  ])('%s', (text, value, currency) => {
    expect(parseMoney(text)).toEqual({ value, ...(currency && { currency }) });
  });

  it('bez čísla undefined', () => {
    expect(parseMoney('zdarma')).toBeUndefined();
  });
});
