import type { Segment } from './types';

/** Mezery a uvozovky sjednocené, aby šla citace najít i po vytažení textu z PDF. */
export const flat = (s: string) =>
  s
    .replace(/[„“”"«»]/g, '"')
    .replace(/[‚‘’']/g, "'")
    .replace(/[­]/g, '')
    .replace(/-\s*\n\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** Nejméně tolik znaků začátku citace musí sedět na konec segmentu, aby šlo o citaci přesahující do dalšího. */
const MIN_HEAD = 20;

/** Segment s citací: první, který ji celou obsahuje; jinak ten, na jehož konci citace začíná (přesahuje do dalšího segmentu). */
export function findQuoteSegment(segments: Segment[], quote: string): Segment | undefined {
  const q = flat(quote);
  if (!q) return undefined;
  const usable = segments.filter((s) => !s.layoutOnly).map((s) => ({ s, text: flat(s.source) }));
  const startsHere = (text: string) => {
    for (let k = Math.min(q.length, text.length); k >= MIN_HEAD; k--) if (text.endsWith(q.slice(0, k))) return true;
    return false;
  };
  return (usable.find((u) => u.text.includes(q)) ?? usable.find((u) => startsHere(u.text)))?.s;
}
