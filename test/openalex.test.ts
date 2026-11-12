import { describe, expect, it } from 'vitest';
import { applyGaps, bestMatch, cleanDoi, doiUrl, fillGaps, searchUrl, similarity, titleUrl, toAuthor, toBiblio, toWork, toWorks } from '../src/shared/openalex';
import type { Biblio } from '../src/shared/types';

const raw = {
  id: 'https://openalex.org/W1',
  display_name: 'Human Capital and Growth',
  publication_year: 2015,
  authorships: [{ author: { display_name: 'Claudia Dale Goldin' } }, { author: { display_name: 'Ludwig van der Berg' } }, { author: { display_name: 'Madonna' } }],
  primary_location: { landing_page_url: 'https://example.org/a', pdf_url: null, source: { display_name: 'Journal of Economics' } },
  biblio: { volume: '12', issue: '3', first_page: '55', last_page: '86' },
  doi: 'https://doi.org/10.1007/978-3-642-40406-1_23',
  best_oa_location: { pdf_url: 'https://example.org/a.pdf' },
  open_access: { oa_url: 'https://example.org/oa' },
  type: 'article',
};

describe('toAuthor', () => {
  it('příjmení je poslední slovo i s částicemi', () => {
    expect(toAuthor('Claudia Dale Goldin')).toEqual({ given: 'Claudia Dale', family: 'Goldin' });
    expect(toAuthor('Ludwig van der Berg')).toEqual({ given: 'Ludwig', family: 'van der Berg' });
    expect(toAuthor('Madonna')).toEqual({ given: '', family: 'Madonna' });
    expect(toAuthor('de Gaulle')).toEqual({ given: 'de', family: 'Gaulle' });
  });
});

describe('toWork', () => {
  it('namapuje pole a odstraní předponu DOI', () => {
    const w = toWork(raw)!;
    expect(w).toMatchObject({ title: 'Human Capital and Growth', year: '2015', container: 'Journal of Economics', volume: '12', issue: '3', pages: '55–86', doi: '10.1007/978-3-642-40406-1_23', pdfUrl: 'https://example.org/a.pdf', url: 'https://example.org/a', type: 'article' });
    expect(w.authors).toHaveLength(3);
  });
  it('snese chybějící pole', () => {
    expect(toWork({ display_name: 'X' })).toMatchObject({ title: 'X', authors: [], year: undefined, pages: undefined, pdfUrl: undefined });
    expect(toWork({ biblio: { first_page: '7' }, display_name: 'Y' })!.pages).toBe('7');
    expect(toWork(null)).toBeUndefined();
    expect(toWorks({ results: [raw, { nic: 1 }] })).toHaveLength(1);
    expect(toWorks('chyba')).toEqual([]);
  });
  it('doi bez předpony', () => {
    expect(cleanDoi('https://doi.org/10.1/x')).toBe('10.1/x');
    expect(cleanDoi('doi:10.1/x')).toBe('10.1/x');
    expect(cleanDoi(undefined)).toBeUndefined();
  });
});

describe('fillGaps / applyGaps', () => {
  const found = toBiblio(toWork(raw)!);
  const card: Biblio = { authors: [], title: 'Human Capital and Growth', year: '2001', container: '', volume: undefined };
  it('nabídne jen prázdná pole a nepřepíše vyplněná', () => {
    const fields = fillGaps(card, found).map((g) => g.field);
    expect(fields).toEqual(['authors', 'container', 'volume', 'issue', 'pages', 'doi', 'url']);
    expect(fields).not.toContain('year');
  });
  it('applyGaps doplní vybrané a ponechá zbytek', () => {
    const out = applyGaps(card, found, ['volume', 'authors']);
    expect(out.year).toBe('2001');
    expect(out.volume).toBe('12');
    expect(out.authors).toHaveLength(3);
    expect(out.container).toBe('');
    expect(applyGaps(card, found).container).toBe('Journal of Economics');
  });
  it('nic nedoplňuje do úplné karty', () => {
    expect(fillGaps(applyGaps(card, found), found)).toEqual([]);
  });
  it('odkaz na doi.org se do url nedostane', () => {
    expect(toBiblio(toWork({ display_name: 'Z', primary_location: { landing_page_url: 'https://doi.org/10.1/z' } })!).url).toBeUndefined();
  });
});

describe('bestMatch', () => {
  const works = toWorks({ results: [{ display_name: 'Human Capital: A Theoretical Analysis' }, { display_name: 'Human capital' }] });
  it('shoda názvu bez ohledu na velikost písmen a interpunkci', () => {
    expect(bestMatch('HUMAN CAPITAL.', works)?.title).toBe('Human capital');
  });
  it('podobný, ale jiný název nestačí', () => {
    expect(bestMatch('Capital in the Twenty-First Century', works)).toBeUndefined();
    expect(similarity('', '')).toBe(0);
  });
});

describe('adresy', () => {
  it('hledání se kóduje a nenese nic jiného', () => {
    const u = searchUrl('lidský kapitál & růst');
    expect(u).toContain('search=lidsk%C3%BD%20kapit%C3%A1l%20%26%20r%C5%AFst');
    expect(u).not.toMatch(/mailto|api_key/);
    expect(doiUrl('https://doi.org/10.1007/a(b)')).toContain('/works/doi:10.1007/a(b)?');
    expect(titleUrl('A, B|C')).toContain('filter=title.search:A%20%20B%20C');
  });
});
