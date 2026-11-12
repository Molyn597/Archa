import { isoDay } from './invoices';
import { flat } from './risks';
import type { DocumentCard } from './types';

/** Odstavec dokumentu; `seg` = id segmentu (odkaz zpět do dokumentu), `heading` = segment typu nadpis. */
export interface Para {
  text: string;
  seg?: number;
  heading?: boolean;
}
export interface DiffPart {
  text: string;
  kind: 'same' | 'ins' | 'del';
}
export interface DiffRow {
  kind: 'same' | 'chg' | 'add' | 'del';
  a?: string;
  b?: string;
  aParts?: DiffPart[];
  bParts?: DiffPart[];
  aSeg?: number;
  bSeg?: number;
}
/** Jeden článek smlouvy; text před prvním nadpisem má prázdný `title`. */
export interface DiffSection {
  title: string;
  rows: DiffRow[];
}

/** Nad tolik odstavců (součin velikostí) se nepočítá LCS, jen shodný začátek a konec a zbytek po pozicích. */
const MAX_CELLS = 4_000_000;
const MAX_TOKEN_CELLS = 1_000_000;
/** Kolik dalších odstavců B se zkouší jako protějšek změněného odstavce A. */
const GAP_WINDOW = 40;
/** Od této podobnosti (Jaccard slov) jde o změněný odstavec, ne o odebraný a nový. */
const SIMILAR = 0.5;
const HEADING_MAX = 100;

const ROMAN: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
function roman(s: string) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const v = ROMAN[s[i]], next = ROMAN[s[i + 1]] ?? 0;
    n += v < next ? -v : v;
  }
  return n;
}
const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : roman(s.toUpperCase()));

// „Čl. III“, „Článek 3“, „čl. 3.“, „Article 3“, „§ 3“ (i s textem článku za nadpisem, když ho PDF slepilo).
const ARTICLE = /^(?:čl(?:ánek|\.)?|clanek|article|art\.)\s*([IVXLCDM]+|\d+)\b\.?\s*[-–—:.]?\s*/iu;
const PARAGRAPH = /^§\s*(\d+)\b\.?\s*[-–—:.]?\s*/;
// „III. Doba nájmu“, „3. Doba nájmu“: číslo, tečka a krátký název bez koncové interpunkce.
const NUMBERED = /^([IVXLCDM]+|\d{1,2})\.\s+(\p{Lu}[^.;:!?]*)$/u;

interface Heading {
  title: string;
  /** Číslo článku (arabsky), když ho nadpis má. */
  n?: number;
  /** Název článku bez čísla (normalizovaný), když ho nadpis má. */
  name?: string;
  /** Odstavec obsahuje i text článku (nadpis slepený s textem): zůstane i jako řádek. */
  body?: boolean;
}

const nameKey = (s: string) => flat(s).replace(/[^\p{L}\p{N} ]/gu, '').trim();

/** Nadpis článku, nebo undefined pro běžný odstavec. */
export function headingOf(p: Para): Heading | undefined {
  const text = p.text.trim();
  const m = text.match(ARTICLE) ?? text.match(PARAGRAPH);
  if (m) {
    const rest = text.slice(m[0].length);
    if (text.length <= HEADING_MAX) return { title: text, n: num(m[1]), ...(nameKey(rest) && { name: nameKey(rest) }) };
    return { title: text.slice(0, m[0].length).trim().replace(/[-–—:.]$/, '').trim(), n: num(m[1]), body: true };
  }
  if (text.length > HEADING_MAX) return undefined;
  const n = text.match(NUMBERED);
  if (n && n[2].split(/\s+/).length <= 8) return { title: text, n: num(n[1]), name: nameKey(n[2]) };
  if (p.heading) return { title: text, name: nameKey(text) };
  return undefined;
}

