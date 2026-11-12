import { describe, expect, it } from 'vitest';
import { addSaved, removeSaved, SAVED_MAX } from '../src/shared/saved-search';
import { isImportable, isNewFile } from '../src/shared/watch';

describe('isImportable', () => {
  it('přijme podporované přípony bez ohledu na velikost písmen', () => {
    expect(isImportable('/a/b/Faktura.PDF')).toBe(true);
    expect(isImportable('C:\\scan\\smlouva.docx')).toBe(true);
    expect(isImportable('x.png')).toBe(false);
    expect(isImportable('bez-pripony')).toBe(false);
  });

  it('přeskočí skryté a zámkové soubory', () => {
    expect(isImportable('/a/.hidden.pdf')).toBe(false);
    expect(isImportable('/a/~$smlouva.docx')).toBe(false);
  });
});

describe('isNewFile', () => {
  it('nový nebo změněný soubor ano, zpracovaný ne', () => {
    const seen = { '/a/x.pdf': 1000 };
    expect(isNewFile(seen, '/a/x.pdf', 1000.7)).toBe(false);
    expect(isNewFile(seen, '/a/x.pdf', 2000)).toBe(true);
    expect(isNewFile(seen, '/a/y.pdf', 1000)).toBe(true);
  });
});

describe('uložená hledání', () => {
  it('stejný název přepíše, prázdné ignoruje, počet je omezený', () => {
    let list = addSaved(undefined, { name: ' Energie ', query: 'energie' });
    list = addSaved(list, { name: 'Energie', query: 'elektřina', folder: 'f1' });
    expect(list).toEqual([{ name: 'Energie', query: 'elektřina', folder: 'f1' }]);
    expect(addSaved(list, { name: '', query: 'x' })).toBe(list);
    expect(addSaved(list, { name: 'X', query: ' ' })).toBe(list);
    for (let i = 0; i < SAVED_MAX + 3; i++) list = addSaved(list, { name: `H${i}`, query: 'q' });
    expect(list).toHaveLength(SAVED_MAX);
    expect(removeSaved(list, 'H5')).toHaveLength(SAVED_MAX - 1);
  });
});
