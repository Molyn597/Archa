import { DOC_TYPES, FACT_FIELDS } from '../shared/card';
import type { Author, DocFacts, DocType, DocumentCard, Segment } from '../shared/types';
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

/** Datum D.M.RRRR → RRRR-MM-DD; jiný tvar zůstane beze změny. */
const isoDate = (v: string) => v.replace(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/, (_, d: string, m: string, y: string) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);

/** Fakta faktury / smlouvy; bez jediného vyplněného pole undefined. */
function parseFacts(raw: unknown): DocFacts | undefined {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const facts: DocFacts = {};
  for (const k of FACT_FIELDS) {
    const v = str(f[k]);
    if (v) facts[k] = k === 'issued' || k === 'due' ? isoDate(v) : v;
  }
  const parties = [...new Set((Array.isArray(f.parties) ? f.parties : []).map(str).filter(Boolean))];
  if (parties.length) facts.parties = parties;
  return Object.keys(facts).length ? facts : undefined;
}

/** Nejistota modelu ohledně složky: `folderSure: false` s až 2 dalšími možnostmi; jistá odpověď = nic. */
const folderUnsure = (d: Record<string, unknown>) =>
  d.folderSure === false ? { folderSure: false, folderOptions: (Array.isArray(d.folderOptions) ? d.folderOptions : []).map(str).filter(Boolean).slice(0, 2) } : {};

/** Volba podsložky z odpovědi modelu (doptání u složky s podsložkami); bez složky undefined. */
export function parseFolderChoice(text: string): Pick<DocumentCard, 'folder' | 'folderSure' | 'folderOptions'> | undefined {
  const d = extractJsonObject(text);
  const folder = d ? str(d.folder) : '';
  return d && folder ? { folder, ...folderUnsure(d) } : undefined;
}

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
  const docType = DOC_TYPES.includes(type as DocType) ? (type as DocType) : 'other';
  const facts = docType === 'invoice' || docType === 'contract' ? parseFacts(d.facts) : undefined;
  return {
    summary,
    type: docType,
    keywords,
    folder: opt(d.folder),
    ...folderUnsure(d),
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
    ...(facts && { facts }),
    lang: target,
    createdAt: Date.now(),
  };
}
