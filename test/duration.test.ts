import { describe, expect, it } from 'vitest';
import { addDuration, findDurations, parseDuration } from '../src/shared/duration';

describe('parseDuration', () => {
  it.each([
    ['3 měsíce', { months: 3 }],
    ['90 dní', { days: 90 }],
    ['lhůta 6 týdnů', { days: 42 }],
    ['1 rok', { months: 12 }],
    ['5 let', { months: 60 }],
    ['tři měsíce', { months: 3 }],
    ['90 days written notice', { days: 90 }],
    ['three months', { months: 3 }],
    ['12-month periods', { months: 12 }],
    ['6 Wochen', { days: 42 }],
    ['2 Jahre', { months: 24 }],
  ])('%s', (text, expected) => expect(parseDuration(text)).toEqual(expected));

  it('bez údaje undefined, slova uvnitř jiných slov se nepočítají', () => {
    expect(parseDuration('bez lhůty')).toBeUndefined();
    expect(parseDuration('18 500 Kč měsíčně')).toBeUndefined();
    expect(parseDuration('rokem 2026')).toBeUndefined();
  });

  it('najde všechny údaje v pořadí', () => {
    expect(findDurations('o 1 rok, pokud není oznámeno 3 měsíce před koncem').map((d) => d.text)).toEqual(['1 rok', '3 měsíce']);
  });
});

describe('addDuration', () => {
  it('měsíce kalendářně, konec měsíce se ořízne', () => {
    expect(addDuration('2026-01-31', { months: 1 })).toBe('2026-02-28');
    expect(addDuration('2028-01-31', { months: 1 })).toBe('2028-02-29');
    expect(addDuration('2027-12-31', { months: 3 }, -1)).toBe('2027-09-30');
  });

  it('dny přes přelom roku i zpět', () => {
    expect(addDuration('2026-12-20', { days: 15 })).toBe('2027-01-04');
    expect(addDuration('2028-03-31', { days: 90 }, -1)).toBe('2028-01-01');
  });
});