// Číslo strany nebo záhlaví „Strana 2 z 5“ / „- 3 -“: s textem smlouvy nesouvisí.
const PAGE_NO = /^(?:(?:strana|str\.|page)\s*)?[-–]?\s*\d+\s*[-–]?(?:\s*(?:\/|z|of)\s*\d+)?$/i;

interface Section {
  head?: Heading;
  /** Odstavec s nadpisem (jen samostatný nadpis, ne slepený s textem). */
  headPara?: Para;
  paras: Para[];
}

function sectionsOf(paras: Para[]): Section[] {
  const out: Section[] = [{ paras: [] }];
  for (const p of paras) {
    if (!p.text.trim() || PAGE_NO.test(p.text.trim())) continue;
    const head = headingOf(p);
    if (head) out.push(head.body ? { head, paras: [p] } : { head, headPara: p, paras: [] });
    else out[out.length - 1].paras.push(p);
  }
  return out.filter((s, i) => i > 0 || s.paras.length);
}

/** Délka nejdelší společné podposloupnosti pro každou dvojici přípon (tabulka (n+1)×(m+1) po řádcích). */
function lcsTable(n: number, m: number, eq: (i: number, j: number) => boolean) {
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) t[i * w + j] = eq(i, j) ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  return (i: number, j: number) => t[i * w + j];
}

/** Dvojice shodných indexů [i, j] ve vzestupném pořadí. */
function matchPairs(n: number, m: number, eq: (i: number, j: number) => boolean, maxCells: number): [number, number][] {
  const pairs: [number, number][] = [];
  let start = 0;
  while (start < n && start < m && eq(start, start)) pairs.push([start, start]), start++;
  let endA = n, endB = m;
  const tail: [number, number][] = [];
  while (endA > start && endB > start && eq(endA - 1, endB - 1)) tail.unshift([--endA, --endB]);
  const [h, w] = [endA - start, endB - start];
  if (h && w && h * w <= maxCells) {
    const len = lcsTable(h, w, (i, j) => eq(start + i, start + j));
    for (let i = 0, j = 0; i < h && j < w; ) {
      if (eq(start + i, start + j)) pairs.push([start + i++, start + j++]);
      else if (len(i + 1, j) >= len(i, j + 1)) i++;
      else j++;
    }
  }
  return [...pairs, ...tail];
}

const words = (s: string) => new Set(flat(s).match(/[\p{L}\p{N}]+/gu) ?? []);
function similarity(a: string, b: string) {
  const [x, y] = [words(a), words(b)];
  if (!x.size && !y.size) return 1;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / (x.size + y.size - common);
}

