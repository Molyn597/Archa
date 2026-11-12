import { describe, expect, it } from 'vitest';
import { dropSources, ensureNamedPath, studyOffer, pathNames, placeWithPath, pruneFolders, releaseEntries, targetFolder, touchedFolders, transferEntries, pathForTarget } from '../src/shared/library-transfer';
import type { Library, Project } from '../src/shared/types';

const lib = (extra: Partial<Library> = {}): Library => ({
  folders: [
    { id: 'contracts', createdAt: 0 },
    { id: 'a1', name: 'Právo', createdAt: 0 },
    { id: 'a2', name: 'Články', createdAt: 0, parent: 'a1' },
    { id: 'safe', name: 'Trezor', createdAt: 0, locked: true },
    { id: 'other', createdAt: 0 },
  ],
  assign: {},
  ...extra,
});

describe('targetFolder', () => {
  it('shoda názvu bez ohledu na velikost písmen a diakritiku', () => {
    expect(targetFolder(lib(), 'smlouvy')).toBe('contracts');
    expect(targetFolder(lib(), 'PRAVO')).toBe('a1');
  });
  it('cesta i poslední část cesty', () => {
    expect(targetFolder(lib(), 'Právo / Články')).toBe('a2');
    expect(targetFolder(lib(), 'Studium / Články')).toBe('a2');
  });
  it('bez shody Ostatní, bez Ostatní nezařazený', () => {
    expect(targetFolder(lib(), 'Něco jiného')).toBe('other');
    expect(targetFolder(lib(), undefined)).toBe('other');
    expect(targetFolder({ folders: [{ id: 'contracts', createdAt: 0 }], assign: {} }, 'x')).toBeUndefined();
  });
  it('zamčené složky se nepoužijí', () => {
    expect(targetFolder(lib(), 'Trezor')).toBe('other');
  });
});

describe('transferEntries', () => {
  it('přenese zařazení a zaplacení, ze zdroje odstraní všechny stopy', () => {
    const source = lib({ assign: { d1: { folder: 'a1', manual: true }, d2: { folder: 'a1' } }, paid: { d1: 5, d2: 6 }, questions: [{ jobId: 'd1', options: ['x'], at: 1 }], aiLog: [{ jobId: 'd1', path: 'p', created: [], folder: 'a1', at: 1 } as never], recent: ['d1', 'd2'] });
    const target = lib();
    const placed = transferEntries(source, target, ['d1'], { d1: 'Smlouvy' });
    expect(placed).toEqual({ d1: 'contracts' });
    expect(target.assign.d1).toEqual({ folder: 'contracts' });
    expect(target.paid).toEqual({ d1: 5 });
    expect(source.assign).toEqual({ d2: { folder: 'a1' } });
    expect(source.paid).toEqual({ d2: 6 });
    expect(source.questions).toBeUndefined();
    expect(source.aiLog).toBeUndefined();
    expect(source.recent).toEqual(['d2']);
  });
  it('nezaplacený dokument nevytvoří paid v cíli', () => {
    const target = lib();
    transferEntries(lib({ assign: { d1: { folder: 'a1' } } }), target, ['d1']);
    expect(target.paid).toBeUndefined();
  });
});

describe('dropSources', () => {
  const project = (sources: string[]) => ({ sources }) as Project;
  it('odebere zdroje', () => {
    const p = project(['a', 'b', 'c']);
    expect(dropSources(p, ['b', 'x'])).toBe(true);
    expect(p.sources).toEqual(['a', 'c']);
  });
  it('beze změny vrací false', () => {
    expect(dropSources(project(['a']), ['z'])).toBe(false);
  });
});

describe('placeWithPath', () => {
  let n = 0;
  const id = () => `n${++n}`;
  it('založí chybějící cestu s vlastními názvy a novými id', () => {
    const target: Library = { folders: [], assign: {} };
    const f = placeWithPath(target, 'd1', ['Studium', 'Články', 'Management'], id);
    expect(target.assign.d1.folder).toBe(f);
    expect(target.folders.map((x) => [x.name, x.parent])).toEqual([['Studium', undefined], ['Články', target.folders[0].id], ['Management', target.folders[1].id]]);
    expect(target.folders.some((x) => x.id === 'study')).toBe(false);
  });
  it('existující složku se stejným názvem (bez diakritiky a velikosti) použije', () => {
    const target = lib();
    const before = target.folders.length;
    expect(placeWithPath(target, 'd1', ['PRAVO', 'clanky'], id)).toBe('a2');
    expect(target.folders.length).toBe(before);
  });
  it('výchozí složka v cíli (podle zobrazeného názvu) se znovu použije, jinak se založí s name', () => {
    const withDefault: Library = { folders: [{ id: 'study', createdAt: 0 }], assign: {} };
    expect(ensureNamedPath(withDefault, ['Studium'], id)).toBe('study');
    const without: Library = { folders: [], assign: {} };
    const f = ensureNamedPath(without, ['Studium'], id)!;
    expect(f).not.toBe('study');
    expect(without.folders[0].name).toBe('Studium');
  });
  it('zamčenou složku nepoužije', () => {
    const target = lib();
    const f = ensureNamedPath(target, ['Trezor'], id)!;
    expect(f).not.toBe('safe');
    expect(target.folders.find((x) => x.id === f)?.locked).toBeUndefined();
  });
  it('prázdná cesta nic neudělá', () => {
    const target = lib();
    expect(placeWithPath(target, 'd1', [])).toBeUndefined();
    expect(target.assign.d1).toBeUndefined();
  });
});

