import { describe, expect, it } from 'vitest';
import { inText, pageLabel, printedPages, reference, toHtml, toPlain } from '../src/shared/citation';
import type { Biblio } from '../src/shared/types';

const becker: Biblio = {
  authors: [{ family: 'Becker', given: 'Gary S.' }],
  title: 'Human Capital: A Theoretical and Empirical Analysis, with Special Reference to Education',
  year: '1993',
  publisher: 'University of Chicago Press',
  place: 'Chicago',
  edition: '3',
};
const schultz: Biblio = {
  authors: [{ family: 'Schultz', given: 'Theodore W.' }],
  title: 'Investment in Human Capital',
  year: '1962',
  container: 'Journal of Political Economy',
  volume: '70',
  issue: '5',
  pages: '9-49',
  doi: '10.1086/258724',
};
const chapter: Biblio = {
  authors: [{ family: 'Novák', given: 'Jan' }],
  title: 'Lidský kapitál',
  year: '2020',
  container: 'Ekonomie práce',
  publisher: 'Grada',
  place: 'Praha',
  pages: '112–130',
};
const web: Biblio = {
  authors: [{ family: 'World Health Organization', given: '' }],
  title: 'Mental health',
  year: '2022',
  publisher: 'WHO',
  url: 'https://www.who.int/health-topics/mental-health',
};
const iso = (b: Biblio, type: Parameters<typeof reference>[1], lang: 'cs' | 'en' = 'cs', today?: string) => toPlain(reference(b, type, 'iso690', lang, today));
const apa = (b: Biblio, type: Parameters<typeof reference>[1], lang: 'cs' | 'en' = 'cs') => toPlain(reference(b, type, 'apa7', lang));
const authors = (...names: string[]) => names.map((n) => ({ family: n, given: 'Jan' }));

describe('ISO 690', () => {
  it('článek s DOI, ročníkem, číslem a stranami', () => {
    expect(iso(schultz, 'article')).toBe('SCHULTZ, Theodore W. Investment in Human Capital. Journal of Political Economy. 1962, 70(5), s. 9–49. DOI: 10.1086/258724');
  });
  it('kniha s vydáním, místem a nakladatelem', () => {
    expect(iso(becker, 'book')).toBe('BECKER, Gary S. Human Capital: A Theoretical and Empirical Analysis, with Special Reference to Education. 3. vyd. Chicago: University of Chicago Press, 1993.');
    expect(iso(becker, 'book', 'en')).toContain('3rd ed. Chicago');
  });
  it('kniha má kurzívou jen název, článek jen časopis', () => {
    expect(reference(becker, 'book', 'iso690', 'cs').filter((p) => p.italic).map((p) => p.text)).toEqual([becker.title]);
    expect(reference(schultz, 'article', 'iso690', 'cs').filter((p) => p.italic).map((p) => p.text)).toEqual(['Journal of Political Economy']);
  });
  it('kapitola', () => {
    expect(iso(chapter, 'chapter')).toBe('NOVÁK, Jan. Lidský kapitál. In: Ekonomie práce. Praha: Grada, 2020, s. 112–130.');
    expect(iso(chapter, 'chapter', 'en')).toContain(', p. 112–130.');
  });
  it('web s datem citování a organizací jako autorem', () => {
    expect(iso(web, 'web', 'cs', '2024-05-01')).toBe('World Health Organization. Mental health [online]. WHO, 2022 [cit. 2024-05-01]. Dostupné z: https://www.who.int/health-topics/mental-health');
    expect(iso(web, 'web', 'en', '2024-05-01')).toContain('[cited 2024-05-01]. Available from: https');
  });
  it('bez autora začíná názvem, bez roku má [b.r.]', () => {
    const b: Biblio = { authors: [], title: 'Zákoník práce', publisher: 'Sagit', place: 'Ostrava' };
    expect(iso(b, 'law')).toBe('Zákoník práce. Ostrava: Sagit, [b.r.].');
    expect(iso(b, 'law', 'en')).toContain('[n.d.]');
    expect(reference(b, 'law', 'iso690', 'cs')[0].italic).toBe(true);
    expect(iso({ ...schultz, authors: [] }, 'article')).toMatch(/^Investment in Human Capital\. Journal/);
  });
  it('počet autorů: 2, 3 a více než 3', () => {
    const b = (n: number) => ({ ...becker, authors: authors('Novák', 'Svoboda', 'Dvořák', 'Černý').slice(0, n) });
    expect(iso(b(2), 'book')).toMatch(/^NOVÁK, Jan a Jan SVOBODA\. /);
    expect(iso(b(2), 'book', 'en')).toMatch(/^NOVÁK, Jan and Jan SVOBODA\. /);
    expect(iso(b(3), 'book')).toMatch(/^NOVÁK, Jan, Jan SVOBODA a Jan DVOŘÁK\. /);
    expect(iso(b(4), 'book')).toMatch(/^NOVÁK, Jan et al\. [^.]/);
  });
  it('chybějící pole nenechají zdvojenou interpunkci', () => {
    const out = iso({ authors: [], title: 'Bez ničeho' }, 'other');
    expect(out).toBe('Bez ničeho. [b.r.].');
    for (const text of [out, iso({ ...schultz, volume: '', issue: '', pages: '' }, 'article')]) {
      expect(text).not.toMatch(/\.\.|, ,|\(\)|  /);
    }
  });
});

