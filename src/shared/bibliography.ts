import { reference, toHtml, toPlain, type Lang, type Part } from './citation';
import type { CitationStyle, DocumentCard, Job } from './types';

/** Co v kartě chybí pro úplnou citaci. */
export type BiblioGap = 'card' | 'title' | 'author' | 'year';

export interface BiblioEntry {
  jobId: string;
  parts: Part[];
  gaps: BiblioGap[];
}

/** Chybějící údaje karty; bez karty (nebo bez názvu) nejde citovat vůbec. */
export function gaps(card: DocumentCard | null | undefined): BiblioGap[] {
  if (!card) return ['card'];
  const b = card.biblio;
  const out: BiblioGap[] = [];
  if (!b.title?.trim()) out.push('title');
  if (!b.authors.some((a) => a.family.trim())) out.push('author');
  if (!b.year?.trim()) out.push('year');
  return out;
}

/**
 * Seznam literatury ze zdrojů: abecedně podle hotové citace (ČSN ISO 690 i APA řadí podle prvního autora).
 * Dokument bez karty nebo bez názvu se do seznamu nedostane, jen do `missing`.
 */
export function bibliography(sources: { job: Job; card?: DocumentCard | null }[], style: CitationStyle, lang: Lang, today?: string) {
  const entries: BiblioEntry[] = [];
  const missing: BiblioEntry[] = [];
  for (const { job, card } of sources) {
    const g = gaps(card);
    if (g.includes('card') || g.includes('title')) missing.push({ jobId: job.id, parts: [{ text: job.name }], gaps: g });
    else entries.push({ jobId: job.id, parts: reference(card!.biblio, card!.type, style, lang, today), gaps: g });
  }
  const collator = new Intl.Collator(lang, { sensitivity: 'base' });
  entries.sort((a, b) => collator.compare(toPlain(a.parts), toPlain(b.parts)));
  return { entries, missing };
}

/** Seznam do schránky: řádky prostého textu a odstavce HTML (kurzíva zůstane ve Wordu). */
export const bibliographyText = (entries: BiblioEntry[]) => entries.map((e) => toPlain(e.parts)).join('\n');
export const bibliographyHtml = (entries: BiblioEntry[]) => entries.map((e) => `<p>${toHtml(e.parts)}</p>`).join('');
