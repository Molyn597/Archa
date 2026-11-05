import { describe, expect, it } from 'vitest';
import { cardSample, parseCard } from '../src/main/card';
import { authorsText, parseAuthors } from '../src/shared/card';
import type { Segment } from '../src/shared/types';

const seg = (id: number, source: string, extra: Partial<Segment> = {}): Segment => ({ id, kind: 'paragraph', source, ...extra });

const VALID = {
  summary: 'Krátké shrnutí.',
  type: 'article',
  keywords: ['jedna', 'dvě'],
  folder: 'Články',
  biblio: { authors: [{ family: 'Novák', given: 'Jan' }], title: 'Název', year: '2020', doi: '10.1000/x' },
};

describe('parseCard', () => {
  it('přečte platný JSON', () => {
    const card = parseCard(JSON.stringify(VALID), 'cs')!;
    expect(card.summary).toBe('Krátké shrnutí.');
    expect(card.type).toBe('article');
    expect(card.folder).toBe('Články');
    expect(card.lang).toBe('cs');
    expect(card.biblio).toMatchObject({ title: 'Název', year: '2020', doi: '10.1000/x', authors: [{ family: 'Novák', given: 'Jan' }] });
    expect(card.biblio.publisher).toBeUndefined();
  });

  it('zvládne JSON v ohradě i text okolo', () => {
    const text = `Tady je karta:\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\`\nHotovo {ne}.`;
    expect(parseCard(text, 'cs')?.summary).toBe('Krátké shrnutí.');
  });

  it('neznámý typ je other', () => {
    expect(parseCard(JSON.stringify({ ...VALID, type: 'poem' }), 'cs')?.type).toBe('other');
  });

  it('bez shrnutí nebo bez JSONu vrátí undefined', () => {
    expect(parseCard(JSON.stringify({ ...VALID, summary: '  ' }), 'cs')).toBeUndefined();
    expect(parseCard('žádný json', 'cs')).toBeUndefined();
    expect(parseCard('{"summary": "x"', 'cs')).toBeUndefined();
  });

  it('vyčistí autory', () => {
    const biblio = { authors: [{ family: ' Svoboda ', given: ' Petr ' }, { family: '', given: '' }, { family: 'ČSÚ', given: '' }, 'nesmysl'], title: 'T' };
    expect(parseCard(JSON.stringify({ ...VALID, biblio }), 'cs')?.biblio.authors).toEqual([
      { family: 'Svoboda', given: 'Petr' },
      { family: 'ČSÚ', given: '' },
    ]);
  });

  it('klíčová slova: unikátní, neprázdná, nejvýš 10', () => {
    const keywords = ['a', ' a ', '', 'b', ...Array.from({ length: 20 }, (_, i) => `k${i}`)];
    const card = parseCard(JSON.stringify({ ...VALID, keywords }), 'cs')!;
    expect(card.keywords).toHaveLength(10);
    expect(card.keywords.slice(0, 3)).toEqual(['a', 'b', 'k0']);
  });
});

describe('cardSample', () => {
  it('přidá značku stránky jen při změně', () => {
    const text = cardSample([seg(1, 'A', { page: 1 }), seg(2, 'B', { page: 1 }), seg(3, 'C', { page: 3 })], 1000);
    expect(text).toBe('[p. 1]\n\nA\n\nB\n\n[p. 3]\n\nC');
  });

  it('přeskočí layoutOnly a obrázky', () => {
    const text = cardSample([seg(1, 'A'), seg(2, 'citát', { layoutOnly: true }), seg(3, 'graf', { figure: true }), seg(4, 'B')], 1000);
    expect(text).toBe('A\n\nB');
  });

  it('zkrátí na limit', () => {
    expect(cardSample([seg(1, 'x'.repeat(100))], 10)).toHaveLength(10);
  });
});

describe('authors', () => {
  it('převádí text a zpět', () => {
    const authors = parseAuthors('Novák, Jan\nČSÚ\n\n');
    expect(authors).toEqual([{ family: 'Novák', given: 'Jan' }, { family: 'ČSÚ', given: '' }]);
    expect(authorsText(authors)).toBe('Novák, Jan\nČSÚ');
  });
});
