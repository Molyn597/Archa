import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPackage } from '../src/main/accountant';
import { checkInvoices, defaultPeriod, packageBase, packageEntries, periodFileName, periodOptions, selectInvoices, uniqueBases, type PackageInvoice } from '../src/shared/accountant';
import { flowRows } from '../src/shared/finance';
import { invoiceRows } from '../src/shared/invoices';
import type { DocFacts, DocumentCard, Job } from '../src/shared/types';

const TODAY = '2026-11-08';
const OWN = { name: 'Moje s.r.o.', id: '', vat: '' };
const job = (id: string, name = id, ext = '.pdf') => ({ id, name, ext, createdAt: Date.UTC(2026, 9, 20) }) as Job;
const card = (facts: DocFacts, factsFrom?: 'isdoc') => ({ type: 'invoice', facts, factsFrom, biblio: { authors: [] } }) as unknown as DocumentCard;

const jobs = [job('a'), job('b'), job('c', 'sken', '.jpg'), job('d')];
const cards = {
  a: card({ supplier: 'Foo', supplierId: '1', number: '1', amount: '121 Kč', net: '100 Kč', vat: '21 Kč', issued: '2026-10-03' }, 'isdoc'),
  b: card({ supplier: 'Moje s.r.o.', supplierId: '2', number: '2', amount: '200 Kč', net: '100 Kč', vat: '21 Kč', issued: '2026-10-15' }),
  c: card({ supplier: 'Bar', amount: '50 Kč', issued: '2026-09-30' }),
  d: card({ supplier: 'Foo', supplierId: '1', number: '1', amount: '10 Kč', issued: '2025-06-01' }),
};
const rows = (): PackageInvoice[] => flowRows(invoiceRows(jobs, cards, undefined, TODAY), OWN).map((r) => ({ ...r, date: r.issued }));

describe('období', () => {
  it('měsíce jen s fakturami, 4 čtvrtletí, dva roky', () => {
    const o = periodOptions(rows(), TODAY);
    expect(o.map((x) => x.key)).toEqual(['m:2026-10', 'm:2026-09', 'q:2026-4', 'q:2026-3', 'q:2026-2', 'q:2026-1', 'y:2026', 'y:2025']);
    expect(periodOptions([], '2026-02-10').map((x) => x.key)).toEqual(['q:2026-1', 'q:2025-4', 'q:2025-3', 'q:2025-2', 'y:2026', 'y:2025']);
  });

  it('výchozí je minulý měsíc, jinak tento, jinak první', () => {
    expect(defaultPeriod(periodOptions(rows(), TODAY), TODAY)).toBe('m:2026-10');
    const noSept = rows().filter((r) => r.jobId !== 'c');
    expect(defaultPeriod(periodOptions(noSept, '2026-10-20'), '2026-10-20')).toBe('m:2026-10');
    expect(defaultPeriod(periodOptions(rows(), '2028-05-01'), '2028-05-01')).toBe('q:2028-2');
  });

  it('výběr podle období a směru, od nejstarší', () => {
    const r = rows();
    const o = periodOptions(r, TODAY);
    expect(selectInvoices(r, o, 'q:2026-4', 'all').map((x) => x.jobId)).toEqual(['a', 'b']);
    expect(selectInvoices(r, o, 'm:2026-10', 'issued').map((x) => x.jobId)).toEqual(['b']);
    expect(selectInvoices(r, o, 'm:2026-10', 'received').map((x) => x.jobId)).toEqual(['a']);
    expect(selectInvoices(r, o, 'y:2026', 'all').map((x) => x.jobId)).toEqual(['c', 'a', 'b']);
    expect(selectInvoices(r, o, 'nic', 'all')).toEqual([]);
  });

  it('datum dokumentu nahradí chybějící datum vystavení', () => {
    const r = [{ ...rows()[0], issued: '', date: '2026-10-20' }];
    expect(selectInvoices(r, periodOptions(r, TODAY), 'm:2026-10', 'all')).toHaveLength(1);
  });

  it('název souboru z období', () => {
    expect(periodOptions([], TODAY).filter((o) => o.key !== 'q:2026-3').map(periodFileName)).toEqual(['2026-Q4', '2026-Q2', '2026-Q1', '2026', '2025']);
  });
});

