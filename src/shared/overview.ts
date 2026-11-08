import { t } from './i18n';
import { day, invoiceSums, type CurrencySum, type InvoiceRow } from './invoices';
import type { Library } from './types';

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

/** Barva termínu: po termínu, do 7 dní, jinak klidná. */
export function dueTone(date: string, today: string): 'overdue' | 'soon' | 'calm' {
  const diff = daysBetween(today, date);
  return diff < 0 ? 'overdue' : diff <= 7 ? 'soon' : 'calm';
}

/** Nejnověji upravené projekty. */
export const latestProjects = <T extends { updatedAt: number }>(projects: T[], limit = 3) =>
  [...projects].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
