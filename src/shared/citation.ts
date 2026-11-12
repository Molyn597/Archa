import type { Author, Biblio, CitationStyle, DocType } from './types';

/** Kus citace; kurzíva se do schránky přenese jako <i>. */
export interface Part {
  text: string;
  italic?: boolean;
}
export type Lang = 'cs' | 'en';

const LABELS = {
  cs: { page: 's.', pages: 's.', noYear: 'b.r.', and: ' a ', own: 'vlastní překlad', apaOwn: 'vlastní překlad', from: 'Dostupné z:', cited: 'cit.', inIso: 'In:', inApa: 'In', edition: 'vyd.' },
  en: { page: 'p.', pages: 'pp.', noYear: 'n.d.', and: ' and ', own: 'own translation', apaOwn: 'my translation', from: 'Available from:', cited: 'cited', inIso: 'In:', inApa: 'In', edition: 'ed.' },
};

export const toPlain = (parts: Part[]) => parts.map((p) => p.text).join('');

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const toHtml = (parts: Part[]) => parts.map((p) => (p.italic ? `<i>${escapeHtml(p.text)}</i>` : escapeHtml(p.text))).join('');

/** [3] → „3“, [3,4,5] → „3–5“, [3,7,8] → „3, 7–8“. */
export function pageLabel(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const n of sorted) {
    const run = runs[runs.length - 1];
    if (run && n === run[run.length - 1] + 1) run.push(n);
    else runs.push([n]);
  }
  return runs.map((r) => (r.length > 1 ? `${r[0]}–${r[r.length - 1]}` : String(r[0]))).join(', ');
}

/** Čísla stran PDF → tištěná čísla; u článku a kapitoly podle prvního čísla v `b.pages`. */
export function printedPages(b: Biblio, type: DocType, pdfPages: number[]): number[] {
  const unique = [...new Set(pdfPages)].sort((a, b) => a - b);
  const m = type === 'article' || type === 'chapter' ? /^\s*(\d+)(?:\s*[–—-]\s*(\d+))?/.exec(b.pages ?? '') : null;
  if (!m) return unique;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : undefined;
  const printed = unique.map((p) => start + p - 1);
  return end !== undefined && printed.some((p) => p > end) ? unique : printed;
}

// ---------- Pomocné funkce ----------

const dashes = (s: string) => s.replace(/(\d)\s*-\s*(\d)/g, '$1–$2');
const clean = (s?: string) => (s ?? '').replace(/\s+/g, ' ').trim();
const ordinal = (n: number) => (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th');

/** Vydání: samotné číslo dostane tečku (cs) nebo řadovou příponu (en). */
function editionText(edition: string, lang: Lang) {
  const e = clean(edition);
  const label = LABELS[lang].edition;
  if (/^\d+$/.test(e)) return lang === 'cs' ? `${e}. ${label}` : `${e}${ordinal(Number(e))} ${label}`;
  return /(vyd|ed)\.?$/i.test(e) ? e : `${e} ${label}`;
}

/** Skládá citaci po kouscích; `stop` doplní tečku jen tam, kde ještě není. */
class Builder {
  parts: Part[] = [];
  push(text: string | undefined, italic = false) {
    if (text) this.parts.push({ text, italic });
    return this;
  }
  stop() {
    const last = toPlain(this.parts).trimEnd();
    if (last && !/[.?!…]$/.test(last)) this.push('.');
    return this;
  }
  sp() {
    const last = toPlain(this.parts);
    if (last && !last.endsWith(' ')) this.push(' ');
    return this;
  }
  /** Věta: text + tečka + mezera; prázdný text se přeskočí. */
  sentence(text: string | undefined, italic = false) {
    if (clean(text)) this.push(clean(text), italic).stop().sp();
    return this;
  }
  done() {
    return tidy(this.parts);
  }
}

/** Sloučí sousední kusy, zahodí dvojité mezery a zdvojené interpunkce. */
function tidy(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    let text = p.text.replace(/ {2,}/g, ' ').replace(/,(\s*,)+/g, ',').replace(/(?<!\.)\.\.(?!\.)/g, '.');
    if (out.length && toPlain(out).endsWith(' ')) text = text.replace(/^ +/, '');
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && !!last.italic === !!p.italic) last.text += text;
    else out.push({ text, italic: p.italic });
  }
  if (out.length) {
    out[0].text = out[0].text.trimStart();
    out[out.length - 1].text = out[out.length - 1].text.trimEnd();
  }
  return out.filter((p) => p.text);
}