describe('kontrola', () => {
  it('součet s tolerancí, chybějící údaje a ISDOC', () => {
    const c = checkInvoices(rows());
    expect(c).toMatchObject({ count: 4, isdoc: 1, sumMismatch: 1 });
    expect(c.issues.map((i) => [i.jobId, i.problems])).toEqual([['b', ['sum']], ['c', ['number', 'supplierId']]]);
  });

  it('odchylka 0,01 projde, 0,02 ne', () => {
    const one = (amount: string) => checkInvoices(flowRows(invoiceRows([job('x')], { x: card({ number: '1', supplierId: '1', issued: '2026-10-01', amount, net: '100 Kč', vat: '21 Kč' }) }, undefined, TODAY)).map((r) => ({ ...r, date: r.issued }))).sumMismatch;
    expect([one('121,01 Kč'), one('121,02 Kč')]).toEqual([0, 1]);
  });
});

describe('názvy a obsah ZIPu', () => {
  it('základ názvu a deduplikace bez ohledu na velikost písmen', () => {
    expect(packageBase('', 'sken')).toBe('sken');
    expect(packageBase('', '///')).toBe('faktura');
    expect(uniqueBases([{ id: '1', base: 'A' }, { id: '2', base: 'a' }, { id: '3', base: 'A' }, { id: '4', base: 'B' }])).toEqual(new Map([['1', 'A'], ['2', 'a (2)'], ['3', 'A (3)'], ['4', 'B']]));
  });

  it('seznam souborů podle výběru', () => {
    const items = [
      { jobId: 'a', base: 'F1', ext: '.pdf', isdoc: true },
      { jobId: 'c', base: 'F2', ext: '.jpg', isdoc: false },
    ];
    const paths = (inc: Partial<Record<'pdf' | 'isdoc' | 'xlsx' | 'csv', boolean>>) => packageEntries(items, { pdf: false, isdoc: false, xlsx: false, csv: false, ...inc }).map((e) => e.path);
    expect(paths({ pdf: true, isdoc: true, xlsx: true, csv: true })).toEqual(['PDF/F1.pdf', 'PDF/F2.jpg', 'ISDOC/F1.isdoc', 'Prehled.xlsx', 'Prehled.csv']);
    expect(paths({ csv: true })).toEqual(['Prehled.csv']);
  });
});

describe('buildPackage', () => {
  let dir: string;
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('sestaví ZIP z originálů, ISDOC a přehledů', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pkg-'));
    for (const j of jobs) await writeFile(path.join(dir, j.id), `data-${j.id}`);
    const { zip, files } = await buildPackage({
      jobs,
      cards,
      paid: undefined,
      include: { pdf: true, isdoc: true, xlsx: true, csv: true },
      template: '{datum} {dodavatel} {cislo}',
      today: TODAY,
      readInput: async (j) => readFile(path.join(dir, j.id)),
      readIsdoc: async (j) => (j.id === 'a' ? '<Invoice/>' : undefined),
    });
    expect(files.sort()).toEqual(['ISDOC/2026-10-03 Foo 1.isdoc', 'PDF/2025-06-01 Foo 1.pdf', 'PDF/2026-09-30 Bar.jpg', 'PDF/2026-10-03 Foo 1.pdf', 'PDF/2026-10-15 Moje s.r.o. 2.pdf', 'Prehled.csv', 'Prehled.xlsx']);
    const out = unzipSync(zip);
    expect(strFromU8(out['PDF/2026-10-03 Foo 1.pdf'])).toBe('data-a');
    expect(strFromU8(out['ISDOC/2026-10-03 Foo 1.isdoc'])).toBe('<Invoice/>');
    expect(strFromU8(out['Prehled.csv'])).toContain('15.10.2026');
  });
});
