import { describe, expect, it } from 'vitest';
import { dropSources, targetFolder, transferEntries } from '../src/shared/library-transfer';
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
