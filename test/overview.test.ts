import { describe, expect, it } from 'vitest';
import type { InvoiceRow } from '../src/shared/invoices';
import { dueTone, invoiceStats, latestProjects, newestJobs, relativeDue, toSort } from '../src/shared/overview';

const folders = [
  { id: 'invoices', createdAt: 0 },
  { id: 'other', createdAt: 0 },
];

describe('toSort', () => {
  it('počítá nezařazené, Ostatní a dotazy AI bez dvojího započtení', () => {
    const library = {
      folders,
      assign: { a: { folder: 'invoices' }, b: { folder: 'other' }, c: { folder: 'smazana' } },
      questions: [
        { jobId: 'c', options: [], at: 0 },
        { jobId: 'zamcena', options: [], at: 0 },
        { jobId: 'a', options: [], at: 0 },
      ],
    };
    const r = toSort(['a', 'b', 'c', 'd'], library);
    expect(r.unsorted).toEqual(['c', 'd']);
    expect(r.other).toEqual(['b']);
    expect(r.questions).toEqual(['c', 'a']);
    expect(r.total).toBe(4);
  });

  it('prázdná knihovna = 0', () => {
    expect(toSort([], { folders: [], assign: {} }).total).toBe(0);
  });
});

describe('newestJobs', () => {
  const job = (id: string, status: string, createdAt: number) => ({ id, status, createdAt });

  it('běžící první, pak čekající, pak nejnovější hotové', () => {
    const jobs = [job('a', 'done', 5), job('b', 'queued', 2), job('c', 'running', 1), job('d', 'done', 9), job('e', 'error', 7)];
    expect(newestJobs(jobs).map((j) => j.id)).toEqual(['c', 'b', 'd', 'e', 'a']);
  });

  it('omezí počet', () => {
    const jobs = [1, 2, 3, 4, 5, 6].map((n) => job(String(n), 'done', n));
    expect(newestJobs(jobs).map((j) => j.id)).toEqual(['6', '5', '4', '3', '2']);
    expect(newestJobs(jobs, 2)).toHaveLength(2);
  });
});

describe('invoiceStats', () => {
  const row = (status: InvoiceRow['status'], due: string, total: number, currency = 'CZK') => ({ status, due, total, currency }) as InvoiceRow;

  it('počítá k úhradě a po splatnosti s částkami po měnách a nejstarší splatností', () => {
    const rows = [row('open', '2026-11-20', 100), row('open', '2026-11-25', 50, 'EUR'), row('overdue', '2026-10-29', 200), row('overdue', '2026-11-05', 30), row('paid', '2026-10-01', 999)];
    const s = invoiceStats(rows, '2026-11-08');
    expect(s.open.count).toBe(2);
    expect(s.open.sums.map((x) => [x.currency, x.total])).toEqual([['CZK', 100], ['EUR', 50]]);
    expect(s.overdue).toMatchObject({ count: 2, oldestDays: 10 });
    expect(s.overdue.sums.map((x) => x.total)).toEqual([230]);
  });

  it('bez faktur po splatnosti', () => {
    expect(invoiceStats([], '2026-11-08').overdue).toMatchObject({ count: 0, oldestDays: 0, sums: [] });
  });
});

describe('relativeDue a dueTone', () => {
  const today = '2026-11-08';

  it('termín slovy', () => {
    expect(relativeDue('2026-11-08', today)).toBe('dnes');
    expect(relativeDue('2026-11-09', today)).toBe('zítra');
    expect(relativeDue('2026-11-07', today)).toBe('včera');
    expect(relativeDue('2026-11-16', today)).toBe('za 8 dní');
    expect(relativeDue('2026-10-29', today)).toBe('před 10 dny');
    expect(relativeDue('2026-11-10', today)).toBe('za 2 dny');
  });

  it('vzdálenější než 31 dní je datum', () => {
    expect(relativeDue('2026-12-09', today)).toBe('za 31 dní');
    expect(relativeDue('2026-12-10', today)).toBe('10. 12. 2026');
    expect(relativeDue('2026-09-01', today)).toBe('1. 9. 2026');
  });

  it('barva podle blízkosti', () => {
    expect(dueTone('2026-11-07', today)).toBe('overdue');
    expect(dueTone('2026-11-08', today)).toBe('soon');
    expect(dueTone('2026-11-15', today)).toBe('soon');
    expect(dueTone('2026-11-16', today)).toBe('calm');
  });
});

describe('latestProjects', () => {
  it('nejnověji upravené první, nejvýš limit', () => {
    const ps = [1, 4, 2, 3].map((updatedAt) => ({ updatedAt }));
    expect(latestProjects(ps).map((p) => p.updatedAt)).toEqual([4, 3, 2]);
  });
});
