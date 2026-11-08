import { describe, expect, it } from 'vitest';
import { deadlines, groupDeadlines } from '../src/shared/deadlines';
import { formatMoney } from '../src/shared/money';
import type { DocFacts, DocumentCard, Job, Project } from '../src/shared/types';

const job = (id: string) => ({ id, name: id, ext: '.pdf' }) as Job;
const card = (type: DocumentCard['type'], facts: DocFacts) => ({ type, facts }) as DocumentCard;
const project = (id: string, deadline?: string) => ({ id, name: `Projekt ${id}`, deadline }) as Project;
const TODAY = '2026-11-08';

const run = (cards: Record<string, DocumentCard>, extra: { paid?: Record<string, number>; projects?: Project[] } = {}) =>
  deadlines({ jobs: Object.keys(cards).map(job), cards, paid: extra.paid, projects: extra.projects ?? [], today: TODAY });

describe('faktury', () => {
  it('jen nezaplacené se splatností', () => {
    const r = run(
      {
        a: card('invoice', { supplier: 'Foo', number: '1', amount: '100 Kč', due: '2026-11-20' }),
        b: card('invoice', { supplier: 'Bar', due: '2026-11-01' }),
        c: card('invoice', { supplier: 'Zaplacená', due: '2026-11-10' }),
        d: card('invoice', { supplier: 'Bez splatnosti' }),
      },
      { paid: { c: 1 } },
    );
    expect(r.map((x) => x.jobId)).toEqual(['b', 'a']);
    expect(r[0]).toMatchObject({ kind: 'invoiceDue', overdue: true, title: 'Bar' });
    expect(r[1]).toMatchObject({ overdue: false, title: 'Foo', detail: `${formatMoney(100, 'CZK', 'cs-CZ')} · 1` });
  });

  it('částku, kterou nejde přečíst, ukáže jako text z karty', () => {
    const r = run({ a: card('invoice', { supplier: 'Foo', amount: 'dle dohody', due: '2026-11-20' }) });
    expect(r[0].detail).toBe('dle dohody');
  });

  it('nezaplacená po termínu zůstává i po 60 dnech', () => {
    const r = run({ a: card('invoice', { supplier: 'Stará', due: '2025-01-01' }) });
    expect(r).toHaveLength(1);
    expect(r[0].overdue).toBe(true);
  });
});

