import { describe, expect, it, vi } from 'vitest';

// Chat s knihovnou táhne klienta modelu (Electron); tady jde jen o výběr dokumentů.
vi.mock('../src/main/pipeline', () => ({}));
vi.mock('../src/main/keystore', () => ({}));
import { matchFolder, moveFolder, removeFolder } from '../src/main/library';
import { libraryDocs } from '../src/main/library-chat';
import { ancestors, childFolders, folderPath, isLocked, subtree } from '../src/shared/folders';
import type { Job, Library } from '../src/shared/types';

const tree = (): Library => ({
  folders: [
    { id: 'study', createdAt: 0 },
    { id: 'art', name: 'Články', parent: 'study', createdAt: 0 },
    { id: 'mgmt', name: 'Management', parent: 'art', createdAt: 0 },
    { id: 'soc', name: 'Sociální politika', parent: 'art', createdAt: 0 },
    { id: 'other', createdAt: 0 },
    { id: 'orphan', name: 'Sirotek', parent: 'gone', createdAt: 0 },
  ],
  assign: { a: { folder: 'mgmt' }, b: { folder: 'art' }, c: { folder: 'study' } },
});

describe('strom složek', () => {
  it('podsložky a nejvyšší úroveň; rodič smazaný = nejvyšší úroveň', () => {
    const { folders } = tree();
    expect(childFolders(folders).map((f) => f.id)).toEqual(['study', 'other', 'orphan']);
    expect(childFolders(folders, 'art').map((f) => f.id)).toEqual(['mgmt', 'soc']);
  });

  it('podstrom, předkové a cesta', () => {
    const { folders } = tree();
    expect([...subtree(folders, 'study')].sort()).toEqual(['art', 'mgmt', 'soc', 'study']);
    expect(ancestors(folders, 'mgmt').map((f) => f.id)).toEqual(['study', 'art']);
    expect(folderPath(folders, folders[2])).toBe('Studium / Články / Management');
  });

  it('cyklus v datech nezamrzne', () => {
    const folders = [
      { id: 'x', parent: 'y', createdAt: 0 },
      { id: 'y', parent: 'x', createdAt: 0 },
    ];
    expect(ancestors(folders, 'x').length).toBeLessThanOrEqual(1);
    expect([...subtree(folders, 'x')].sort()).toEqual(['x', 'y']);
  });

  it('zámek se dědí', () => {
    const { folders } = tree();
    folders[1].locked = true;
    expect(isLocked(folders, folders[2])).toBe(true);
    expect(isLocked(folders, folders[0])).toBe(false);
  });
});

describe('úpravy stromu', () => {
  it('smazání složky posune podsložky a dokumenty o úroveň výš', () => {
    const library = tree();
    removeFolder(library, 'art');
    expect(library.folders.find((f) => f.id === 'mgmt')?.parent).toBe('study');
    expect(library.assign.b).toEqual({ folder: 'study' });
    expect(library.assign.a).toEqual({ folder: 'mgmt' });
  });

  it('smazání složky nejvyšší úrovně: podsložky nahoru, dokumenty nezařazené', () => {
    const library = tree();
    removeFolder(library, 'study');
    expect(library.folders.find((f) => f.id === 'art')?.parent).toBeUndefined();
    expect(library.assign.c).toBeUndefined();
  });

  it('přesun složky; do sebe ani do podsložky nejde', () => {
    const library = tree();
    expect(moveFolder(library, 'soc', 'other')).toBe(true);
    expect(library.folders.find((f) => f.id === 'soc')?.parent).toBe('other');
    expect(moveFolder(library, 'study', 'mgmt')).toBe(false);
    expect(moveFolder(library, 'study', 'study')).toBe(false);
    expect(moveFolder(library, 'art', 'missing')).toBe(false);
    expect(moveFolder(library, 'art', null)).toBe(true);
    expect(library.folders.find((f) => f.id === 'art')?.parent).toBeUndefined();
  });

  it('návrh AI podle cesty i podle názvu', () => {
    const library = tree();
    expect(matchFolder(library, 'Studium / Články / Management')).toBe('mgmt');
    expect(matchFolder(library, 'studium/clanky/socialni politika')).toBe('soc');
    expect(matchFolder(library, 'Management')).toBe('mgmt');
  });
});

describe('chat s knihovnou a podsložky', () => {
  const jobs = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id, ext: '.pdf', status: 'done', createdAt: 0 }) as Job);

  it('složka zahrnuje podsložky a nese celou cestu', () => {
    const docs = libraryDocs(jobs, {}, tree(), 'art');
    expect(docs.map((d) => d.job.id)).toEqual(['a', 'b']);
    expect(docs[0].folder).toBe('Studium / Články / Management');
  });

  it('zamčený předek skryje dokumenty podsložek', () => {
    const library = tree();
    library.folders[0].locked = true;
    expect(libraryDocs(jobs, {}, library).map((d) => d.job.id)).toEqual(['d']);
  });
});
