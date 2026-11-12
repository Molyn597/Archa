import { describe, expect, it } from 'vitest';
import { counterparties, meanVector, setLink, suggestRelated } from '../src/shared/related';
import type { DocumentCard, Library } from '../src/shared/types';

const card = (facts: DocumentCard['facts']) => ({ facts }) as DocumentCard;
const vec = (...n: number[]) => meanVector([Float32Array.from(n)])!;
const doc = (id: string, vector?: Float32Array, parties: string[] = []) => ({ id, vector, parties: new Map(parties.map((p) => [p.toLowerCase(), p])) });

describe('meanVector', () => {
  it('průměr je normalizovaný', () => {
    const v = meanVector([Float32Array.from([1, 0]), Float32Array.from([0, 1])])!;
    expect(v[0]).toBeCloseTo(Math.SQRT1_2);
    expect(Math.hypot(...v)).toBeCloseTo(1);
    expect(meanVector([])).toBeUndefined();
  });
});

describe('counterparties', () => {
  const own = { name: 'Dílna Novák s.r.o.', id: '', vat: '' };
  it('vynechá moji firmu a právní formu', () => {
    const c = counterparties(card({ supplier: 'Pila Servis s.r.o.', customer: 'Dílna Novák s. r. o.' }), own);
    expect([...c.values()]).toEqual(['Pila Servis s.r.o.']);
    expect([...c.keys()]).toEqual(['pila servis']);
  });

  it('bez vyplněné firmy se odběratel nebere', () => {
    const c = counterparties(card({ supplier: 'Pila Servis s.r.o.', customer: 'Já', parties: ['Pronajímatel a.s.'] }));
    expect([...c.values()]).toEqual(['Pila Servis s.r.o.', 'Pronajímatel a.s.']);
  });
});

describe('suggestRelated', () => {
  const self = doc('a', vec(1, 0), ['Pila']);
  it('stejná protistrana před podobností, pod prahem nic', () => {
    const out = suggestRelated(self, [doc('b', vec(1, 0.1)), doc('c', vec(0, 1), ['Pila']), doc('d', vec(0, 1))], new Set());
    expect(out.map((o) => o.id)).toEqual(['c', 'b']);
    expect(out[0].reason).toEqual({ kind: 'party', party: 'Pila' });
    expect(out[1].reason).toEqual({ kind: 'similar' });
  });

  it('přeskočí sebe, potvrzené a odmítnuté; nejvýš 5', () => {
    const many = Array.from({ length: 8 }, (_, i) => doc(`x${i}`, vec(1, 0)));
    expect(suggestRelated(self, [doc('a', vec(1, 0)), ...many], new Set(['x0'])).map((o) => o.id)).toEqual(['x1', 'x2', 'x3', 'x4', 'x5']);
  });

  it('bez indexu jen podle protistrany', () => {
    const out = suggestRelated(doc('a', undefined, ['Pila']), [doc('b', vec(1, 0)), doc('c', undefined, ['Pila'])], new Set());
    expect(out.map((o) => o.id)).toEqual(['c']);
  });
});

describe('setLink', () => {
  const lib = () => ({ folders: [], assign: {} }) as Library;
  it('potvrzení je obousměrné a ruší odmítnutí', () => {
    const l = lib();
    setLink(l, 'a', 'b', false);
    expect(l.rejectedLinks).toEqual({ a: ['b'], b: ['a'] });
    setLink(l, 'a', 'b', true);
    expect(l.links).toEqual({ a: ['b'], b: ['a'] });
    expect(l.rejectedLinks).toBeUndefined();
  });

  it('odmítnutí zruší vazbu a prázdné klíče zmizí', () => {
    const l = lib();
    setLink(l, 'a', 'b', true);
    setLink(l, 'a', 'b', true);
    expect(l.links).toEqual({ a: ['b'], b: ['a'] });
    setLink(l, 'b', 'a', false);
    expect(l.links).toBeUndefined();
    expect(l.rejectedLinks).toEqual({ b: ['a'], a: ['b'] });
  });
});
