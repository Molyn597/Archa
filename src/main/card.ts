import { DOC_TYPES } from '../shared/card';
import type { Author, DocType, DocumentCard, Segment } from '../shared/types';
import { extractJsonObject } from './review';

const MAX_KEYWORDS = 10;

/** Text dokumentu pro kartu: originál odstavců v pořadí, s `[p. N]` při změně stránky, zkrácený na `limit` znaků. */
export function cardSample(segments: Segment[], limit: number): string {
  const parts: string[] = [];
  let page: number | undefined;
  for (const s of segments) {
    if (s.layoutOnly || s.figure || !s.source.trim()) continue;
    if (s.page !== undefined && s.page !== page) {
      page = s.page;
      parts.push(`[p. ${page}]`);
    }
    parts.push(s.source.trim());
  }
  return parts.join('\n\n').slice(0, limit);
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Karta z odpovědi modelu; bez shrnutí nebo při nečitelném JSONu undefined. */
export function parseCard(text: string, target: string): DocumentCard | undefined {
  const d = extractJsonObject(text);
  if (!d) return undefined;
  const summary = str(d.summary);
  if (!summary) return undefined;
  const type = str(d.type).toLowerCase();
  const keywords = [...new Set((Array.isArray(d.keywords) ? d.keywords : []).map(str).filter(Boolean))].slice(0, MAX_KEYWORDS);
  const b = (d.biblio && typeof d.biblio === 'object' ? d.biblio : {}) as Record<string, unknown>;
  const authors: Author[] = (Array.isArray(b.authors) ? b.authors : [])
    .map((a: unknown) => ({ family: str((a as Record<string, unknown>)?.family), given: str((a as Record<string, unknown>)?.given) }))
    .filter((a) => a.family || a.given);
  const opt = (v: unknown) => str(v) || undefined;
  return {
    summary,
    type: DOC_TYPES.includes(type as DocType) ? (type as DocType) : 'other',
    keywords,
    folder: opt(d.folder),
    biblio: {
      authors,
      title: str(b.title),
      year: opt(b.year),
      container: opt(b.container),
      publisher: opt(b.publisher),
      place: opt(b.place),
      edition: opt(b.edition),
      volume: opt(b.volume),
      issue: opt(b.issue),
      pages: opt(b.pages),
      doi: opt(b.doi),
      url: opt(b.url),
    },
    lang: target,
    createdAt: Date.now(),
  };
}
