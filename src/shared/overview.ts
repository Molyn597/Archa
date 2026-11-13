import { gaps } from './bibliography';
import { t } from './i18n';
import { day, invoiceSums, isoDay, type CurrencySum, type InvoiceRow } from './invoices';
import { isLiterature } from './nav';
import type { DocumentCard, Library, PracticeDue } from './types';

/** Složka, do které AI řadí nerozpoznané dokumenty (v každé šabloně knihovny). */
export const OTHER_FOLDER = 'other';

export interface ToSort {
  /** Bez složky. */
  unsorted: string[];
  /** Ve složce Ostatní. */
  other: string[];
  /** Čekající dotazy AI, kam dokument zařadit. */
  questions: string[];
  /** Počet různých dokumentů (dokument může být ve více skupinách). */
  total: number;
}

/** Dokumenty, které čekají na zařazení; počítají se jen ty, které jsou vidět (`jobIds`). */
export function toSort(jobIds: string[], library: Pick<Library, 'folders' | 'assign' | 'questions'>): ToSort {
  const ids = new Set(jobIds);
  const folderOf = (id: string) => {
    const folder = library.assign[id]?.folder;
    return library.folders.some((f) => f.id === folder) ? folder : undefined;
  };
  const unsorted = jobIds.filter((id) => !folderOf(id));
  const other = jobIds.filter((id) => folderOf(id) === OTHER_FOLDER);
  const questions = [...new Set((library.questions ?? []).map((q) => q.jobId))].filter((id) => ids.has(id));
  return { unsorted, other, questions, total: new Set([...unsorted, ...other, ...questions]).size };
}

/** Nově přidané dokumenty: běžící a čekající nahoře (běžící první), pak nejnovější. */
export function newestJobs<T extends { status: string; createdAt: number }>(jobs: T[], limit = 5): T[] {
  const active = (j: T) => j.status === 'running' || j.status === 'queued';
  const running = jobs.filter((j) => j.status === 'running').sort((a, b) => a.createdAt - b.createdAt);
  const queued = jobs.filter((j) => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
  const rest = jobs.filter((j) => !active(j)).sort((a, b) => b.createdAt - a.createdAt);
  return [...running, ...queued, ...rest].slice(0, limit);
}

export interface InvoiceGroup {
  count: number;
  sums: CurrencySum[];
}

export interface InvoiceStats {
  open: InvoiceGroup;
  overdue: InvoiceGroup & { /** Dnů od nejstarší splatnosti. */ oldestDays: number };
}

const DAY_MS = 86_400_000;
/** Počet dní od `from` do `to` (RRRR-MM-DD); záporný, když je `to` dřív. */
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** Čísla pro Přehled: faktury k úhradě a po splatnosti s částkami po měnách. */
export function invoiceStats(rows: InvoiceRow[], today: string): InvoiceStats {
  const open = rows.filter((r) => r.status === 'open');
  const overdue = rows.filter((r) => r.status === 'overdue');
  const oldest = overdue.reduce((min, r) => (r.due < min ? r.due : min), today);
  return {
    open: { count: open.length, sums: invoiceSums(open) },
    overdue: { count: overdue.length, sums: invoiceSums(overdue), oldestDays: daysBetween(oldest, today) },
  };
}

/** Termín slovy: „před 10 dny“, „za 8 dní“, „dnes“, „zítra“; vzdálenější než 31 dní jako datum. */
export function relativeDue(date: string, today: string): string {
  const diff = daysBetween(today, date);
  if (Math.abs(diff) > 31) return day(date);
  if (diff === 0) return t('rel.today');
  if (diff === 1) return t('rel.tomorrow');
  if (diff === -1) return t('rel.yesterday');
  return diff > 0 ? t('rel.inDays', { count: diff }) : t('rel.daysAgo', { count: -diff });
}

/** Jak dávno se něco stalo: „právě teď“, „před 5 min“, „před 3 h“, dál jako u termínu (včera, před N dny, datum). */
export function relativeAgo(at: number, now: number, today: string): string {
  const min = Math.floor((now - at) / 60_000);
  if (min < 1) return t('rel.now');
  if (min < 60) return t('rel.minAgo', { count: min });
  if (min < 1440) return t('rel.hoursAgo', { count: Math.floor(min / 60) });
  return relativeDue(isoDay(new Date(at)), today);
}

/** Barva termínu: po termínu, do 7 dní, jinak klidná. */
export function dueTone(date: string, today: string): 'overdue' | 'soon' | 'calm' {
  const diff = daysBetween(today, date);
  return diff < 0 ? 'overdue' : diff <= 7 ? 'soon' : 'calm';
}

/** Nejnověji upravené projekty. */
export const latestProjects = <T extends { updatedAt: number }>(projects: T[], limit = 3) =>
  [...projects].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);