describe('APA 7', () => {
  it('článek s DOI jako URL', () => {
    expect(apa(schultz, 'article', 'en')).toBe('Schultz, T. W. (1962). Investment in Human Capital. Journal of Political Economy, 70(5), 9–49. https://doi.org/10.1086/258724');
    const parts = reference(schultz, 'article', 'apa7', 'en');
    expect(parts.filter((p) => p.italic).map((p) => p.text)).toEqual(['Journal of Political Economy', '70']);
  });
  it('kniha s vydáním', () => {
    expect(apa(becker, 'book', 'en')).toBe('Becker, G. S. (1993). Human Capital: A Theoretical and Empirical Analysis, with Special Reference to Education (3rd ed.). University of Chicago Press.');
    expect(apa(becker, 'book')).toContain('(3. vyd.)');
  });
  it('kapitola a web', () => {
    expect(apa(chapter, 'chapter')).toBe('Novák, J. (2020). Lidský kapitál. In Ekonomie práce (s. 112–130). Grada.');
    expect(apa(chapter, 'chapter', 'en')).toContain('(pp. 112–130)');
    expect(apa(web, 'web', 'en')).toBe('World Health Organization. (2022). Mental health. WHO. https://www.who.int/health-topics/mental-health');
    expect(apa({ ...web, publisher: 'World Health Organization' }, 'web')).not.toContain('Organization. World');
  });
  it('více autorů a spojovníkové křestní jméno', () => {
    const b: Biblio = { authors: [{ family: 'Sartre', given: 'Jean-Paul' }, { family: 'Beauvoir', given: 'Simone' }], title: 'Dialogy', year: '1960', publisher: 'Gallimard' };
    expect(apa(b, 'book')).toBe('Sartre, J.-P., & Beauvoir, S. (1960). Dialogy. Gallimard.');
    const three = { ...b, authors: authors('A', 'B', 'C') };
    expect(apa(three, 'book')).toMatch(/^A, J\., B, J\., & C, J\. \(1960\)/);
  });
  it('21 a více autorů', () => {
    const many = { ...becker, authors: Array.from({ length: 22 }, (_, i) => ({ family: `A${i + 1}`, given: 'Jan' })) };
    const out = apa(many, 'book');
    expect(out).toContain('A19, J., . . . A22, J. (1993).');
    expect(out).not.toContain('A20');
  });
  it('bez autora a bez roku', () => {
    const b: Biblio = { authors: [], title: 'Příručka', publisher: 'ACME' };
    expect(apa(b, 'manual')).toBe('Příručka. (b.r.). ACME.');
    expect(apa(b, 'manual', 'en')).toContain('(n.d.)');
    expect(apa({ ...schultz, authors: [] }, 'article')).toMatch(/^Investment in Human Capital\. \(1962\)\. Journal/);
    expect(reference({ ...b, edition: '2' }, 'manual', 'apa7', 'en').map((p) => p.text).join('')).toBe('Příručka (2nd ed.). (n.d.). ACME.');
  });
});

