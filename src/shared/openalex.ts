import { authorsText } from './card';
import { flat } from './risks';
import type { Author, Biblio } from './types';

const API = 'https://api.openalex.org/works';
/** Jen pole, která mapování používá; odpovědi jsou mnohem větší. */
const SELECT = 'id,display_name,publication_year,authorships,primary_location,biblio,doi,best_oa_location,open_access,type';

export interface OpenAlexWork {
  id: string;
  title: string;
  authors: Author[];
  year?: string;
  container?: string;
  publisher?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  /** Volně dostupné PDF (ke stažení). */
  pdfUrl?: string;
  /** Stránka článku na webu. */
  url?: string;
  type?: string;
}

/** Pole karty, která jde z OpenAlex doplnit. */
export const FILL_FIELDS = ['authors', 'year', 'container', 'volume', 'issue', 'pages', 'doi', 'publisher', 'url'] as const;
export type FillField = (typeof FILL_FIELDS)[number];
export interface Gap {
  field: FillField;
  /** Text pro zobrazení; u autorů jeden na řádek. */
  current: string;
  found: string;
}

/** Předložky a částice, které patří k příjmení („van der Berg“, „de la Cruz“). */
const PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'del', 'della', 'di', 'da', 'du', 'la', 'le', 'ten', 'ter', 'al', 'bin', 'ibn', 'st.']);

export function toAuthor(name: string): Author {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return { given: '', family: tokens[0] ?? '' };
  let start = tokens.length - 1;
  while (start > 1 && PARTICLES.has(tokens[start - 1].toLowerCase())) start--;
  return { given: tokens.slice(0, start).join(' '), family: tokens.slice(start).join(' ') };
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === 'number' || typeof v === 'string' ? str(String(v)) : undefined);
/** Objekt z JSON; cokoli jiného je prázdný objekt, aby šlo číst bez kontrol. */
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});

export const cleanDoi = (doi: string | undefined) => str(doi)?.replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, '').replace(/^doi:/i, '');

/** Surová práce z OpenAlex → naše pole; chybějící části se vynechají. undefined = bez názvu. */
export function toWork(raw: unknown): OpenAlexWork | undefined {
  const w = obj(raw);
  const title = str(w.display_name) ?? str(w.title);
  if (!title) return undefined;
  const loc = obj(w.primary_location);
  const biblio = obj(w.biblio);
  const first = num(biblio.first_page);
  const last = num(biblio.last_page);
  const doi = cleanDoi(w.doi);
  const type = str(w.type);
  const isBook = type === 'book';
  const landing = str(loc.landing_page_url) ?? str(obj(w.open_access).oa_url);
  const authors = (Array.isArray(w.authorships) ? w.authorships : [])
    .map((a) => str(obj(obj(a).author).display_name))
    .filter((n): n is string => !!n)
    .map(toAuthor);
  return {
    id: str(w.id) ?? title,
    title,
    authors,
    year: num(w.publication_year),
    container: isBook ? undefined : str(obj(loc.source).display_name),
    publisher: isBook ? str(obj(loc.source).host_organization_name) : undefined,
    volume: str(biblio.volume),
    issue: str(biblio.issue),
    pages: first && last && first !== last ? `${first}–${last}` : first,
    doi,
    pdfUrl: str(obj(w.best_oa_location).pdf_url) ?? str(loc.pdf_url),
    url: landing,
    type,
  };
}

/** Odpověď hledání → práce; nečitelné položky se přeskočí. */
export const toWorks = (json: unknown): OpenAlexWork[] => {
  const results = obj(json).results;
  return (Array.isArray(results) ? results : []).flatMap((r) => toWork(r) ?? []);
};

export function toBiblio(work: OpenAlexWork): Biblio {
  // Odkaz na doi.org nic nového nepřináší, DOI už je v kartě zvlášť.
  const url = work.url && !/^https?:\/\/(dx\.)?doi\.org\//i.test(work.url) ? work.url : undefined;
  return { authors: work.authors, title: work.title, year: work.year, container: work.container, publisher: work.publisher, volume: work.volume, issue: work.issue, pages: work.pages, doi: work.doi, url };
}

const value = (b: Biblio, field: FillField) => (field === 'authors' ? authorsText(b.authors) : (b[field]?.trim() ?? ''));

/** Co v kartě chybí a OpenAlex to má; vyplněné hodnoty se nikdy nepřepisují. */
export function fillGaps(current: Biblio, found: Biblio): Gap[] {
  return FILL_FIELDS.flatMap((field) => {
    const had = value(current, field);
    const next = value(found, field);
    return !had && next ? [{ field, current: had, found: next }] : [];
  });
}

/** Karta s doplněnými vybranými poli (bez výběru všechna chybějící). */
export function applyGaps(current: Biblio, found: Biblio, only?: FillField[]): Biblio {
  const out: Biblio = { ...current };
  for (const { field } of fillGaps(current, found)) {
    if (only && !only.includes(field)) continue;
    if (field === 'authors') out.authors = found.authors;
    else out[field] = found[field];
  }
  return out;
}

const bigrams = (s: string) => {
  const text = flat(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const out = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i++) out.set(text.slice(i, i + 2), (out.get(text.slice(i, i + 2)) ?? 0) + 1);
  return out;
};

/** Podobnost názvů 0–1 (Dice na dvojicích znaků, bez ohledu na velikost písmen a interpunkci). */
export function similarity(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  let same = 0;
  let total = 0;
  for (const n of x.values()) total += n;
  for (const [k, n] of y) {
    total += n;
    same += Math.min(n, x.get(k) ?? 0);
  }
  return total ? (2 * same) / total : 0;
}

export const MATCH_MIN = 0.9;

/** Nejpodobnější práce k názvu z karty, jen při shodě alespoň 0,9. */
export function bestMatch(cardTitle: string, works: OpenAlexWork[]): OpenAlexWork | undefined {
  let best: OpenAlexWork | undefined;
  let top = 0;
  for (const w of works) {
    const s = similarity(cardTitle, w.title);
    if (s > top) [best, top] = [w, s];
  }
  return top >= MATCH_MIN ? best : undefined;
}

export const searchUrl = (q: string) => `${API}?search=${encodeURIComponent(q.trim())}&per-page=15&select=${SELECT}`;
export const doiUrl = (doi: string) => `${API}/doi:${encodeURIComponent(cleanDoi(doi) ?? '').replace(/%2F/gi, '/')}?select=${SELECT}`;
/** Čárka v hodnotě filtru by ho rozdělila, proto se z názvu odstraní. */
export const titleUrl = (title: string) => `${API}?filter=title.search:${encodeURIComponent(title.replace(/[,|]/g, ' ').trim())}&per-page=5&select=${SELECT}`;

/** Jen https odkazy z výsledků OpenAlex se smějí otevřít v prohlížeči. */
export const isWebUrl = (url: unknown): url is string => {
  try {
    return typeof url === 'string' && new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
};
