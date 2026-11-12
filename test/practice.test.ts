import { describe, expect, it } from 'vitest';
import { addDays, dueCount, dueFirst, dueItems, grade, shuffleOptions, sourcesChanged } from '../src/shared/practice';
import type { PracticeCard, PracticeSet } from '../src/shared/types';

const card = (id: string, review?: PracticeCard['review']): PracticeCard => ({ id, front: id, back: id, source: 's1', review });
const set = (cards: PracticeCard[], sources = ['a', 'b']): PracticeSet => ({ scope: 'folder:f', sources, createdAt: 0, cards, questions: [] });

describe('addDays', () => {
  it('přes konec měsíce, roku a únor', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-30', 4)).toBe('2027-01-03');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-28', 8)).toBe('2026-04-05');
  });
});

describe('grade', () => {
  it('nová položka: umím = přihrádka 1 za 2 dny, neumím = přihrádka 0 na zítra', () => {
    expect(grade(undefined, true, '2026-11-30')).toEqual({ box: 1, due: '2026-12-02' });
    expect(grade(undefined, false, '2026-11-30')).toEqual({ box: 0, due: '2026-12-01' });
  });

  it('umím posouvá výš až do přihrádky 5 (32 dní), neumím vrací na začátek', () => {
    expect(grade({ box: 3, due: '2026-01-01' }, true, '2026-01-20')).toEqual({ box: 4, due: '2026-02-05' });
    expect(grade({ box: 5, due: '2026-01-01' }, true, '2026-01-31')).toEqual({ box: 5, due: '2026-03-04' });
    expect(grade({ box: 4, due: '2026-01-01' }, false, '2026-01-31')).toEqual({ box: 0, due: '2026-02-01' });
  });
});

describe('dueItems / dueCount', () => {
  const today = '2026-11-12';
  const s = set([card('new'), card('later', { box: 2, due: '2026-11-13' }), card('high', { box: 3, due: '2026-11-12' }), card('failed', { box: 0, due: '2026-11-10' })]);

  it('jen položky s termínem dnes a dřív, nižší přihrádky první', () => {
    expect(dueItems(s, today).map((c) => c.id)).toEqual(['new', 'failed', 'high']);
  });

  it('dueFirst funguje i pro otázky, dueCount sčítá sady', () => {
    expect(dueFirst([{ review: { box: 1, due: '2026-12-01' } }], today)).toEqual([]);
    expect(dueCount([s, set([card('x')])], today)).toBe(4);
    expect(dueCount([], today)).toBe(0);
  });
});

describe('sourcesChanged', () => {
  it('pozná přidaný, odebraný i vyměněný zdroj, pořadí nevadí', () => {
    const s = set([], ['a', 'b']);
    expect(sourcesChanged(s, ['b', 'a'])).toBe(false);
    expect(sourcesChanged(s, ['a', 'b', 'c'])).toBe(true);
    expect(sourcesChanged(s, ['a'])).toBe(true);
    expect(sourcesChanged(s, ['a', 'c'])).toBe(true);
  });
});

describe('shuffleOptions', () => {
  const options = ['správně', 'b', 'c', 'd'];

  it('stejné semínko = stejné pořadí, správná odpověď zůstane správná', () => {
    const a = shuffleOptions(options, 0, 'Co je Leitner?');
    expect(shuffleOptions(options, 0, 'Co je Leitner?')).toEqual(a);
    expect(a.options[a.answer]).toBe('správně');
    expect([...a.options].sort()).toEqual([...options].sort());
  });

  it('správná odpověď není vždy první', () => {
    const firsts = Array.from({ length: 20 }, (_, i) => shuffleOptions(options, 0, `otázka ${i}`).answer);
    expect(new Set(firsts).size).toBeGreaterThan(1);
  });
});
