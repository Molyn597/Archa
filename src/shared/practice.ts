import type { PracticeCard, PracticeSet, Review } from './types';

/** Leitner: po kolika dnech se položka v přihrádce 0–5 vrací. */
export const INTERVALS = [1, 2, 4, 8, 16, 32];
const TOP = INTERVALS.length - 1;

/** Den RRRR-MM-DD posunutý o `days` (počítá se v UTC, ať změna času nic neposune). */
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Nová položka je v přihrádce 0; neumím = zpět do 0 na zítra, umím = o přihrádku výš. */
export function grade(review: Review | undefined, known: boolean, today: string): Review {
  if (!known) return { box: 0, due: addDays(today, INTERVALS[0]) };
  const box = Math.min((review?.box ?? 0) + 1, TOP);
  return { box, due: addDays(today, INTERVALS[box]) };
}

const isDue = (item: { review?: Review }, today: string) => !item.review || item.review.due <= today;

/** Položky k zopakování dnes (nové i po termínu), nejdřív ty z nižších přihrádek; jinak v pořadí sady. */
export function dueFirst<T extends { review?: Review }>(items: T[], today: string): T[] {
  return items.filter((i) => isDue(i, today)).sort((a, b) => (a.review?.box ?? 0) - (b.review?.box ?? 0));
}

/** Kartičky sady k zopakování dnes. */
export const dueItems = (set: PracticeSet, today: string): PracticeCard[] => dueFirst(set.cards, today);

/** Kartičky k zopakování dnes ve všech sadách. */
export const dueCount = (sets: PracticeSet[], today: string) => sets.reduce((n, s) => n + dueItems(s, today).length, 0);

/** Zdroje rozsahu se od vytvoření sady změnily (přibyly nebo ubyly). */
export function sourcesChanged(set: PracticeSet, current: string[]) {
  const now = new Set(current);
  return now.size !== new Set(set.sources).size || set.sources.some((id) => !now.has(id));
}

/** FNV-1a: číslo z textu (semínko míchání). */
function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Zamíchá možnosti otázky vždy stejně pro stejné semínko (modely dávají správnou odpověď často první). */
export function shuffleOptions(options: string[], answer: number, seed: string): { options: string[]; answer: number } {
  let s = hash(seed);
  // mulberry32
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const order = options.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return { options: order.map((i) => options[i]), answer: order.indexOf(answer) };
}
