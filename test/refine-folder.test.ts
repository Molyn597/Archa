import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentCard, Library } from '../src/shared/types';

const ask = vi.fn<(...args: unknown[]) => Promise<string>>();
vi.mock('../src/main/pipeline', () => ({ ask: (...args: unknown[]) => ask(...args) }));
vi.mock('../src/main/keystore', () => ({}));

const { refineFolder } = await import('../src/main/make-card');
const { subfolderTarget } = await import('../src/main/library');
const { parseFolderChoice } = await import('../src/main/card');

const library: Library = {
  folders: [
    { id: 'study', createdAt: 0 },
    { id: 'art', name: 'Články', parent: 'study', createdAt: 0 },
    { id: 'mgmt', name: 'Management', parent: 'art', createdAt: 0 },
    { id: 'eco', name: 'Ekonomie', parent: 'art', createdAt: 0 },
    { id: 'priv', name: 'Soukromé', parent: 'art', createdAt: 0, locked: true },
  ],
  assign: {},
};
const store = { library: async () => library };
const card = (folder: string): DocumentCard => ({ summary: 'Divadlo v 19. století', type: 'article', keywords: ['divadlo'], folder, biblio: { authors: [], title: '' }, lang: 'cs', createdAt: 0 });

describe('subfolderTarget', () => {
  it('složka s podsložkami (bez zamčených)', () => {
    expect(subfolderTarget(library, 'Studium / Články')).toEqual({ path: 'Studium / Články', children: ['Studium / Články / Management', 'Studium / Články / Ekonomie'] });
  });
  it('list stromu nebo neexistující složka = undefined', () => {
    expect(subfolderTarget(library, 'Studium / Články / Management')).toBeUndefined();
    expect(subfolderTarget(library, 'Nová')).toBeUndefined();
  });
});

describe('parseFolderChoice', () => {
  it('složka a nejistota', () => {
    expect(parseFolderChoice('{"folder": "A / B", "folderSure": false, "folderOptions": ["A / C"]}')).toEqual({ folder: 'A / B', folderSure: false, folderOptions: ['A / C'] });
    expect(parseFolderChoice('{"folder": ""}')).toBeUndefined();
  });
});

describe('refineFolder', () => {
  beforeEach(() => ask.mockReset());

  it('složka s podsložkami: model vybere novou podsložku, relativní cesta se doplní', async () => {
    ask.mockResolvedValueOnce('{"folder": "Historie divadla", "folderSure": true}');
    const c = card('Studium / Články');
    await refineFolder({} as never, store as never, c, 'cs');
    expect(c.folder).toBe('Studium / Články / Historie divadla');
    expect(c.folderSure).toBeUndefined();
    const prompt = (ask.mock.calls[0][2] as { content: string }[])[0].content;
    expect(prompt).toContain('Studium / Články / Management');
    expect(prompt).not.toContain('Soukromé');
  });

  it('model trvá na nadřazené složce: dotaz s podsložkami', async () => {
    ask.mockResolvedValueOnce('{"folder": "Studium / Články"}');
    const c = card('Studium / Články');
    await refineFolder({} as never, store as never, c, 'cs');
    expect(c).toMatchObject({ folder: 'Studium / Články / Management', folderSure: false, folderOptions: ['Studium / Články / Ekonomie'] });
  });

  it('nejistá volba se přenese i s možnostmi', async () => {
    ask.mockResolvedValueOnce('{"folder": "Management", "folderSure": false, "folderOptions": ["Ekonomie"]}');
    const c = card('Studium / Články');
    await refineFolder({} as never, store as never, c, 'cs');
    expect(c).toMatchObject({ folder: 'Studium / Články / Management', folderSure: false, folderOptions: ['Studium / Články / Ekonomie'] });
  });

  it('složka bez podsložek: model se neptá', async () => {
    const c = card('Studium / Články / Management');
    await refineFolder({} as never, store as never, c, 'cs');
    expect(ask).not.toHaveBeenCalled();
  });

  it('doptává se i o úroveň níž (Studium → Články → podsložka)', async () => {
    ask.mockResolvedValueOnce('{"folder": "Studium / Články"}').mockResolvedValueOnce('{"folder": "Ekonomie"}');
    const c = card('Studium');
    await refineFolder({} as never, store as never, c, 'cs');
    expect(c.folder).toBe('Studium / Články / Ekonomie');
  });
});
