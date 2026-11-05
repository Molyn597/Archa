import { folderPath, isLocked, subtree } from '../shared/folders';
import type { DocFacts, DocumentCard, Job, Library } from '../shared/types';

/** Dokument knihovny pro chat: úloha, karta a zobrazený název složky. */
export interface LibDoc {
  job: Job;
  card?: DocumentCard;
  folder?: string;
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
    return [{ job, card: cards[job.id] ?? undefined, folder: f ? folderPath(all, f) : undefined }];
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
    factsText(c?.facts),
  ].join(' | ');
}
