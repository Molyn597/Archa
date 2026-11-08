import { folderPath, isLocked, subtree } from '../shared/folders';
import { deadlines } from '../shared/deadlines';
import { isoDay } from '../shared/invoices';
import type { DocFacts, DocumentCard, Job, Library } from '../shared/types';

/** Dokument knihovny pro chat: úloha, karta a zobrazený název složky. */
export interface LibDoc {
  job: Job;
  card?: DocumentCard;
  folder?: string;
  /** Faktura označená jako zaplacená (čas označení). */
  paidAt?: number;
}

/**
 * Hotové dokumenty, ve kterých se smí hledat: bez zamčených složek (F5, i zděděně), případně jen ze složky
 * `folder` včetně podsložek. Zařazení do smazané složky = nezařazeno.
 */
export function libraryDocs(jobs: Job[], cards: Record<string, DocumentCard | null | undefined>, library: Library, folder?: string): LibDoc[] {
  const all = library.folders;
  const folders = new Map(all.map((f) => [f.id, f]));
  const scope = folder ? subtree(all, folder) : undefined;
  return jobs.flatMap((job) => {
    if (job.status !== 'done') return [];
    const f = folders.get(library.assign[job.id]?.folder ?? '');
    if ((f && isLocked(all, f)) || (scope && !(f && scope.has(f.id)))) return [];
    const paidAt = library.paid?.[job.id];
    return [{ job, card: cards[job.id] ?? undefined, folder: f ? folderPath(all, f) : undefined, ...(paidAt !== undefined && { paidAt }) }];
  });
}

export function factsText(facts?: DocFacts) {
  if (!facts) return '';
  return Object.entries(facts)
    .map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v] as const)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ');
}

/** Fakta dokumentu pro model; u faktury i stav úhrady, aby šlo odpovědět „co je po splatnosti“. */
export function docFactsText(doc: LibDoc) {
  const facts = factsText(doc.card?.facts);
  if (doc.card?.type === 'contract') {
    // Spočítané termíny (i po automatickém prodloužení), ať model nepočítá data sám.
    const dates = deadlines({ jobs: [doc.job], cards: { [doc.job.id]: doc.card }, paid: undefined, projects: [], today: isoDay() })
      .map((d) => `${d.kind === 'contractNotice' ? 'last day to give notice' : 'current end'}: ${d.date}`)
      .join('; ');
    return [facts, dates].filter(Boolean).join('; ');
  }
  if (doc.card?.type !== 'invoice') return facts;
  const paid = doc.paidAt !== undefined ? `paid: yes (${isoDay(new Date(doc.paidAt))})` : 'paid: no';
  return facts ? `${facts}; ${paid}` : paid;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max).trimEnd()}…` : s);

/** Řádek katalogu: název | složka | typ | rok | titul | shrnutí | klíčová slova | fakta. */
export function cardText(doc: LibDoc, summaryMax = Infinity) {
  const c = doc.card;
  return [
    `${doc.job.name}${doc.job.ext}`,
    doc.folder ?? '',
    c?.type ?? '',
    c?.biblio.year ?? '',
    c?.biblio.title ?? '',
    c ? clip(c.summary.replace(/\s+/g, ' '), summaryMax) : '',
    c?.keywords.join(', ') ?? '',
    docFactsText(doc),
  ].join(' | ');
}