describe('inText', () => {
  it('ISO', () => {
    expect(inText(becker, 'iso690', 'cs', [12], false)).toBe('(Becker, 1993, s. 12)');
    expect(inText({ ...becker, authors: authors('Novák', 'Svoboda') }, 'iso690', 'cs', [], false)).toBe('(Novák a Svoboda, 1993)');
    expect(inText({ ...becker, authors: authors('Novák', 'Svoboda') }, 'iso690', 'en', [3], false)).toBe('(Novák and Svoboda, 1993, p. 3)');
    expect(inText({ ...becker, authors: authors('A', 'B', 'C') }, 'iso690', 'cs', [1], false)).toBe('(A et al., 1993, s. 1)');
    expect(inText({ ...becker, year: '' }, 'iso690', 'cs', [2], true)).toBe('(Becker, b.r., s. 2, vlastní překlad)');
    expect(inText(becker, 'iso690', 'en', [2], true)).toBe('(Becker, 1993, p. 2, own translation)');
  });
  it('bez autora první tři slova názvu', () => {
    expect(inText({ authors: [], title: 'Jak se učit ze zkušenosti', year: '2001' }, 'iso690', 'cs', [], false)).toBe('(Jak se učit…, 2001)');
  });
  it('APA', () => {
    expect(inText(becker, 'apa7', 'cs', [12], false)).toBe('(Becker, 1993, s. 12)');
    expect(inText(becker, 'apa7', 'en', [12], false)).toBe('(Becker, 1993, p. 12)');
    expect(inText(becker, 'apa7', 'en', [12, 14], false)).toBe('(Becker, 1993, pp. 12, 14)');
    expect(inText(becker, 'apa7', 'en', [12, 13], true)).toBe('(Becker, 1993, pp. 12–13, my translation)');
    expect(inText({ ...becker, authors: authors('Novák', 'Svoboda') }, 'apa7', 'en', [], false)).toBe('(Novák & Svoboda, 1993)');
    expect(inText({ ...becker, authors: authors('A', 'B', 'C') }, 'apa7', 'cs', [], true)).toBe('(A et al., 1993, vlastní překlad)');
    expect(inText({ ...becker, year: '' }, 'apa7', 'en', [], false)).toBe('(Becker, n.d.)');
  });
});

describe('pageLabel', () => {
  it('rozsahy', () => {
    expect(pageLabel([3])).toBe('3');
    expect(pageLabel([3, 4, 5])).toBe('3–5');
    expect(pageLabel([3, 7, 8])).toBe('3, 7–8');
    expect(pageLabel([8, 7, 3, 3])).toBe('3, 7–8');
  });
});

describe('printedPages', () => {
  it('posune o první stranu článku', () => {
    expect(printedPages({ ...schultz, pages: '112–130' }, 'article', [3, 1, 3])).toEqual([112, 114]);
    expect(printedPages({ ...schultz, pages: '112-130' }, 'chapter', [1])).toEqual([112]);
  });
  it('mimo rozsah nebo bez čísel nechá strany PDF', () => {
    expect(printedPages({ ...schultz, pages: '112–114' }, 'article', [2, 5])).toEqual([2, 5]);
    expect(printedPages({ ...schultz, pages: '' }, 'article', [2])).toEqual([2]);
    expect(printedPages({ ...schultz, pages: 'e123' }, 'article', [2])).toEqual([2]);
  });
  it('ostatní typy beze změny', () => {
    expect(printedPages({ ...becker, pages: '112–130' }, 'book', [5, 2])).toEqual([2, 5]);
  });
  it('bez konce rozsahu se posune vždy', () => {
    expect(printedPages({ ...schultz, pages: '40' }, 'article', [3])).toEqual([42]);
  });
});

describe('toHtml / toPlain', () => {
  const parts = [{ text: 'A & B <x> "q" ' }, { text: 'Kniha', italic: true }];
  it('escapuje a kurzívu dává do <i>', () => {
    expect(toHtml(parts)).toBe('A &amp; B &lt;x&gt; &quot;q&quot; <i>Kniha</i>');
    expect(toPlain(parts)).toBe('A & B <x> "q" Kniha');
  });
});
