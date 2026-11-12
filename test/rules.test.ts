import { describe, expect, it, vi } from 'vitest';
import type { DocumentCard, Library } from '../src/shared/types';
import { learnRule, removeRule, ruleId, ruleLines, RULES_MAX, ruleMatch } from '../src/shared/rules';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
const { answerQuestion, defaultLibrary, moveDocs } = await import('../src/main/library');

const card = (over: Partial<DocumentCard> = {}): DocumentCard => ({ summary: '', type: 'invoice', keywords: ['energie'], biblio: {} as DocumentCard['biblio'], lang: 'cs', createdAt: 0, facts: { supplier: 'Elektro Vltava' }, ...over });

describe('ruleMatch / learnRule', () => {
  it('dodavatel má přednost před klíčovým slovem', () => {
    expect(ruleMatch(card())).toEqual({ by: 'party', match: 'Elektro Vltava' });
    expect(ruleMatch(card({ facts: undefined }))).toEqual({ by: 'keyword', match: 'energie' });
    expect(ruleMatch(card({ facts: undefined, keywords: [] }))).toBeUndefined();
  });

  it('stejné pravidlo přepíše cestu, nejnovější je první, počet je omezený', () => {
    let rules = learnRule(undefined, card(), 'Faktury', 1);
    rules = learnRule(rules, card({ facts: { supplier: 'ELEKTRO vltava' } }), 'Faktury / Přijaté', 2);
    expect(rules).toHaveLength(1);
    expect(rules![0].path).toBe('Faktury / Přijaté');
    for (let i = 0; i < RULES_MAX + 5; i++) rules = learnRule(rules, card({ facts: { supplier: `Firma ${i}` } }), 'X', i);
    expect(rules).toHaveLength(RULES_MAX);
  });

  it('removeRule a ruleLines', () => {
    const rules = learnRule(undefined, card({ facts: { supplier: 'A "B"\nC' } }), 'Faktury / Přijaté')!;
    expect(ruleLines(rules)).toEqual(['party "A B C" -> "Faktury / Přijaté"']);
    expect(removeRule(rules, ruleId(rules[0]))).toEqual([]);
  });
});

describe('učení z oprav', () => {
  const library = (): Library => ({ ...defaultLibrary(), assign: { a: { folder: 'invoices' } }, aiLog: [{ jobId: 'a', path: 'Faktury', created: [], folder: 'invoices', at: 1 }] });

  it('ruční přesun dokumentu zařazeného AI uloží pravidlo, druhá oprava ne', () => {
    const l = library();
    moveDocs(l, ['a'], 'contracts', { a: card() });
    expect(l.rules).toHaveLength(1);
    expect(l.rules![0].match).toBe('Elektro Vltava');
    moveDocs(l, ['a'], 'invoices', { a: card({ facts: { supplier: 'Jiný' } }) });
    expect(l.rules).toHaveLength(1);
  });

  it('přesun dokumentu, který zařadil uživatel sám, se neučí', () => {
    const l = defaultLibrary();
    moveDocs(l, ['b'], 'contracts', { b: card() });
    expect(l.rules).toBeUndefined();
  });

  it('odpověď na dotaz jinak než první návrh uloží pravidlo, první návrh ne', () => {
    const l = defaultLibrary();
    l.questions = [{ jobId: 'a', options: ['Faktury', 'Smlouvy'], at: 1 }, { jobId: 'b', options: ['Faktury', 'Smlouvy'], at: 1 }];
    answerQuestion(l, 'b', 'faktury', undefined, card());
    expect(l.rules).toBeUndefined();
    answerQuestion(l, 'a', 'Smlouvy', undefined, card());
    expect(l.rules).toHaveLength(1);
    expect(l.questions).toBeUndefined();
  });
});
