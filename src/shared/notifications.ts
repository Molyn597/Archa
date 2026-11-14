import type { Deadline } from './deadlines';
import { locale, t, type MessageKey } from './i18n';
import type { CurrencySum, InvoiceStatusFilter } from './invoices';
import { formatMoney } from './money';
import { relativeDue, upcoming, type WaitRow } from './overview';
import type { Job } from './types';

export const sumsText = (sums: CurrencySum[]) => sums.map((s) => formatMoney(s.total, s.currency, locale(), true)).join(' · ');

export type NoteKind = 'failed' | 'done' | 'overdue' | 'deadline' | 'soon' | 'practice' | 'inbox' | 'update';

/** Kam oznámení vede; konkrétní otevření řeší okno. */
export type NoteTarget =
  | { to: 'job'; id: string }
  | { to: 'project'; id: string }
  | { to: 'unsorted' }
  | { to: 'all' }
  | { to: 'invoices'; status: InvoiceStatusFilter }
  | { to: 'deadlines' }
  | { to: 'update' }
  | { to: 'practice'; scope: string };

export interface Note {
  /** Stabilní id: změní se, jen když je to opravdu nová zpráva (pak se znovu ukáže tečka). */
  id: string;
  kind: NoteKind;
  title: string;
  sub: string;
  /** Čas události (hotovo / selhalo), jinak 0. */
  at: number;
  target: NoteTarget;
}

export interface NoteInput {
  today: string;
  now: number;
  jobs: Pick<Job, 'id' | 'status' | 'createdAt' | 'finishedAt' | 'error'>[];
  /** Název dokumentu pro seznamy. */
  title(jobId: string): string;
  /** Řádky Čeká na tebe z Přehledu. */
  wait: WaitRow[];
  /** Všechny termíny knihovny. */
  deadlines: Deadline[];
  /** Známá novější verze aplikace; `at` je čas, kdy se o ní zjistilo. */
  update?: { version: string; notes: string; at: number };
}

/** Od tolika hotových dokumentů se ukáže jeden souhrnný řádek místo řádku za každý. */
const DONE_GROUP = 3;
/** Hotové a neúspěšné úlohy se hlásí jen krátce po dokončení; starší už jsou jen v knihovně. */
const FRESH_MS = 24 * 3_600_000;
export const NOTE_LIMIT = 10;
// Pořadí: nejdřív události (selhání, hotovo), pak to, co hoří, nakonec co čeká.
const RANK: Record<NoteKind, number> = { update: 0, failed: 1, done: 2, overdue: 3, deadline: 4, soon: 5, practice: 6, inbox: 7 };

/** Oznámení pro aktuální knihovnu: jen neprázdné druhy, nejdřív události (nejnovější první), pak podle naléhavosti. */
export function buildNotes(input: NoteInput): Note[] {
  const { today, now, jobs, wait, deadlines, update } = input;
  const notes: Note[] = [];

  if (update) {
    const sub = update.notes.split('\n').find((l) => l.trim())?.trim() || t('note.update.sub');
    notes.push({ id: `update:${update.version}`, kind: 'update', title: t('note.update', { version: update.version }), sub, at: update.at, target: { to: 'update' } });
  }

  for (const j of jobs) {
    const at = j.finishedAt ?? j.createdAt;
    if (now - at > FRESH_MS || (j.status !== 'done' && j.status !== 'error')) continue;
    const kind = j.status === 'done' ? 'done' : 'failed';
    notes.push({ id: `${kind}:${j.id}:${at}`, kind, title: t(kind === 'done' ? 'note.done' : 'note.failed', { name: input.title(j.id) }), sub: j.error ?? '', at, target: { to: 'job', id: j.id } });
  }

  const done = notes.filter((n) => n.kind === 'done');
  if (done.length >= DONE_GROUP) {
    done.sort((a, b) => b.at - a.at);
    const names = done.slice(0, 2).map((n) => input.title(n.target.to === 'job' ? n.target.id : ''));
    notes.splice(0, notes.length, ...notes.filter((n) => n.kind !== 'done'));
    notes.push({ id: `done:${done.length}:${done[0]!.at}`, kind: 'done', title: t('note.doneMany', { count: done.length }), sub: `${names.join(', ')}…`, at: done[0]!.at, target: { to: 'all' } });
  }

  for (const r of wait) {
    if (r.kind === 'overdue') notes.push({ id: `overdue:${r.count}:${today}`, kind: 'overdue', title: t('ov.w.overdue', { count: r.count }), sub: sumsText(r.sums), at: 0, target: { to: 'invoices', status: 'overdue' } });
    else if (r.kind === 'soon') notes.push({ id: `soon:${r.count}:${r.nearest}`, kind: 'soon', title: t('ov.w.soon', { count: r.count }), sub: sumsText(r.sums), at: 0, target: { to: 'invoices', status: 'open' } });
    else if (r.kind === 'inbox') notes.push({ id: `inbox:${r.count}:${r.first}`, kind: 'inbox', title: t('ov.w.inbox', { count: r.count }), sub: input.title(r.first), at: 0, target: { to: 'unsorted' } });
    else if (r.kind === 'practice') notes.push({ id: `practice:${today}:${r.count}`, kind: 'practice', title: t('practice.dueToday', { count: r.count }), sub: r.title, at: 0, target: { to: 'practice', scope: r.scope } });
  }

  // Faktury mají vlastní řádek výše, tady jen smlouvy a projekty.
  for (const d of upcoming(deadlines.filter((x) => x.kind !== 'invoiceDue'), today, 7, NOTE_LIMIT)) {
    const sub = [relativeDue(d.date, today), t(`dl.kind.${d.kind}` as MessageKey)].join(' · ');
    const target: NoteTarget = d.jobId ? { to: 'job', id: d.jobId } : d.projectId ? { to: 'project', id: d.projectId } : { to: 'deadlines' };
    notes.push({ id: `dl:${d.kind}:${d.jobId ?? d.projectId ?? ''}:${d.date}`, kind: 'deadline', title: d.title, sub, at: 0, target });
  }

  return notes.sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.at - a.at).slice(0, NOTE_LIMIT);
}

/** Čas události pro seznam oznámení: „dnes 14:32“, „včera 14:32“, jinak „12. 11. 14:32“; bez času prázdný řetězec. */
export function noteTime(at: number, now: number): string {
  if (at <= 0) return '';
  const when = new Date(at);
  const time = when.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(new Date(now)) - dayStart(when)) / 86_400_000);
  if (days === 0) return t('note.at.today', { time });
  if (days === 1) return t('note.at.yesterday', { time });
  return `${when.toLocaleDateString(locale(), { day: 'numeric', month: 'numeric' })} ${time}`;
}

/** Počet oznámení, která ještě nebyla vidět. */
export const unreadCount = (notes: Note[], seen: ReadonlySet<string>) => notes.filter((n) => !seen.has(n.id)).length;

/** Viděná id po otevření seznamu: dosavadní plus aktuální, nejstarší se zahodí nad `cap`. */
export const markSeen = (seen: readonly string[], notes: Note[], cap = 200): string[] => [...new Set([...seen, ...notes.map((n) => n.id)])].slice(-cap);
