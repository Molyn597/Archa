import { describe, expect, it } from 'vitest';
import { filterChips, matchesFilter, type FilterDoc } from '../src/shared/doc-filter';

const d = (type?: FilterDoc['type'], gap = false): FilterDoc => ({ type, gap });

describe('matchesFilter', () => {
  it('vše, literatura, chybí údaje a typ', () => {
    expect(matchesFilter('all', d())).toBe(true);
    expect(matchesFilter('literature', d('book'))).toBe(true);
    expect(matchesFilter('literature', d('invoice'))).toBe(false);
    expect(matchesFilter('missing', d('article', true))).toBe(true);
    expect(matchesFilter('missing', d('article'))).toBe(false);
    expect(matchesFilter('type:invoice', d('invoice'))).toBe(true);
    expect(matchesFilter('type:invoice', d('contract'))).toBe(false);
  });
});

describe('filterChips', () => {
  it('jeden typ nebo prázdný seznam nemá čipy', () => {
    expect(filterChips([])).toEqual([]);
    expect(filterChips([d('invoice'), d('invoice')])).toEqual([]);
  });

  it('dva typy dají čip za každý', () => {
    expect(filterChips([d('invoice'), d('contract'), d('invoice')])).toEqual([
      { filter: 'type:invoice', count: 2 },
      { filter: 'type:contract', count: 1 },
    ]);
  });

  it('literární typy se slijí do jednoho čipu', () => {
    expect(filterChips([d('article'), d('book'), d('invoice')])).toEqual([
      { filter: 'literature', count: 2 },
      { filter: 'type:invoice', count: 1 },
    ]);
  });

  it('chybějící údaje jsou čip i u samých zdrojů, literární čip by ukázal všechno', () => {
    expect(filterChips([d('article', true), d('book')])).toEqual([{ filter: 'missing', count: 1 }]);
  });
});
