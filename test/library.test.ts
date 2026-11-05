import { afterEach, describe, expect, it } from 'vitest';
import { autoAssign, defaultLibrary, matchFolder, moveDocs, removeFolder } from '../src/main/library';
import { DEFAULT_FOLDER_KEYS, folderName } from '../src/shared/folders';
import { setLang } from '../src/shared/i18n';
import type { Library } from '../src/shared/types';

describe('knihovna', () => {
  afterEach(() => setLang('cs'));

  it('výchozí knihovna má složku za každý klíč a žádné zařazení', () => {
    const library = defaultLibrary();
    expect(library.folders.map((f) => f.id)).toEqual([...DEFAULT_FOLDER_KEYS]);
    expect(library.assign).toEqual({});
  });

  it('název složky: vlastní, jinak přeložený', () => {
    const library = defaultLibrary();
    expect(folderName(library.folders[0]!)).toBe('Smlouvy');
    setLang('en');
    expect(folderName(library.folders[0]!)).toBe('Contracts');
    expect(folderName({ id: 'x', name: 'Moje', createdAt: 0 })).toBe('Moje');
  });

  describe('matchFolder', () => {
    it('ignoruje velikost písmen a diakritiku', () => {
      const library = defaultLibrary();
      expect(matchFolder(library, 'články')).toBe('articles');
      expect(matchFolder(library, 'CLANKY')).toBe('articles');
      expect(matchFolder(library, ' Úřední ')).toBe('official');
    });

    it('přijme klíč výchozí složky', () => {
      expect(matchFolder(defaultLibrary(), 'invoices')).toBe('invoices');
    });

    it('najde vlastní složku', () => {
      const library = defaultLibrary();
      library.folders.push({ id: 'abc', name: 'Daňové přiznání', createdAt: 1 });
      expect(matchFolder(library, 'danove priznani')).toBe('abc');
    });

    it('bez shody nebo bez návrhu vrátí undefined', () => {
      expect(matchFolder(defaultLibrary(), 'Něco jiného')).toBeUndefined();
      expect(matchFolder(defaultLibrary(), '')).toBeUndefined();
      expect(matchFolder(defaultLibrary())).toBeUndefined();
    });
  });

  describe('autoAssign', () => {
    it('zařadí nový dokument podle návrhu', () => {
      const library = defaultLibrary();
      expect(autoAssign(library, 'j1', 'Faktury')).toBe(true);
      expect(library.assign.j1).toEqual({ folder: 'invoices' });
    });

    it('přeřadí automatické zařazení, ale ne ruční', () => {
      const library = defaultLibrary();
      autoAssign(library, 'j1', 'Faktury');
      expect(autoAssign(library, 'j1', 'Smlouvy')).toBe(true);
      expect(library.assign.j1).toEqual({ folder: 'contracts' });
      moveDocs(library, ['j1'], 'study');
      expect(autoAssign(library, 'j1', 'Faktury')).toBe(false);
      expect(library.assign.j1).toEqual({ folder: 'study', manual: true });
    });

    it('bez shody spadne do Ostatní, nic se nezmění při stejném výsledku', () => {
      const library = defaultLibrary();
      expect(autoAssign(library, 'j1', 'neznámé')).toBe(true);
      expect(library.assign.j1).toEqual({ folder: 'other' });
      expect(autoAssign(library, 'j1', 'neznámé')).toBe(false);
    });

    it('bez složky Ostatní zůstane dokument nezařazený', () => {
      const library = defaultLibrary();
      removeFolder(library, 'other');
      expect(autoAssign(library, 'j1', 'neznámé')).toBe(false);
      expect(library.assign.j1).toBeUndefined();
      autoAssign(library, 'j1', 'Faktury');
      expect(autoAssign(library, 'j1', 'neznámé')).toBe(true);
      expect(library.assign.j1).toBeUndefined();
    });
  });

  it('removeFolder smaže složku a její dokumenty nechá nezařazené', () => {
    const library: Library = defaultLibrary();
    moveDocs(library, ['a', 'b'], 'study');
    moveDocs(library, ['c'], 'invoices');
    removeFolder(library, 'study');
    expect(library.folders.some((f) => f.id === 'study')).toBe(false);
    expect(library.assign).toEqual({ c: { folder: 'invoices', manual: true } });
  });

  it('moveDocs nastaví ruční zařazení, null ho zruší', () => {
    const library = defaultLibrary();
    moveDocs(library, ['a', 'b'], 'manuals');
    expect(library.assign).toEqual({ a: { folder: 'manuals', manual: true }, b: { folder: 'manuals', manual: true } });
    moveDocs(library, ['a'], null);
    expect(library.assign).toEqual({ b: { folder: 'manuals', manual: true } });
  });
});
