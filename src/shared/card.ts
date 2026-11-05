import type { Author, Biblio, DocType } from './types';

export const DOC_TYPES: DocType[] = ['article', 'book', 'chapter', 'thesis', 'report', 'contract', 'invoice', 'manual', 'letter', 'law', 'web', 'other'];

/** Textová pole bibliografie ve vykreslovaném pořadí. */
export const BIBLIO_FIELDS = ['title', 'year', 'container', 'publisher', 'place', 'edition', 'volume', 'issue', 'pages', 'doi', 'url'] as const satisfies readonly (keyof Biblio)[];

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
