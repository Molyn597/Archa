// Délky typu „3 měsíce“, „90 days“, „6 Wochen“ a posun data o ně.

export interface Duration {
  days?: number;
  months?: number;
}

/** Nalezený údaj v textu: pozice, původní znění a hodnota. */
export interface FoundDuration extends Duration {
  index: number;
  end: number;
  text: string;
}

const WORDS: Record<string, number> = {
  jeden: 1, jedna: 1, jedno: 1, jednoho: 1, dva: 2, dvě: 2, dvou: 2, tři: 3, tří: 3, čtyři: 4, čtyř: 4, pět: 5, pěti: 5, šest: 6, šesti: 6,
  sedm: 7, sedmi: 7, osm: 8, osmi: 8, devět: 9, devíti: 9, deset: 10, deseti: 10, jedenáct: 11, dvanáct: 12, dvanácti: 12,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  ein: 1, eine: 1, einen: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, zwölf: 12,
};

// Jednotky: [vzor, násobek, druh].
const UNITS: [string, number, 'days' | 'months'][] = [
  ['d(?:en|ny|ní|nů|ne|nu)|days?|tage?n?', 1, 'days'],
  ['týd(?:en|ny|nů|ne|nu)|weeks?|wochen?', 7, 'days'],
  ['měsíc(?:e|ů|i)?|months?|monat(?:e|en)?', 1, 'months'],
  ['rok(?:y|u|ů)?|let|years?|jahr(?:e|en)?', 12, 'months'],
];

const NUMBER = `\\d+|${Object.keys(WORDS).join('|')}`;
const UNIT_RE = new RegExp(`(?<![\\p{L}\\d])(${NUMBER})[\\s-]*(${UNITS.map(([p]) => `(${p})`).join('|')})(?![\\p{L}])`, 'giu');

/** Všechny údaje o délce v textu v pořadí výskytu. */
export function findDurations(text: string): FoundDuration[] {
  const found: FoundDuration[] = [];
  for (const m of text.matchAll(UNIT_RE)) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : WORDS[m[1].toLowerCase()];
    const unit = UNITS[[3, 4, 5, 6].findIndex((i) => m[i] !== undefined)];
    if (!n || !unit) continue;
    found.push({ [unit[2]]: n * unit[1], index: m.index!, end: m.index! + m[0].length, text: m[0] });
  }
  return found;
}

/** První údaj o délce v textu; roky se převedou na měsíce, týdny na dny. */
export function parseDuration(text: string): Duration | undefined {
  const first = findDurations(text)[0];
  return first && { ...(first.days !== undefined && { days: first.days }), ...(first.months !== undefined && { months: first.months }) };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Posune datum RRRR-MM-DD o délku (sign 1 = dopředu, -1 = zpět); měsíce kalendářně, konec měsíce se ořízne. */
export function addDuration(iso: string, d: Duration, sign: 1 | -1 = 1): string {
  const [y, m, day] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) + sign * (d.months ?? 0);
  const year = Math.floor(total / 12);
  const month = total % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const out = new Date(Date.UTC(year, month, Math.min(day, last) + sign * (d.days ?? 0)));
  return `${out.getUTCFullYear()}-${pad(out.getUTCMonth() + 1)}-${pad(out.getUTCDate())}`;
}
