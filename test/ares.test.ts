import { describe, expect, it } from 'vitest';
import { aresTarget, compareAres, normalizeIco, parseAres } from '../src/shared/ares';
import type { AresRecord } from '../src/shared/types';

const record: AresRecord = { ico: '12345678', name: 'Dřevo Šumava s.r.o.', address: 'Zlatá stezka 1, 383 01 Prachatice', city: 'Prachatice', zip: '38301' };

describe('normalizeIco', () => {
  it('doplní nuly a odmítne cizí identifikátory', () => {
    expect(normalizeIco('123 456 78')).toBe('12345678');
    expect(normalizeIco('45274')).toBe('00045274');
    expect(normalizeIco('CZ12345678')).toBeUndefined();
    expect(normalizeIco('')).toBeUndefined();
    expect(normalizeIco(undefined)).toBeUndefined();
  });
});

describe('aresTarget', () => {
  const facts = { supplier: 'Pila s.r.o.', supplierId: '12345678', customer: 'Dílna Novák s.r.o.', customerId: '87654321' };
  it('dodavatel, u vydané faktury odběratel', () => {
    expect(aresTarget(facts)).toEqual({ ico: '12345678', name: 'Pila s.r.o.' });
    expect(aresTarget(facts, { name: '', id: '12345678', vat: '' })).toEqual({ ico: '87654321', name: 'Dílna Novák s.r.o.' });
    expect(aresTarget({ supplier: 'X' })).toBeUndefined();
  });
});

describe('parseAres', () => {
  it('přečte jméno, sídlo a DIČ', () => {
    const json = { ico: '12345678', obchodniJmeno: 'Dřevo Šumava s.r.o.', dic: 'CZ12345678', sidlo: { textovaAdresa: 'Zlatá stezka 1, Prachatice', nazevObce: 'Prachatice', psc: 38301 } };
    expect(parseAres(json)).toEqual({ ico: '12345678', name: 'Dřevo Šumava s.r.o.', address: 'Zlatá stezka 1, Prachatice', city: 'Prachatice', zip: '38301', vat: 'CZ12345678' });
    expect(parseAres({ kod: 'NENALEZENO' })).toBeUndefined();
    expect(parseAres(null)).toBeUndefined();
  });
});

describe('compareAres', () => {
  it('souhlasí název bez právní formy i sídlo v textu', () => {
    expect(compareAres(record, 'DŘEVO ŠUMAVA, spol. s r.o.', 'Sídlo: Zlatá stezka 1, 383 01 Prachatice')).toEqual({ kind: 'ok' });
    expect(compareAres(record, 'Dřevo Šumava', 'PSČ 383 01')).toEqual({ kind: 'ok' });
  });

  it('jiné sídlo, jiný název, IČO není', () => {
    expect(compareAres(record, 'Dřevo Šumava s.r.o.', 'Sídlo: Vimperk')).toEqual({ kind: 'address', city: 'Prachatice' });
    expect(compareAres(record, 'Jiná firma a.s.', 'Prachatice')).toEqual({ kind: 'name', name: 'Dřevo Šumava s.r.o.' });
    expect(compareAres(null, 'X', 'text')).toEqual({ kind: 'missing' });
  });

  it('bez textu dokumentu se sídlo neposuzuje', () => {
    expect(compareAres(record, 'Dřevo Šumava', '')).toEqual({ kind: 'ok' });
  });
});
