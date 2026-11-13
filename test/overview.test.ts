import { describe, expect, it } from 'vitest';
import type { InvoiceRow } from '../src/shared/invoices';
import { citeGapCount, continueRows, dueTone, invoiceStats, latestProjects, newestJobs, relativeDue, toSort, upcoming, waitRows } from '../src/shared/overview';

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

describe('waitRows', () => {
  const today = '2026-11-08';
  const inv = (status: InvoiceRow['status'], due: string, total = 100) => ({ status, due, total, currency: 'CZK' }) as InvoiceRow;
  const base = { unpaid: [], inbox: [], practice: { total: 0, scopes: [] }, citeGaps: 0 };

  it('bez čehokoli nic', () => {
    for (const library of ['work', 'study', 'personal'] as const) expect(waitRows({ ...base, library }, today)).toEqual([]);
  });

  it('Práce: po splatnosti, do 7 dní, Odkladiště; dál než 7 dní se neukáže', () => {
    const unpaid = [inv('overdue', '2026-10-29', 200), inv('open', '2026-11-10', 50), inv('open', '2026-11-12', 25), inv('open', '2026-12-30', 999)];
    const r = waitRows({ ...base, library: 'work', unpaid, inbox: ['a', 'b'], citeGaps: 4 }, today);
    expect(r.map((x) => x.kind)).toEqual(['overdue', 'soon', 'inbox']);
    expect(r[0]).toMatchObject({ count: 1, oldestDays: 10 });
    expect(r[1]).toMatchObject({ count: 2, nearest: '2026-11-10' });
    expect(r[2]).toMatchObject({ count: 2, first: 'a' });
  });

  it('Studium: Odkladiště, opakování a chybějící citace; opakování bez rozsahu nic', () => {
    const practice = { total: 3, scopes: [{ scope: 's1', title: 'Management', count: 3 }] };
    expect(waitRows({ ...base, library: 'study', inbox: ['a'], practice, citeGaps: 2, unpaid: [inv('overdue', '2026-10-01')] }, today).map((x) => x.kind)).toEqual(['inbox', 'practice', 'cite']);
    expect(waitRows({ ...base, library: 'study', practice: { total: 3, scopes: [] } }, today)).toEqual([]);
  });

  it('Osobní: k zaplacení všechno nezaplacené, pak Odkladiště', () => {
    const r = waitRows({ ...base, library: 'personal', unpaid: [inv('open', '2026-12-20'), inv('overdue', '2026-11-01')], inbox: ['x'] }, today);
    expect(r.map((x) => x.kind)).toEqual(['unpaid', 'inbox']);
    expect(r[0]).toMatchObject({ count: 2, nearest: '2026-11-01' });
  });
});

describe('upcoming', () => {
  it('bez zpožděných a vzdálených, nejbližší první, nejvýš limit', () => {
    const d = (date: string, overdue = false) => ({ date, overdue });
    const list = [d('2026-11-30'), d('2026-11-01', true), d('2026-11-09'), d('2027-03-01'), d('2026-11-08')];
    expect(upcoming(list, '2026-11-08').map((x) => x.date)).toEqual(['2026-11-08', '2026-11-09', '2026-11-30']);
    expect(upcoming(list, '2026-11-08', 45, 2)).toHaveLength(2);
  });
});

describe('continueRows', () => {
  const p = (id: string, updatedAt: number, deadline?: string) => ({ id, updatedAt, deadline });
  const j = (id: string, createdAt: number) => ({ id, createdAt, status: 'done' });

  it('Studium řadí práce podle termínu, bez termínu nakonec, nejvýš 3', () => {
    const r = continueRows('study', [p('a', 1), p('b', 2, '2026-12-01'), p('c', 3, '2026-11-20'), p('d', 4, '2026-12-15')], [1, 2, 3, 4].map((n) => j(String(n), n)));
    expect(r.projects.map((x) => x.id)).toEqual(['c', 'b', 'd']);
    expect(r.jobs).toHaveLength(3);
  });

  it('Práce bere naposled upravené, Osobní jen dokumenty (5)', () => {
    expect(continueRows('work', [p('a', 1), p('b', 2)], []).projects.map((x) => x.id)).toEqual(['b', 'a']);
    const r = continueRows('personal', [p('a', 1)], [1, 2, 3, 4, 5, 6].map((n) => j(String(n), n)));
    expect(r.projects).toEqual([]);
    expect(r.jobs).toHaveLength(5);
  });
});

describe('citeGapCount', () => {
  const card = (type: string, authors: string[], year: string) => ({ type, biblio: { title: 'T', authors: authors.map((family) => ({ family })), year } }) as never;
  it('počítá jen hotové články a knihy bez autora nebo roku', () => {
    const cards = { a: card('article', [], '2020'), b: card('article', ['Novák'], '2020'), c: card('invoice', [], ''), d: card('book', ['X'], ''), e: card('article', [], '') };
    const jobs = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, status: id === 'e' ? 'running' : 'done' }));
    expect(citeGapCount(jobs, cards)).toBe(2);
  });
});
