import { fold } from './folders';
import type { DocumentCard, Job, Library } from './types';

/** `same` = stejný soubor (otisk), `similar` = nejspíš stejný dokument (název, autor + rok) – jen k posouzení. */
export interface DuplicateGroup {
  kind: 'same' | 'similar';
  /** Dokumenty skupiny; první je návrh, který ponechat. */
  ids: string[];
}

const words = (s: string) => fold(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// Krátké názvy („Faktura“, „Smlouva“) by spojovaly nesouvisející dokumenty.
const MIN_TITLE = 12;
// Přípona jazyka v názvu souboru („… cs“, „…_en“) neodlišuje dokument.
const baseName = (name: string) => words(name).replace(/ (cs|en|de|sk|cz)$/, '');

const firstSurname = (card?: DocumentCard) => words(card?.biblio.authors[0]?.family ?? '');

function overlap(a: string, b: string) {
  const x = new Set(a.split(' ').filter((w) => w.length > 2));
  const y = new Set(b.split(' ').filter((w) => w.length > 2));
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / Math.min(x.size, y.size);
}

/** Dokumenty `a` a `b` jsou nejspíš totéž: stejný název karty, stejný název souboru, nebo první autor + rok + podobný název. */
export function similar(a: Job, b: Job, cards: Record<string, DocumentCard>) {
  const ca = cards[a.id];
  const cb = cards[b.id];
  const ta = ca ? words(ca.biblio.title) : '';
  const tb = cb ? words(cb.biblio.title) : '';
  if (ta.length >= MIN_TITLE && ta === tb) return true;
  const na = baseName(a.name);
  if (na.length >= MIN_TITLE && na === baseName(b.name)) return true;
  const sa = firstSurname(ca);
  return !!sa && sa === firstSurname(cb) && !!ca?.biblio.year && ca.biblio.year === cb?.biblio.year && overlap(ta, tb) >= 0.6;
}

/** Pořadí pro ponechání: hotový > má kartu > zařazený ve složce > nejstarší. */
export function keepOrder(jobs: Job[], cards: Record<string, DocumentCard>, library: Pick<Library, 'assign'>): Job[] {
  const score = (j: Job) => (j.status === 'done' ? 4 : 0) + (cards[j.id] ? 2 : 0) + (library.assign[j.id] ? 1 : 0);
  return [...jobs].sort((a, b) => score(b) - score(a) || a.createdAt - b.createdAt);
}

/**
 * Skupiny duplicit mezi dokumenty (bez koše). Shodné podle otisku souboru; podobné jen mezi dokumenty,
 * které ještě nejsou ve stejné shodné skupině. Každá skupina má aspoň dva dokumenty.
 */
export function duplicateGroups(jobs: Job[], cards: Record<string, DocumentCard>, library: Pick<Library, 'assign'>): DuplicateGroup[] {
  const live = jobs.filter((j) => !j.trashedAt);
  const byHash = new Map<string, Job[]>();
  for (const j of live) if (j.inputHash) byHash.set(j.inputHash, [...(byHash.get(j.inputHash) ?? []), j]);
  const groups: DuplicateGroup[] = [];
  for (const list of byHash.values()) if (list.length > 1) groups.push({ kind: 'same', ids: keepOrder(list, cards, library).map((j) => j.id) });

  // Podobné: shodnou skupinu zastupuje jeden dokument, ať se tatáž trojice neukáže dvakrát.
  const inSame = new Set(groups.flatMap((g) => g.ids.slice(1)));
  const reps = live.filter((j) => !inSame.has(j.id));
  const parent = new Map(reps.map((j) => [j.id, j.id]));
  const root = (id: string): string => (parent.get(id) === id ? id : root(parent.get(id)!));
  for (let i = 0; i < reps.length; i++)
    for (let k = i + 1; k < reps.length; k++) {
      const a = reps[i]!;
      const b = reps[k]!;
      if (a.inputHash && a.inputHash === b.inputHash) continue;
      if (similar(a, b, cards)) parent.set(root(b.id), root(a.id));
    }
  const clusters = new Map<string, Job[]>();
  for (const j of reps) clusters.set(root(j.id), [...(clusters.get(root(j.id)) ?? []), j]);
  for (const list of clusters.values()) if (list.length > 1) groups.push({ kind: 'similar', ids: keepOrder(list, cards, library).map((j) => j.id) });
  return groups;
}

/** Ponechaný dokument bez složky převezme složku prvního odstraňovaného, který nějakou má. */
export function adoptFolder(library: Library, keep: string, drop: string[]) {
  if (library.assign[keep]) return;
  const from = drop.find((id) => library.assign[id]);
  if (from) library.assign[keep] = { ...library.assign[from]! };
}
