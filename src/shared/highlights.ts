import type { Highlight, HighlightColor } from './types';

export const HIGHLIGHT_COLORS: HighlightColor[] = ['yellow', 'green', 'blue', 'pink'];

/** Místo v textech prvků: index prvku a znak v jeho textu. */
export type Point = [index: number, offset: number];

const space = /\s/;

/** Text bez mezer a mapa z jeho znaků zpět na místa v původních textech. */
function squeeze(texts: string[]) {
  let flat = '';
  const map: Point[] = [];
  texts.forEach((text, i) => {
    for (let o = 0; o < text.length; o++) {
      if (space.test(text[o])) continue;
      flat += text[o];
      map.push([i, o]);
    }
  });
  return { flat, map };
}

const strip = (text: string) => text.replace(/\s+/g, '');

/** Pozice začátku výběru v textu bez mezer (do `hint` zvýraznění). */
export const squeezedOffset = (text: string, offset: number) => strip(text.slice(0, offset)).length;

/**
 * Dohledá citát v textech segmentů (v pořadí od prvního). Mezery se ignorují (seznamy a tabulky je v různých
 * zobrazeních mají jinak); z víc výskytů vyhraje ten nejblíž `hint` v prvním textu. Vrací začátek a konec (výlučně).
 */
export function locate(texts: string[], quote: string, hint = 0): { start: Point; end: Point } | null {
  const needle = strip(quote);
  if (!needle || !texts.length) return null;
  const { flat, map } = squeeze(texts);
  let best = -1;
  for (let at = flat.indexOf(needle); at >= 0; at = flat.indexOf(needle, at + 1)) {
    if (best < 0 || Math.abs(at - hint) < Math.abs(best - hint)) best = at;
  }
  if (best < 0) return null;
  const last = map[best + needle.length - 1];
  return { start: map[best], end: [last[0], last[1] + 1] };
}

/** Text výběru z textů segmentů mezi dvěma místy (mezi segmenty nový řádek). */
export function sliceTexts(texts: string[], start: Point, end: Point) {
  if (start[0] === end[0]) return texts[start[0]].slice(start[1], end[1]);
  const parts = [texts[start[0]].slice(start[1]), ...texts.slice(start[0] + 1, end[0]), texts[end[0]].slice(0, end[1])];
  return parts.join('\n');
}

/** Zvýraznění v pořadí dokumentu (podle segmentu a místa v něm). */
export const sortHighlights = (list: Highlight[], order: number[]) => {
  const pos = new Map(order.map((id, i) => [id, i]));
  return [...list].sort((a, b) => (pos.get(a.from) ?? 0) - (pos.get(b.from) ?? 0) || a.hint - b.hint || a.createdAt - b.createdAt);
};

/** Načtený seznam z disku: jen platné položky (poškozený soubor nesmí shodit detail). */
export function cleanHighlights(raw: unknown): Highlight[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (h): h is Highlight =>
      !!h &&
      typeof h.id === 'string' &&
      (h.side === 'source' || h.side === 'target') &&
      Number.isInteger(h.from) &&
      Number.isInteger(h.to) &&
      typeof h.quote === 'string' &&
      !!h.quote.trim() &&
      HIGHLIGHT_COLORS.includes(h.color),
  ).map((h) => ({ ...h, hint: Number.isFinite(h.hint) ? h.hint : 0, note: typeof h.note === 'string' && h.note.trim() ? h.note : undefined }));
}