describe('smlouvy', () => {
  it('konec a poslední den pro výpověď', () => {
    const r = run({ a: card('contract', { subject: 'Nájem', validTo: '2027-03-31', notice: '3 měsíce', autoRenewal: 'automaticky o 12 měsíců' }) });
    expect(r.map((x) => [x.kind, x.date])).toEqual([
      ['contractNotice', '2026-12-31'],
      ['contractEnd', '2027-03-31'],
    ]);
    expect(r[0].detail).toContain('3 měsíce');
    expect(r[0].detail).toContain('jinak se smlouva prodlouží');
    expect(r[0].title).toBe('Nájem');
  });

  it('bez automatického prodloužení není ve výpovědi „jinak se prodlouží“', () => {
    const r = run({ a: card('contract', { parties: ['Acme'], validTo: '2027-03-31', notice: '90 days' }) });
    expect(r[0].kind).toBe('contractNotice');
    expect(r[0].date).toBe('2026-12-31');
    expect(r[0].detail).not.toContain('prodlouží');
    expect(r[0].title).toBe('Acme');
  });

  it('bez data konce spočítá konec ze začátku a doby trvání', () => {
    const r = run({ a: card('contract', { validFrom: '2026-04-01', period: '24 měsíců', notice: '90 dní' }) });
    expect(r.map((x) => [x.kind, x.date])).toEqual([
      ['contractNotice', '2028-01-01'],
      ['contractEnd', '2028-03-31'],
    ]);
  });

  it('bez výpovědní lhůty jen konec', () => {
    const r = run({ a: card('contract', { validTo: '2027-03-31' }) });
    expect(r.map((x) => x.kind)).toEqual(['contractEnd']);
  });

  it('automatické prodloužení přes dnešek', () => {
    const r = run({ a: card('contract', { subject: 'X', validTo: '2024-12-31', autoRenewal: 'prodlužuje se vždy o 1 rok', notice: '3 měsíce' }) });
    const end = r.find((x) => x.kind === 'contractEnd')!;
    expect(end.date).toBe('2026-12-31');
    expect(end.overdue).toBe(false);
    expect(end.detail).toBe('Prodlouženo automaticky');
    // Lhůta pro tento cyklus už uplynula, takže se neukazuje.
    expect(r.some((x) => x.kind === 'contractNotice')).toBe(false);
  });

  it('prodloužení a lhůta v jednom textu', () => {
    const r = run({ a: card('contract', { validTo: '2026-06-30', autoRenewal: 'o 1 rok, pokud není oznámeno 3 měsíce před koncem' }) });
    const end = r.find((x) => x.kind === 'contractEnd')!;
    expect(end.date).toBe('2027-06-30');
    expect(r.find((x) => x.kind === 'contractNotice')!.date).toBe('2027-03-30');
  });

  it('text jen s lhůtou před koncem není délka prodloužení', () => {
    const r = run({ a: card('contract', { validTo: '2026-12-20', autoRenewal: 'Automatické prodloužení, pokud není oznámeno 3 měsíce před koncem' }) });
    expect(r.find((x) => x.kind === 'contractEnd')).toMatchObject({ date: '2026-12-20', overdue: false });
    expect(r.find((x) => x.kind === 'contractNotice')).toMatchObject({ date: '2026-09-20', overdue: true });
  });

  it('bez dalšího údaje se bere první údaj, jinak ne', () => {
    const r = run({ a: card('contract', { validTo: '2026-10-31', autoRenewal: 'automatisch 6 Monate' }) });
    expect(r.find((x) => x.kind === 'contractEnd')!.date).toBe('2027-04-30');
  });

  it('skončená smlouva bez prodloužení po 30 dnech zmizí', () => {
    expect(run({ a: card('contract', { validTo: '2026-10-15' }) })).toHaveLength(1);
    expect(run({ a: card('contract', { validTo: '2026-09-01' }) })).toHaveLength(0);
  });
});

describe('projekty a řazení', () => {
  it('termín projektu, bez termínu se vynechá, staré po termínu pryč', () => {
    const r = run({}, { projects: [project('a', '2026-11-12'), project('b'), project('c', '2026-11-01'), project('d', '2026-08-01')] });
    expect(r.map((x) => x.projectId)).toEqual(['c', 'a']);
    expect(r[0]).toMatchObject({ kind: 'projectDeadline', overdue: true, title: 'Projekt c' });
  });

  it('řadí podle data napříč druhy', () => {
    const r = run({ a: card('invoice', { due: '2026-12-01' }), b: card('contract', { validTo: '2026-11-15' }) }, { projects: [project('p', '2026-11-09')] });
    expect(r.map((x) => x.date)).toEqual(['2026-11-09', '2026-11-15', '2026-12-01']);
  });
});

describe('groupDeadlines', () => {
  it('rozdělí podle blízkosti', () => {
    const mk = (date: string) => ({ kind: 'invoiceDue', date, title: date, overdue: date < TODAY }) as const;
    const g = groupDeadlines([mk('2026-11-01'), mk('2026-11-08'), mk('2026-11-15'), mk('2026-11-16'), mk('2026-12-09'), mk('2026-12-10')], TODAY);
    expect(g.overdue.map((x) => x.date)).toEqual(['2026-11-01']);
    expect(g.week.map((x) => x.date)).toEqual(['2026-11-08', '2026-11-15']);
    expect(g.month.map((x) => x.date)).toEqual(['2026-11-16', '2026-12-09']);
    expect(g.later.map((x) => x.date)).toEqual(['2026-12-10']);
  });
});