const isPersonal = (a: Author) => Boolean(clean(a.given));

// ---------- ISO 690 ----------

function isoAuthors(authors: Author[], lang: Lang) {
  const name = (a: Author, first: boolean) => {
    const family = clean(a.family);
    if (!isPersonal(a)) return family;
    const upper = family.toLocaleUpperCase();
    return first ? `${upper}, ${clean(a.given)}` : `${clean(a.given)} ${upper}`;
  };
  if (authors.length > 3) return `${name(authors[0], true)} et al.`;
  const names = authors.map((a, i) => name(a, i === 0));
  return names.length > 1 ? names.slice(0, -1).join(', ') + LABELS[lang].and + names[names.length - 1] : (names[0] ?? '');
}

function iso(b: Biblio, type: DocType, lang: Lang, today?: string): Part[] {
  const L = LABELS[lang];
  const out = new Builder();
  const year = clean(b.year) || `[${L.noYear}]`;
  const authors = b.authors.filter((a) => clean(a.family) || clean(a.given));
  const piece = (...xs: (string | undefined)[]) => xs.map(clean).filter(Boolean);
  const imprint = (withYear = true) => {
    const place = clean(b.place);
    const publisher = clean(b.publisher);
    const head = place && publisher ? `${place}: ${publisher}` : place || publisher;
    return [head, withYear ? year : ''].filter(Boolean).join(', ');
  };
  const pages = b.pages ? `${L.page} ${dashes(clean(b.pages))}` : '';
  const link = () => {
    if (clean(b.doi)) out.push(`DOI: ${clean(b.doi).replace(/^(doi:|https?:\/\/(dx\.)?doi\.org\/)/i, '')}`);
    else if (clean(b.url)) out.push(`${L.from} ${clean(b.url)}`);
  };

  out.sentence(isoAuthors(authors, lang));
  if (type === 'article') {
    out.sentence(b.title);
    out.sentence(b.container, true);
    const volume = clean(b.volume) + (clean(b.issue) ? `(${clean(b.issue)})` : '');
    out.sentence([year, volume, pages].filter(Boolean).join(', '));
    link();
  } else if (type === 'chapter') {
    out.sentence(b.title);
    if (clean(b.container)) out.push(`${L.inIso} `).push(clean(b.container), true).stop().sp();
    out.sentence([imprint(), pages].filter(Boolean).join(', '));
    link();
  } else if (type === 'web') {
    if (clean(b.title)) out.push(clean(b.title), true).push(' [online]').stop().sp();
    const cited = today ? ` [${L.cited} ${today}]` : '';
    out.sentence(`${piece(b.publisher, year).join(', ')}${cited}`);
    if (clean(b.url)) out.push(`${L.from} ${clean(b.url)}`);
    else link();
  } else {
    out.sentence(b.title, true);
    if (clean(b.edition)) out.sentence(editionText(b.edition!, lang));
    out.sentence(imprint());
    link();
  }
  return out.done();
}

// ---------- APA 7 ----------

const initials = (given: string) =>
  clean(given)
    .split(' ')
    .map((word) => word.split('-').map((part) => `${Array.from(part)[0].toLocaleUpperCase()}.`).join('-'))
    .join(' ');

function apaAuthors(authors: Author[]) {
  const name = (a: Author) => (isPersonal(a) ? `${clean(a.family)}, ${initials(a.given)}` : clean(a.family));
  const names = authors.map(name);
  if (names.length > 20) return `${names.slice(0, 19).join(', ')}, . . . ${names[names.length - 1]}`;
  return names.length > 1 ? `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}` : (names[0] ?? '');
}

