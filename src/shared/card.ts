import type { Author, Biblio, DocFacts, DocType } from './types';

export const DOC_TYPES: DocType[] = ['article', 'book', 'chapter', 'thesis', 'report', 'contract', 'invoice', 'manual', 'letter', 'law', 'web', 'other'];

/** Textová pole bibliografie ve vykreslovaném pořadí. */
export const BIBLIO_FIELDS = ['title', 'year', 'container', 'publisher', 'place', 'edition', 'volume', 'issue', 'pages', 'doi', 'url'] as const satisfies readonly (keyof Biblio)[];

/** Textová pole faktů faktury / smlouvy v pořadí zobrazení (parties se řeší zvlášť). */
export const FACT_FIELDS = [
  'subject', 'number', 'supplier', 'supplierId', 'supplierVat', 'customer', 'customerId', 'customerVat',
  'net', 'vat', 'amount', 'vs', 'issued', 'due', 'validFrom', 'validTo', 'period', 'notice', 'autoRenewal', 'penalty', 'law',
] as const satisfies readonly (keyof DocFacts)[];

type FactField = (typeof FACT_FIELDS)[number];
const only = (keys: FactField[]) => FACT_FIELDS.filter((k) => keys.includes(k));

/** Pole faktur / smluv (v pořadí FACT_FIELDS); editační formulář ukazuje podle typu dokumentu. */
export const INVOICE_FACTS = only(['subject', 'number', 'supplier', 'supplierId', 'supplierVat', 'customer', 'customerId', 'customerVat', 'net', 'vat', 'amount', 'vs', 'issued', 'due']);
export const CONTRACT_FACTS = only(['subject', 'amount', 'issued', 'validFrom', 'validTo', 'period', 'notice', 'autoRenewal', 'penalty', 'law']);

/** Autoři jako text, jeden na řádek: „Příjmení, Jméno“. */
export const authorsText = (authors: Author[]) => authors.map((a) => (a.given ? `${a.family}, ${a.given}` : a.family)).join('\n');

/** Opak `authorsText`; řádek bez čárky je organizace (jen příjmení). */
export function parseAuthors(text: string): Author[] {
  return text
    .split('\n')
    .map((line) => {
      const [family = '', ...rest] = line.split(',');
      return { family: family.trim(), given: rest.join(',').trim() };
    })
    .filter((a) => a.family || a.given);
}
