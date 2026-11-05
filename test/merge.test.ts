import { describe, expect, it, vi } from 'vitest';
import type { Library } from '../src/shared/types';

vi.mock('../src/main/pipeline', () => ({}));
vi.mock('../src/main/keystore', () => ({}));

const { ensurePath, mergeFolders, similarFolders } = await import('../src/main/library');
const { parseMerges, treeWithCounts } = await import('../src/main/organize');
const { similarName } = await import('../src/shared/folders');

const lib = (): Library => ({
  folders: [
    { id: 'study', createdAt: 0 },
    { id: 'eco', name: 'Ekonomie', parent: 'study', createdAt: 0 },
    { id: 'eco2', name: 'Ekonomika', parent: 'study', createdAt: 0 },
    { id: 'inst', name: 'Instituce', parent: 'eco2', createdAt: 0 },
    { id: 'inst0', name: 'Instituce', parent: 'eco', createdAt: 0 },
    { id: 'mgmt', name: 'Management', parent: 'study', createdAt: 0 },
    { id: 'rizeni', name: 'Řízení', parent: 'study', createdAt: 0 },
    { id: 'lock', name: 'Ekonomická tajná', parent: 'study', locked: true, createdAt: 0 },
  ],
  assign: { a: { folder: 'eco' }, b: { folder: 'eco2' }, c: { folder: 'inst' }, d: { folder: 'eco' } },
});

describe('similarName', () => {
  it.each([
    ['Ekonomie', 'Ekonomika'],
    ['Smlouva', 'Smlouvy'],
    ['Články', 'clanky'],
    ['Řízení výkonu', 'Rizeni vykonu'],
  ])('%s ~ %s', (a, b) => expect(similarName(a, b)).toBe(true));
  it.each([
    ['Management', 'Manažerské modely'],
    ['Studium', 'Studie'],
    ['Faktury', 'Smlouvy'],
    ['Ekonomie', 'Management'],
  ])('%s ≁ %s', (a, b) => expect(similarName(a, b)).toBe(false));
});

describe('prevence duplicit', () => {
  it('AI nezaloží „Ekonomika“ vedle „Ekonomie“', () => {
    const library = lib();
    library.folders = library.folders.filter((f) => f.id !== 'eco2' && f.id !== 'inst');
    expect(ensurePath(library, 'Studium / Ekonomika / Instituce', true, () => 'x')).toEqual({ id: 'inst0', created: [] });
  });
});

describe('mergeFolders', () => {
  it('dokumenty i podsložky přejdou do cíle, stejnojmenné podsložky se sloučí', () => {
    const library = lib();
    expect(mergeFolders(library, 'eco2', 'eco')).toBe(true);
    expect(library.folders.map((f) => f.id)).not.toContain('eco2');
    expect(library.folders.map((f) => f.id)).not.toContain('inst');
    expect(library.assign.b).toEqual({ folder: 'eco' });
    expect(library.assign.c).toEqual({ folder: 'inst0' });
  });

  it('do sebe ani do vlastní podsložky nejde', () => {
    const library = lib();
    expect(mergeFolders(library, 'eco', 'eco')).toBe(false);
    expect(mergeFolders(library, 'eco', 'inst0')).toBe(false);
    expect(library.folders).toHaveLength(8);
  });
});

describe('návrhy sloučení', () => {
  it('podle názvu: sourozenci, cílem ta s víc dokumenty, zamčené ne', () => {
    expect(similarFolders(lib())).toEqual([{ from: 'eco2', into: 'eco' }]);
  });

  it('strom s počty dokumentů včetně podsložek, bez zamčených', () => {
    const tree = treeWithCounts(lib());
    expect(tree).toContain('Studium / Ekonomika (2)');
    expect(tree).toContain('Studium / Ekonomie (2)');
    expect(tree).not.toContain('tajná');
  });

  it('návrhy modelu: platné cesty, bez zamčených a bez cíle uvnitř zdroje', () => {
    const merges = parseMerges(
      JSON.stringify({
        merges: [
          { from: 'Studium / Řízení', into: 'Studium / Management', reason: 'Synonyma' },
          { from: 'Studium / Ekonomie', into: 'Studium / Ekonomie / Instituce' },
          { from: 'Studium / Neexistuje', into: 'Studium' },
          { from: 'Studium / Ekonomická tajná', into: 'Studium / Ekonomie' },
        ],
      }),
      lib(),
    );
    expect(merges).toEqual([{ from: 'rizeni', into: 'mgmt', reason: 'Synonyma' }]);
  });
});