// Číslo s mezerami mezi tisíci („4 500“) je jedno slovo, ať se změna ceny ukáže celá.
const TOKEN = /\s+|\p{N}+(?:[ \u00a0\u202f]\p{N}{3}(?!\p{N}))*(?:[.,]\p{N}+)?|[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu;
const tokenKey = (s: string) => (/^\s+$/.test(s) ? ' ' : flat(s));

function merge(parts: DiffPart[]): DiffPart[] {
  // Mezera mezi dvěma změněnými slovy patří ke změně: „<del>3 měsíce</del>“, ne „<del>3</del> <del>měsíce</del>“.
  const fixed = parts.map((p, i) =>
    p.kind === 'same' && /^\s+$/.test(p.text) && parts[i - 1] && parts[i - 1].kind !== 'same' && parts[i - 1].kind === parts[i + 1]?.kind ? { ...p, kind: parts[i - 1].kind } : p,
  );
  const out: DiffPart[] = [];
  for (const p of fixed) {
    const last = out[out.length - 1];
    if (last?.kind === p.kind) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

/** Rozdíl po slovech: části textu A (same/del) a textu B (same/ins). */
export function wordDiff(a: string, b: string): { aParts: DiffPart[]; bParts: DiffPart[] } {
  const [ta, tb] = [a.match(TOKEN) ?? [], b.match(TOKEN) ?? []];
  const [ka, kb] = [ta.map(tokenKey), tb.map(tokenKey)];
  const pairs = matchPairs(ta.length, tb.length, (i, j) => ka[i] === kb[j], MAX_TOKEN_CELLS);
  const aParts: DiffPart[] = [], bParts: DiffPart[] = [];
  let [i, j] = [0, 0];
  for (const [pi, pj] of [...pairs, [ta.length, tb.length] as [number, number]]) {
    for (; i < pi; i++) aParts.push({ text: ta[i], kind: 'del' });
    for (; j < pj; j++) bParts.push({ text: tb[j], kind: 'ins' });
    if (pi < ta.length) aParts.push({ text: ta[i++], kind: 'same' }), bParts.push({ text: tb[j++], kind: 'same' });
  }
  return { aParts: merge(aParts), bParts: merge(bParts) };
}

const same = (a: Para, b: Para): DiffRow => ({ kind: 'same', a: a.text, b: b.text, ...seg('a', a), ...seg('b', b) });
const seg = (side: 'a' | 'b', p?: Para) => (p?.seg !== undefined ? { [`${side}Seg`]: p.seg } : {});
const del = (a: Para): DiffRow => ({ kind: 'del', a: a.text, ...seg('a', a) });
const add = (b: Para): DiffRow => ({ kind: 'add', b: b.text, ...seg('b', b) });
const chg = (a: Para, b: Para): DiffRow => ({ kind: 'chg', a: a.text, b: b.text, ...wordDiff(a.text, b.text), ...seg('a', a), ...seg('b', b) });

/** Neshodné odstavce mezi dvěma shodnými: podobné dvojice jsou změna, zbytek odebráno / nové (pořadí zůstane). */
function gapRows(as: Para[], bs: Para[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let k = 0;
  for (const a of as) {
    let best = -1, score = SIMILAR;
    for (let q = k; q < Math.min(bs.length, k + GAP_WINDOW); q++) {
      const s = similarity(a.text, bs[q].text);
      if (s >= score) [best, score] = [q, s];
    }
    if (best < 0) {
      rows.push(del(a));
      continue;
    }
    for (; k < best; k++) rows.push(add(bs[k]));
    rows.push(chg(a, bs[k++]));
  }
  for (; k < bs.length; k++) rows.push(add(bs[k]));
  return rows;
}

function paraRows(as: Para[], bs: Para[]): DiffRow[] {
  const [ka, kb] = [as.map((p) => flat(p.text)), bs.map((p) => flat(p.text))];
  const pairs = matchPairs(as.length, bs.length, (i, j) => ka[i] === kb[j], MAX_CELLS);
  const rows: DiffRow[] = [];
  let [i, j] = [0, 0];
  for (const [pi, pj] of [...pairs, [as.length, bs.length] as [number, number]]) {
    // Bez LCS (příliš velký dokument) se zbytek páruje po pozicích jako změna nebo odebráno/nové.
    rows.push(...gapRows(as.slice(i, pi), bs.slice(j, pj)));
    if (pi < as.length) rows.push(same(as[pi], bs[pj]));
    [i, j] = [pi + 1, pj + 1];
  }
  return rows;
}

/** Články A a B ke spárování: nejdřív podle názvu (přečíslování nevadí), pak podle čísla; úvod s úvodem. */
function pairSections(as: Section[], bs: Section[]) {
  const partner = new Map<number, number>();
  const used = new Set<number>();
  const link = (test: (a: Section, b: Section) => boolean) =>
    as.forEach((a, i) => {
      if (partner.has(i)) return;
      const j = bs.findIndex((b, j) => !used.has(j) && test(a, b));
      if (j >= 0) partner.set(i, j), used.add(j);
    });
  link((a, b) => !a.head && !b.head);
  link((a, b) => !!a.head?.name && a.head.name === b.head?.name);
  link((a, b) => a.head?.n !== undefined && a.head.n === b.head?.n && !(a.head.name && b.head?.name && similarity(a.head.name, b.head.name) < SIMILAR));
  link((a, b) => !!a.head && !!b.head && flat(a.head.title) === flat(b.head.title));
  return partner;
}

/** Porovnání dvou verzí smlouvy po článcích a odstavcích; formátování (mezery, uvozovky, velikost písmen) se ignoruje. */
export function diffContracts(a: Para[], b: Para[]): DiffSection[] {
  const [as, bs] = [sectionsOf(a), sectionsOf(b)];
  const partner = pairSections(as, bs);
  const byB = new Map([...partner].map(([i, j]) => [j, i]));
  // Odebrané články A se zařadí za článek B, se kterým je spárovaný nejbližší předchozí článek A.
  const after = new Map<number, number[]>();
  as.forEach((_, i) => {
    if (partner.has(i)) return;
    let p = i - 1;
    while (p >= 0 && !partner.has(p)) p--;
    const key = p < 0 ? -1 : partner.get(p)!;
    after.set(key, [...(after.get(key) ?? []), i]);
  });
  const out: DiffSection[] = [];
  // Článek jen s nadpisem: jako řádek se ukáže aspoň nadpis, ať se změna započítá.
  const whole = (s: Section) => (s.paras.length || !s.headPara ? s.paras : [s.headPara]);
  const removed = (key: number) => (after.get(key) ?? []).forEach((i) => out.push({ title: as[i].head?.title ?? '', rows: whole(as[i]).map(del) }));
  removed(-1);
  bs.forEach((s, j) => {
    const i = byB.get(j);
    const title = s.head?.title ?? (i !== undefined ? as[i].head?.title : undefined) ?? '';
    if (i === undefined) out.push({ title, rows: whole(s).map(add) });
    else {
      // Jiný název článku je změna; samotné přečíslování ne.
      const [ha, hb] = [as[i].headPara, s.headPara];
      const label = (x: Section) => x.head?.name ?? flat(x.head?.title ?? '');
      const renamed = ha && hb && label(as[i]) !== label(s) ? [chg(ha, hb)] : [];
      out.push({ title, rows: [...renamed, ...paraRows(as[i].paras, s.paras)] });
    }
    removed(j);
  });
  return out.filter((s) => s.rows.length || s.title);
}

export const changeCount = (sections: DiffSection[]) => sections.reduce((n, s) => n + s.rows.filter((r) => r.kind !== 'same').length, 0);

/** Jen změněné řádky jako text pro prompt („Čl. III: – staré / + nové“), zkrácený na `limit` znaků. */
export function changesText(sections: DiffSection[], limit: number) {
  let out = '';
  for (const s of sections)
    for (const r of s.rows) {
      if (r.kind === 'same') continue;
      const body = r.kind === 'chg' ? `– ${r.a} / + ${r.b}` : r.kind === 'add' ? `+ ${r.b}` : `– ${r.a}`;
      const line = `${s.title ? `${s.title}: ` : ''}${body}\n`;
      if (out.length + line.length > limit) return (out + line).slice(0, limit);
      out += line;
    }
  return out.trimEnd();
}

/** Datum verze: z karty (vystaveno / platnost od), jinak přidání dokumentu (RRRR-MM-DD). */
export function versionDate(createdAt: number, card?: DocumentCard | null) {
  const d = card?.facts?.issued ?? card?.facts?.validFrom;
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : isoDay(new Date(createdAt));
}

/** true, když je A novější než B a strany se mají prohodit (starší vlevo). */
export const isNewer = (a: { createdAt: number; card?: DocumentCard | null }, b: { createdAt: number; card?: DocumentCard | null }) => {
  const [da, db] = [versionDate(a.createdAt, a.card), versionDate(b.createdAt, b.card)];
  return da !== db ? da > db : a.createdAt > b.createdAt;
};
