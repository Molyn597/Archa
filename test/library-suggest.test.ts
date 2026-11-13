import { describe, expect, it } from 'vitest';
import { folderHints, suggestLibrary } from '../src/shared/library-suggest';
import { targetFolder } from '../src/shared/library-transfer';
import type { Library } from '../src/shared/types';

const libraries = [
  { id: 'w', kind: 'work' as const },
  { id: 's', kind: 'study' as const },
  { id: 'p', kind: 'personal' as const },
];

describe('suggestLibrary', () => {
  it('článek nebo kniha mimo Studium → studijní knihovna, složka Články', () => {
    expect(suggestLibrary({ kind: 'work', currentId: 'w', type: 'article', libraries })).toEqual({ libraryId: 's', folders: ['Články'] });
    expect(suggestLibrary({ kind: 'personal', currentId: 'p', type: 'book', cardFolder: 'Ostatní', libraries })?.folders).toEqual(['Knihy', 'Books', 'Články', 'Ostatní']);
  });
  it('faktura nebo smlouva ve Studiu → pracovní knihovna', () => {
    expect(suggestLibrary({ kind: 'study', currentId: 's', type: 'invoice', libraries })).toEqual({ libraryId: 'w', folders: ['Faktury'] });
    expect(suggestLibrary({ kind: 'study', currentId: 's', type: 'contract', libraries })?.folders).toEqual(['Smlouvy']);
  });
  it('jinak zůstává: článek ve Studiu, faktura v Práci, chybějící cílová knihovna, jiný typ', () => {
    expect(suggestLibrary({ kind: 'study', currentId: 's', type: 'article', libraries })).toBeNull();
    expect(suggestLibrary({ kind: 'work', currentId: 'w', type: 'invoice', libraries })).toBeNull();
    expect(suggestLibrary({ kind: 'work', currentId: 'w', type: 'article', libraries: [libraries[0]] })).toBeNull();
    expect(suggestLibrary({ kind: 'study', currentId: 's', type: 'letter', libraries })).toBeNull();
    expect(suggestLibrary({ kind: 'work', currentId: 'w', type: undefined, libraries })).toBeNull();
  });
  it('nenavrhne otevřenou knihovnu', () => {
    expect(suggestLibrary({ kind: 'work', currentId: 'w', type: 'article', libraries: [{ id: 'w', kind: 'study' }] })).toBeNull();
  });
  it('folderHints bez shody je prázdné', () => {
    expect(folderHints('letter', 'study')).toEqual([]);
  });
});

describe('targetFolder s více návrhy', () => {
  const study: Library = { folders: [{ id: 'articles', createdAt: 0 }, { id: 'other', createdAt: 0 }], assign: {} };
  it('první existující vyhraje, Ostatní jen když nic nesedí', () => {
    expect(targetFolder(study, ['Knihy', 'Články', 'Ostatní'])).toBe('articles');
    expect(targetFolder(study, ['Knihy', 'Nic'])).toBe('other');
  });
});
