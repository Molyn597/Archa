import { describe, expect, it } from 'vitest';
import { exportTable, filterInvoices, invoiceRows, invoiceSums, periodRange, sortInvoices, toCsv } from '../src/shared/invoices';
import type { DocFacts, DocumentCard, Job } from '../src/shared/types';

const job = (id: string, name = id) => ({ id, name, ext: '.pdf' }) as Job;
const card = (facts: DocFacts, type: DocumentCard['type'] = 'invoice', factsFrom?: 'isdoc') => ({ type, facts, factsFrom }) as DocumentCard;
const TODAY = '2026-11-08';

const jobs = [job('a'), job('b'), job('c'), job('d'), job('e')];
const cards = {
  a: card({ supplier: 'Příliš žluťoučký s.r.o.', customer: 'Acme', number: '2026001', subject: 'Nájem', amount: '12 500,50 Kč', net: '10 331,40 Kč', vat: '2 169,10 Kč', issued: '2026-10-01', due: '2026-10-15' }, 'invoice', 'isdoc'),
  b: card({ supplier: 'Foo', customer: 'Bar', number: '77', amount: '100 EUR', issued: '2026-11-02', due: '2026-11-20' }),
  c: card({ supplier: 'Foo', amount: '200 EUR', issued: '2025-12-30' }),
  d: card({ supplier: 'Smlouva' }, 'contract'),
  e: card({ supplier: 'Bez částky', issued: '2026-11-05', due: '2026-11-08' }),
};
const paid = { c: 123 };
const rows = () => invoiceRows(jobs, cards, paid, TODAY);

describe('invoiceRows', () => {
  it('bere jen faktury a stav podle data', () => {
    const r = rows();
    expect(r.map((x) => x.jobId)).toEqual(['a', 'b', 'c', 'e']);
    expect(r.map((x) => x.status)).toEqual(['overdue', 'open', 'paid', 'open']);
    expect(r[0]).toMatchObject({ total: 12500.5, net: 10331.4, vat: 2169.1, currency: 'CZK', title: '2026001', isdoc: true });
    expect(r[3]).toMatchObject({ total: undefined, currency: '', title: 'e.pdf' });
  });

  it('bez splatnosti je unknown', () => {
    expect(invoiceRows([job('x')], { x: card({ amount: '1 Kč' }) }, undefined, TODAY)[0].status).toBe('unknown');
  });
});

describe('filterInvoices', () => {
  it('hledá bez diakritiky a velikosti písmen', () => {
    expect(filterInvoices(rows(), { query: 'PRILIS zlutoucky' }).map((r) => r.jobId)).toEqual(['a']);
    expect(filterInvoices(rows(), { query: 'najem' }).map((r) => r.jobId)).toEqual(['a']);
    expect(filterInvoices(rows(), { query: '77' }).map((r) => r.jobId)).toEqual(['b']);
  });

  it('období a stav', () => {
    expect(filterInvoices(rows(), { from: '2026-11-01', to: '2026-11-30' }).map((r) => r.jobId)).toEqual(['b', 'e']);
    expect(filterInvoices(rows(), { status: 'overdue' }).map((r) => r.jobId)).toEqual(['a']);
    expect(filterInvoices(rows(), { status: 'paid' }).map((r) => r.jobId)).toEqual(['c']);
  });

  it('rychlá období', () => {
    expect(periodRange('thisMonth', TODAY)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(periodRange('lastMonth', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(periodRange('lastYear', TODAY)).toEqual({ from: '2025-01-01', to: '2025-12-31' });
    expect(periodRange('all', TODAY)).toEqual({});
  });
});

describe('invoiceSums', () => {
  it('sčítá zvlášť po měnách', () => {
    expect(invoiceSums(rows())).toEqual([
      { currency: 'CZK', total: 12500.5, net: 10331.4, vat: 2169.1 },
      { currency: 'EUR', total: 300, net: 0, vat: 0 },
    ]);
  });
});

describe('sortInvoices', () => {
  it('řadí a prázdné dává na konec', () => {
    expect(sortInvoices(rows(), 'total', 'desc').map((r) => r.jobId)).toEqual(['a', 'c', 'b', 'e']);
    expect(sortInvoices(rows(), 'total', 'asc').map((r) => r.jobId)).toEqual(['b', 'c', 'a', 'e']);
    expect(sortInvoices(rows(), 'due', 'asc').map((r) => r.jobId)).toEqual(['a', 'e', 'b', 'c']);
  });
});

describe('export', () => {
  it('tabulka má typované buňky', () => {
    const t = exportTable(rows().slice(0, 1), (k) => k, (s) => s);
    expect(t.headers).toHaveLength(18);
    expect(t.rows[0]).toContain(12500.5);
    expect(t.rows[0]).toContainEqual({ date: '2026-10-01' });
  });

  it('CSV: BOM, středník, desetinná čárka, uvozovky', () => {
    const csv = toCsv(['A', 'B', 'C', 'D'], [['a;b', 'říká "ahoj"', 1234.5, { date: '2026-11-02' }], ['=SUM(A1)', null, 2, 'řádek\nzlom']]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toBe('﻿A;B;C;D\r\n"a;b";"říká ""ahoj""";1234,5;2.11.2026\r\n\'=SUM(A1);;2;"řádek\nzlom"\r\n');
  });
});