function apa(b: Biblio, type: DocType, lang: Lang): Part[] {
  const L = LABELS[lang];
  const out = new Builder();
  const authors = b.authors.filter((a) => clean(a.family) || clean(a.given));
  const year = `(${clean(b.year) || L.noYear})`;
  const italicTitle = type !== 'article' && type !== 'chapter';
  const pages = clean(b.pages) ? dashes(clean(b.pages)) : '';
  const pagesLabel = /[–,]/.test(pages) ? L.pages : L.page;
  const doiUrl = clean(b.doi) ? `https://doi.org/${clean(b.doi).replace(/^(doi:|https?:\/\/(dx\.)?doi\.org\/)/i, '')}` : '';
  const link = doiUrl || clean(b.url);

  // Název (u knihy s vydáním v závorce); bez autora jde na jeho místo.
  const title = (italic: boolean) => {
    if (!clean(b.title)) return;
    out.push(clean(b.title), italic);
    if (type !== 'article' && type !== 'chapter' && type !== 'web' && clean(b.edition)) out.push(` (${editionText(b.edition!, lang)})`);
    out.stop().sp();
  };
  if (authors.length) out.sentence(apaAuthors(authors));
  else title(italicTitle);
  out.sentence(year);

  if (type === 'article') {
    if (authors.length) out.sentence(b.title);
    if (clean(b.container)) {
      out.push(clean(b.container), true);
      if (clean(b.volume)) out.push(', ').push(clean(b.volume), true);
      if (clean(b.issue)) out.push(`(${clean(b.issue)})`);
      if (pages) out.push(`, ${pages}`);
      out.stop().sp();
    }
  } else if (type === 'chapter') {
    if (authors.length) out.sentence(b.title);
    if (clean(b.container)) {
      out.push(`${L.inApa} `).push(clean(b.container), true);
      if (pages) out.push(` (${pagesLabel} ${pages})`);
      out.stop().sp();
    }
    out.sentence(b.publisher);
  } else if (type === 'web') {
    if (authors.length) title(true);
    // Vydavatel shodný s autorem se neopakuje.
    if (clean(b.publisher) !== clean(authors[0]?.family)) out.sentence(b.publisher);
  } else {
    if (authors.length) title(true);
    out.sentence(b.publisher);
  }
  if (link) out.push(link);
  return out.done();
}

export function reference(b: Biblio, type: DocType, style: CitationStyle, lang: Lang, today?: string): Part[] {
  return style === 'apa7' ? apa(b, type, lang) : iso(b, type, lang, today);
}

// ---------- Citace v textu ----------

export function inText(b: Biblio, style: CitationStyle, lang: Lang, pages: number[], ownTranslation: boolean): string {
  const L = LABELS[lang];
  const apaStyle = style === 'apa7';
  const families = b.authors.map((a) => clean(a.family)).filter(Boolean);
  let who: string;
  if (families.length === 0) {
    const words = clean(b.title).split(' ').filter(Boolean);
    who = words.slice(0, 3).join(' ') + (words.length > 3 ? '…' : '');
  } else if (families.length === 1) who = families[0];
  else if (families.length === 2) who = apaStyle ? `${families[0]} & ${families[1]}` : families.join(L.and);
  else who = `${families[0]} et al.`;

  // APA v angličtině: „pp.“ pro víc stran; ISO a čeština mají jeden tvar.
  const pageWord = apaStyle && lang === 'en' && pages.length > 1 ? L.pages : L.page;
  const parts = [who, clean(b.year) || L.noYear, pages.length ? `${pageWord} ${pageLabel(pages)}` : '', ownTranslation ? (apaStyle ? L.apaOwn : L.own) : ''];
  return `(${parts.filter(Boolean).join(', ')})`;
}

/** Zkrácená citace do řádku seznamu: „Novák, 2020“, „Novák a Svoboda, 2020“, od tří autorů „Novák a kol., 2020“; chybějící část se vynechá. */
export function shortCite(b: Biblio, lang: Lang): string {
  const families = b.authors.map((a) => clean(a.family)).filter(Boolean);
  const author = families.length > 2 ? `${families[0]} ${lang === 'cs' ? 'a kol.' : 'et al.'}` : families.join(LABELS[lang].and);
  return [author, clean(b.year)].filter(Boolean).join(', ');
}