describe('pathNames', () => {
  const folders = lib().folders;
  it('od nejvyšší úrovně i od zadané složky', () => {
    expect(pathNames(folders, 'a2')).toEqual(['Právo', 'Články']);
    expect(pathNames(folders, 'a2', 'a2')).toEqual(['Články']);
    expect(pathNames(folders, 'a1', 'a2')).toEqual([]);
    expect(pathNames(folders, undefined)).toEqual([]);
  });
});

describe('úklid zdroje', () => {
  const source = (): Library => ({
    folders: [
      { id: 'study', createdAt: 0 },
      { id: 'c', name: 'Články', createdAt: 0, parent: 'study' },
      { id: 'm', name: 'Management', createdAt: 0, parent: 'c' },
      { id: 'e', name: 'Ekonomie', createdAt: 0, parent: 'c' },
      { id: 'empty', name: 'Prázdná od začátku', createdAt: 0 },
      { id: 'lk', name: 'Zámek', createdAt: 0, parent: 'study', locked: true },
    ],
    assign: { d1: { folder: 'm' }, d2: { folder: 'e' }, d3: { folder: 'e' } },
  });
  it('odstraní dotčené složky bez dokumentů, ostatní ponechá', () => {
    const s = source();
    const ids = ['d1', 'd2', 'd3'];
    const touched = touchedFolders(s, ids);
    releaseEntries(s, ids);
    const gone = pruneFolders(s, touched);
    expect(gone.sort()).toEqual(['c', 'e', 'm']);
    expect(s.folders.map((f) => f.id)).toEqual(['study', 'empty', 'lk']);
  });
  it('složka s dokumentem, který zůstal, nebo se zámkem v podstromu se nesmaže', () => {
    const s = source();
    const touched = touchedFolders(s, ['d1']);
    releaseEntries(s, ['d1']);
    expect(pruneFolders(s, touched).sort()).toEqual(['m']);
    s.assign = {};
    const t2 = touchedFolders(s, [], 'study');
    expect(pruneFolders(s, t2).sort()).toEqual(['c', 'e']);
    expect(s.folders.map((f) => f.id)).toEqual(['study', 'empty', 'lk']);
  });
  it('fromFolder odstraní i prázdné podsložky přesouvané složky', () => {
    const s = source();
    s.assign = {};
    s.folders = s.folders.filter((f) => f.id !== 'lk');
    expect(pruneFolders(s, touchedFolders(s, [], 'c')).sort()).toEqual(['c', 'e', 'm']);
  });
});

describe('studyOffer', () => {
  const doc = (id: string, literature = false, movable = true) => ({ id, literature, movable });
  const project = (id: string, kind: Project['kind'], sources: string[]) => ({ id, kind, sources }) as Project;
  const base = { kind: 'work' as const, hasStudy: true };

  it('spočítá články, studijní projekty a jejich zdroje', () => {
    const offer = studyOffer({ ...base, docs: [doc('a', true), doc('b', true), doc('s1'), doc('w1')], projects: [project('p', 'bachelor', ['s1', 'gone']), project('z', 'work', ['w1'])] });
    expect(offer).toEqual({ action: 'move', ids: ['a', 'b', 's1'], projectIds: ['p'], literature: 2, skipped: 0 });
  });
  it('bez studijní knihovny nabídne založení; u studia a bez obsahu nic', () => {
    expect(studyOffer({ ...base, hasStudy: false, docs: [doc('a', true)], projects: [] })?.action).toBe('create');
    expect(studyOffer({ ...base, kind: 'study', docs: [doc('a', true)], projects: [] })).toBeNull();
    expect(studyOffer({ ...base, docs: [doc('w')], projects: [project('z', 'other', ['w'])] })).toBeNull();
    expect(studyOffer({ ...base, kind: 'personal', docs: [], projects: [project('p', 'seminar', [])] })?.projectIds).toEqual(['p']);
  });
  it('zamčené přeskočí; projekt se zamčeným zdrojem zůstane celý', () => {
    const offer = studyOffer({ ...base, docs: [doc('a', true), doc('l', true, false), doc('s1'), doc('s2', false, false)], projects: [project('p', 'master', ['s1', 's2'])] });
    expect(offer).toEqual({ action: 'move', ids: ['a'], projectIds: [], literature: 1, skipped: 2 });
  });
});
