import { describe, expect, it } from 'vitest';
import type { Deadline } from '../src/shared/deadlines';
import { buildNotes, markSeen, NOTE_LIMIT, unreadCount, type NoteInput } from '../src/shared/notifications';
import { relativeAgo, type WaitRow } from '../src/shared/overview';

const NOW = Date.parse('2026-11-13T12:00:00');
const TODAY = '2026-11-13';
const HOUR = 3_600_000;

const input = (extra: Partial<NoteInput> = {}): NoteInput => ({ today: TODAY, now: NOW, jobs: [], title: (id) => `Doc ${id}`, wait: [], deadlines: [], ...extra });
const job = (id: string, status: 'done' | 'error' | 'running', agoH: number, error?: string) => ({ id, status, createdAt: NOW - agoH * HOUR - 1000, finishedAt: NOW - agoH * HOUR, error });
const dl = (kind: Deadline['kind'], date: string, extra: Partial<Deadline> = {}): Deadline => ({ kind, date, title: 'Smlouva X', overdue: false, ...extra });

describe('buildNotes', () => {
  it('prázdná knihovna nemá nic nového', () => {
    expect(buildNotes(input())).toEqual([]);
  });

  it('hotové a neúspěšné jen čerstvé; selhání první, pak nejnovější hotové', () => {
    const notes = buildNotes(input({ jobs: [job('a', 'done', 5), job('b', 'done', 1), job('c', 'error', 2, 'chyba'), job('old', 'done', 30), job('run', 'running', 0)] }));
    expect(notes.map((n) => n.id.split(':')[1])).toEqual(['c', 'b', 'a']);
    expect(notes[0]).toMatchObject({ kind: 'failed', title: 'Nezdařilo se: Doc c', sub: 'chyba', target: { to: 'job', id: 'c' } });
    expect(notes[1]).toMatchObject({ kind: 'done', title: 'Hotovo: Doc b' });
  });

  it('řádky Čeká na tebe a termíny, bez faktur z termínů a bez nezajímavých druhů', () => {
    const wait: WaitRow[] = [
      { kind: 'inbox', count: 2, first: 'x' },
      { kind: 'overdue', count: 1, sums: [{ currency: 'CZK', total: 1000, net: 0, vat: 0 }], oldestDays: 3 },
      { kind: 'soon', count: 2, sums: [{ currency: 'CZK', total: 500, net: 0, vat: 0 }], nearest: '2026-11-15' },
      { kind: 'practice', count: 4, scope: 'sc', title: 'Kurz' },
      { kind: 'cite', count: 1 },
      { kind: 'unpaid', count: 3, sums: [], nearest: '2026-11-30' },
    ];
    const deadlines = [dl('invoiceDue', '2026-11-14'), dl('contractEnd', '2026-11-16', { jobId: 'k' }), dl('projectDeadline', '2026-11-18', { projectId: 'p', title: 'Projekt' }), dl('contractEnd', '2026-12-30', { jobId: 'far' })];
    const notes = buildNotes(input({ wait, deadlines }));
    expect(notes.map((n) => n.kind)).toEqual(['overdue', 'deadline', 'deadline', 'soon', 'practice', 'inbox']);
    expect(notes.find((n) => n.kind === 'inbox')).toMatchObject({ sub: 'Doc x', target: { to: 'unsorted' } });
    expect(notes.find((n) => n.kind === 'overdue')?.target).toEqual({ to: 'invoices', status: 'overdue' });
    expect(notes.find((n) => n.kind === 'soon')?.target).toEqual({ to: 'invoices', status: 'open' });
    expect(notes.find((n) => n.kind === 'practice')?.target).toEqual({ to: 'practice', scope: 'sc' });
    expect(notes.filter((n) => n.kind === 'deadline').map((n) => n.target)).toEqual([{ to: 'job', id: 'k' }, { to: 'project', id: 'p' }]);
  });

  it('omezí počet', () => {
    const jobs = Array.from({ length: 15 }, (_, i) => job(`j${i}`, 'error', 1 + i / 100));
    expect(buildNotes(input({ jobs }))).toHaveLength(NOTE_LIMIT);
  });

  it('víc hotových sloučí do jednoho řádku', () => {
    const notes = buildNotes(input({ jobs: [job('a', 'done', 3), job('b', 'done', 1), job('c', 'done', 2)] }));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'done', title: 'Hotovo: 3 dokumenty', sub: 'Doc b, Doc c…', target: { to: 'all' } });
  });
});

describe('viděná oznámení', () => {
  const notes = buildNotes(input({ jobs: [job('a', 'done', 1), job('b', 'done', 2)] }));

  it('počítá nepřečtená a po otevření nic nezbývá', () => {
    expect(unreadCount(notes, new Set())).toBe(2);
    expect(unreadCount(notes, new Set([notes[0]!.id]))).toBe(1);
    expect(unreadCount(notes, new Set(markSeen([], notes)))).toBe(0);
  });

  it('seznam viděných má strop a drží nejnovější', () => {
    const seen = markSeen(['1', '2', '3'], notes, 4);
    expect(seen).toHaveLength(4);
    expect(seen.slice(-2)).toEqual(notes.map((n) => n.id));
  });
});

describe('relativeAgo', () => {
  it('minuty, hodiny, včera', () => {
    expect(relativeAgo(NOW - 20_000, NOW, TODAY)).toBe('právě teď');
    expect(relativeAgo(NOW - 5 * 60_000, NOW, TODAY)).toBe('před 5 min');
    expect(relativeAgo(NOW - 3 * HOUR, NOW, TODAY)).toBe('před 3 h');
    expect(relativeAgo(NOW - 30 * HOUR, NOW, TODAY)).toBe('včera');
  });
});