/** Zdroje (hotové články a knihy), kterým chybí autor nebo rok pro citaci. */
export const citeGapCount = (jobs: { id: string; status: string }[], cards: Record<string, DocumentCard | undefined>) =>
  jobs.filter((j) => {
    const card = cards[j.id];
    return j.status === 'done' && card && isLiterature(card.type) && gaps(card).some((g) => g === 'author' || g === 'year');
  }).length;

/** Řádek bloku Čeká na tebe; text a odkaz skládá Přehled podle `kind`. */
export type WaitRow =
  | { kind: 'overdue'; count: number; sums: CurrencySum[]; oldestDays: number }
  | { kind: 'soon' | 'unpaid'; count: number; sums: CurrencySum[]; nearest: string }
  | { kind: 'inbox'; count: number; first: string }
  | { kind: 'practice'; count: number; scope: string; title: string }
  | { kind: 'cite'; count: number };

export interface WaitInput {
  library: 'work' | 'study' | 'personal';
  /** Přijaté faktury (výdaje) ve stavu k úhradě nebo po splatnosti. */
  unpaid: InvoiceRow[];
  /** Dokumenty v Odkladišti, první je ten, jehož název se ukáže. */
  inbox: string[];
  practice: PracticeDue;
  citeGaps: number;
}

/** Co čeká na uživatele: jen nenulové řádky, v pořadí podle typu knihovny. */
export function waitRows(input: WaitInput, today: string): WaitRow[] {
  const { library, unpaid, inbox, practice, citeGaps } = input;
  const overdue = unpaid.filter((r) => r.status === 'overdue');
  const soon = unpaid.filter((r) => r.status === 'open' && daysBetween(today, r.due) <= 7);
  const nearest = (rows: InvoiceRow[]) => rows.map((r) => r.due).sort()[0] ?? '';
  const rows: Record<string, WaitRow | false> = {
    overdue: overdue.length > 0 && { kind: 'overdue', count: overdue.length, sums: invoiceSums(overdue), oldestDays: daysBetween(nearest(overdue), today) },
    soon: soon.length > 0 && { kind: 'soon', count: soon.length, sums: invoiceSums(soon), nearest: nearest(soon) },
    unpaid: unpaid.length > 0 && { kind: 'unpaid', count: unpaid.length, sums: invoiceSums(unpaid), nearest: nearest(unpaid) },
    inbox: inbox.length > 0 && { kind: 'inbox', count: inbox.length, first: inbox[0]! },
    practice: practice.total > 0 && practice.scopes.length > 0 && { kind: 'practice', count: practice.total, scope: practice.scopes[0]!.scope, title: practice.scopes[0]!.title },
    cite: citeGaps > 0 && { kind: 'cite', count: citeGaps },
  };
  const order = { work: ['overdue', 'soon', 'inbox'], study: ['inbox', 'practice', 'cite'], personal: ['unpaid', 'inbox'] }[library];
  return order.map((k) => rows[k]).filter((r): r is WaitRow => Boolean(r));
}

/** Termíny pro Blíží se: bez těch po termínu, do `days` dní, nejbližší první, nejvýš `limit`. */
export function upcoming<T extends { date: string; overdue?: boolean }>(deadlines: T[], today: string, days = 45, limit = 5): T[] {
  return deadlines
    .filter((d) => !d.overdue && daysBetween(today, d.date) >= 0 && daysBetween(today, d.date) <= days)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, limit);
}

/** Pokračovat: projekty (ve Studiu podle nejbližšího termínu, bez termínu nakonec; jinak naposled upravené) a nově přidané dokumenty. */
export function continueRows<P extends { deadline?: string; updatedAt: number }, J extends { status: string; createdAt: number }>(
  library: 'work' | 'study' | 'personal',
  projects: P[],
  jobs: J[],
): { projects: P[]; jobs: J[] } {
  const ps = library === 'study' ? [...projects].sort((a, b) => (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999')) : latestProjects(projects);
  const shown = library === 'personal' ? [] : ps.slice(0, 3);
  return { projects: shown, jobs: newestJobs(jobs, shown.length ? 3 : 5) };
}
