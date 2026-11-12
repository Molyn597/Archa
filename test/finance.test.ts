import { describe, expect, it } from 'vitest';
import { flowRows, hasOwnCompany, monthRange, monthTotals, ownParty, periodSums, primaryCurrency, timelineItems, topSuppliers } from '../src/shared/finance';
import type { InvoiceRow } from '../src/shared/invoices';
import type { DocumentCard, Job } from '../src/shared/types';

const inv = (id: string, supplier: string, customer: string, total: number, issued: string, currency = 'CZK'): InvoiceRow =>
  ({ jobId: id, title: id, file: id, supplier, supplierId: '', supplierVat: '', customer, customerId: '', customerVat: '', number: id, vs: '', subject: '', issued, due: '', total, currency, status: 'open', isdoc: false }) as InvoiceRow;

const rows = [
  inv('a', 'Pila Servis', 'Dílna s.r.o.', 1000, '2026-10-05'),
  inv('b', 'Pila Servis', 'Dílna s.r.o.', 500, '2026-11-02'),
  inv('c', 'Dílna s.r.o.', 'Nábytek Novák', 3000, '2026-11-10'),
  inv('d', 'Desky a.s.', 'Dílna s.r.o.', 200, '2026-11-12', 'EUR'),
];

describe('ownParty a směr faktur', () => {
  it('vlastní firma je nejčastější strana', () => {
    expect(ownParty(rows)).toBe('dilna s.r.o.');
  });

  it('vydané jsou příjem, přijaté výdaj', () => {
    expect(flowRows(rows).map((r) => r.flow)).toEqual(['expense', 'expense', 'income', 'expense']);
  });

  it('bez opakování se vlastní firma nepozná a vše je výdaj', () => {
    expect(ownParty([inv('x', 'A', 'B', 1, '2026-11-01')])).toBe('');
    expect(flowRows([inv('x', 'A', 'B', 1, '2026-11-01')])[0]!.flow).toBe('expense');
  });
});

describe('Moje firma', () => {
  const flows = (own: Parameters<typeof flowRows>[1], list: InvoiceRow[]) => flowRows(list, own).map((r) => r.flow);
  const row = (supplier: string, supplierId = '', supplierVat = '') => ({ ...inv('x', supplier, 'Zákazník', 1, '2026-11-01'), supplierId, supplierVat });

  it('shoda podle IČO i s mezerami a DIČ bez ohledu na velikost', () => {
    expect(flows({ name: '', id: '123 45 678', vat: '' }, [row('Cokoli', '12345678')])).toEqual(['income']);
    expect(flows({ name: '', id: '', vat: 'cz-1234' }, [row('Cokoli', '', 'CZ1234')])).toEqual(['income']);
    expect(flows({ name: '', id: '1', vat: '' }, [row('Cokoli', '2')])).toEqual(['expense']);
  });

  it('shoda názvu bez právní formy a diakritiky', () => {
    const own = { name: 'Dílna, spol. s r.o.', id: '', vat: '' };
    expect(flows(own, [row('DILNA s.r.o.'), row('Dílna a.s.'), row('Desky')])).toEqual(['income', 'income', 'expense']);
  });

  it('vyplněná firma má přednost před odhadem, prázdná odhad nechá', () => {
    expect(flows({ name: 'Nábytek Novák', id: '', vat: '' }, rows)).toEqual(['expense', 'expense', 'expense', 'expense']);
    expect(flows({ name: ' ', id: '', vat: '' }, rows)).toEqual(['expense', 'expense', 'income', 'expense']);
    expect(hasOwnCompany({ name: ' ', id: '-', vat: '' })).toBe(false);
  });
});

describe('měsíce a součty', () => {
  it('monthRange přes přelom roku', () => {
    expect(monthRange('2026-02-10', 3)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthRange('2026-11-10', 1, 2)).toEqual(['2026-10', '2026-11', '2026-12', '2027-01']);
  });

  it('primaryCurrency a součty po měsících jen v jedné měně', () => {
    const fr = flowRows(rows);
    expect(primaryCurrency(fr)).toBe('CZK');
    expect(monthTotals(fr, ['2026-10', '2026-11'], 'CZK')).toEqual([
      { month: '2026-10', income: 0, expense: 1000 },
      { month: '2026-11', income: 3000, expense: 500 },
    ]);
  });

  it('periodSums nesčítá různé měny a umí filtr měsíce', () => {
    const fr = flowRows(rows);
    expect(periodSums(fr)).toEqual([
      { currency: 'CZK', income: 3000, expense: 1500 },
      { currency: 'EUR', income: 0, expense: 200 },
    ]);
    expect(periodSums(fr, '2026-10')).toEqual([{ currency: 'CZK', income: 0, expense: 1000 }]);
  });

  it('topSuppliers slučuje stejné dodavatele', () => {
    expect(topSuppliers(flowRows(rows), 'CZK')).toEqual([{ name: 'Pila Servis', total: 1500 }]);
  });
});

describe('timelineItems', () => {
  it('faktury a smlouvy v rozsahu měsíců', () => {
    const jobs = [{ id: 'k', name: 'najem', ext: '.pdf' }] as Job[];
    const cards = { k: { type: 'contract', facts: { subject: 'Nájem', validFrom: '2026-06-01', validTo: '2027-06-30' } } as DocumentCard };
    const items = timelineItems(flowRows(rows), jobs, cards, monthRange('2026-11-12', 5, 1), 'CZK');
    expect(items.map((i) => [i.jobId, i.lane, i.date])).toEqual([
      ['k', 'contract', '2026-06-01'],
      ['a', 'expense', '2026-10-05'],
      ['b', 'expense', '2026-11-02'],
      ['c', 'income', '2026-11-10'],
    ]);
  });
});
