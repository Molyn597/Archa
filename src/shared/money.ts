const SYMBOLS: Record<string, string> = { 'Kč': 'CZK', '€': 'EUR', '$': 'USD', '£': 'GBP' };

/**
 * Částka z textu: „12 500,50 Kč“, „12.500,50 CZK“, „€ 1,234.56“, „1 234 EUR“, „$99.90“.
 * Desetinný oddělovač je poslední z `,` a `.`; samotný oddělovač se třemi číslicemi za sebou je oddělovač tisíců.
 */
export function parseMoney(text: string): { value: number; currency?: string } | undefined {
  const s = text.replace(/[\s  ]+/g, ' ').trim();
  const num = s.match(/-?\d[\d .,]*\d|-?\d/)?.[0];
  if (!num) return undefined;
  const rest = (s.slice(0, s.indexOf(num)) + ' ' + s.slice(s.indexOf(num) + num.length)).trim();
  const raw = rest.match(/Kč|€|\$|£|[A-Za-z]{3}\b/)?.[0];
  const currency = raw && (SYMBOLS[raw] ?? raw.toUpperCase());

  const compact = num.replace(/ /g, '');
  const sep = Math.max(compact.lastIndexOf(','), compact.lastIndexOf('.'));
  let digits = compact;
  if (sep >= 0) {
    const head = compact.slice(0, sep);
    const tail = compact.slice(sep + 1);
    const other = /[,.]/.test(head);
    // Jediný oddělovač s přesně třemi číslicemi za sebou je oddělovač tisíců (kromě „0,125“).
    const thousands = head.includes(compact[sep]) || (!other && tail.length === 3 && !/^-?0$/.test(head));
    digits = thousands ? head + tail : head.replace(/[,.]/g, '') + '.' + tail;
  }
  const value = Number(digits);
  if (!Number.isFinite(value)) return undefined;
  return { value, ...(currency && { currency }) };
}

/** Částka pro zobrazení v dané lokalizaci; bez měny jen číslo na dvě desetinná místa, bez hodnoty pomlčka. `trimWhole`: celá částka bez desetinných míst (velká čísla). */
export function formatMoney(value: number | undefined, currency: string, locale: string, trimWhole = false): string {
  if (value === undefined) return '–';
  const whole = trimWhole && Number.isInteger(value);
  const plain = whole ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  try {
    return new Intl.NumberFormat(locale, currency ? { style: 'currency', currency, ...(whole && plain) } : plain).format(value);
  } catch {
    // Neznámý kód měny.
    return `${new Intl.NumberFormat(locale, plain).format(value)} ${currency}`;
  }
}
