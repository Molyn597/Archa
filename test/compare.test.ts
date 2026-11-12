import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentCard, Job, Library, Segment, Settings } from '../src/shared/types';

const ask = vi.fn<(...args: unknown[]) => Promise<string>>();
vi.mock('../src/main/pipeline', () => ({ ask: (...args: unknown[]) => ask(...args), connect: async () => 'http://x', loadModel: async () => undefined }));
vi.mock('../src/main/keystore', () => ({ readKey: async () => 'key' }));

const { changesPrompt, compareDocs, parseChangeSummary, summarizeChanges } = await import('../src/main/compare');

describe('parseChangeSummary', () => {
  it('přečte shrnutí a nejvýš 8 změn s názvem', () => {
    const changes = Array.from({ length: 10 }, (_, i) => ({ title: `Změna ${i}`, before: '3 měsíce', after: '6 měsíců', impact: 'Delší výpověď.' }));
    const r = parseChangeSummary('```json\n' + JSON.stringify({ summary: 'Nová verze prodlužuje výpověď.', changes: [{ title: '', before: 'x' }, ...changes] }) + '\n```');
    expect(r?.summary).toBe('Nová verze prodlužuje výpověď.');
    expect(r?.changes).toHaveLength(8);
    expect(r?.changes[0]).toEqual({ title: 'Změna 0', before: '3 měsíce', after: '6 měsíců', impact: 'Delší výpověď.' });
  });

  it('chybějící pole jsou prázdná, nečitelná odpověď je undefined', () => {
    expect(parseChangeSummary('Tady je: {"changes": [{"title": "Nová pokuta"}]}')).toEqual({ summary: '', changes: [{ title: 'Nová pokuta', before: '', after: '', impact: '' }] });
    expect(parseChangeSummary('nevím')).toBeUndefined();
    expect(parseChangeSummary('{"summary": "", "changes": []}')).toBeUndefined();
  });

  it('prompt má změny, jazyk a stranu', () => {
    const p = changesPrompt('Čl. II: – 3 měsíce / + 6 měsíců', 'cs', 'Dílna Novák s.r.o.');
    expect(p).toContain('+ 6 měsíců');
    expect(p).toContain('Czech');
    expect(p).toContain('"Dílna Novák s.r.o."');
  });
});

const segs = (...texts: string[]): Segment[] => texts.map((source, i) => ({ id: i + 1, kind: 'paragraph', source }));
function fakeStore() {
  const jobs: Record<string, Job> = {
    old: { id: 'old', createdAt: 1, finishedAt: 5 } as Job,
    new: { id: 'new', createdAt: 2, finishedAt: 6 } as Job,
  };
  const segments: Record<string, Segment[]> = {
    old: segs('Čl. I – Nájemné', 'Nájemné činí 15 000 Kč měsíčně.'),
    new: [...segs('Čl. I – Nájemné', 'Nájemné činí 16 500 Kč měsíčně.'), { id: 3, kind: 'paragraph', source: 'citát', layoutOnly: true }],
  };
  let library: Library = { folders: [], assign: {} };
  return {
    appRoot: '/x',
    job: async (id: string) => jobs[id] ?? null,
    card: async (): Promise<DocumentCard | null> => null,
    segments: async (id: string) => segments[id],
    library: async () => library,
    updateLibrary: async (change: (l: Library) => unknown) => {
      library = structuredClone(library);
      return change(library);
    },
    saveJob: async () => undefined,
  };
}
const settings = { provider: 'local', targetLang: 'cs' } as Settings;
const answer = JSON.stringify({ summary: 'Vyšší nájemné.', changes: [{ title: 'Nájemné', before: '15 000 Kč', after: '16 500 Kč', impact: 'Platíš víc.' }] });

describe('compareDocs a summarizeChanges', () => {
  beforeEach(() => ask.mockReset());

  it('starší verze jde vlevo, citáty jen pro PDF se vynechají', async () => {
    const r = await compareDocs(fakeStore() as never, 'new', 'old');
    expect([r.a.job.id, r.b.job.id]).toEqual(['old', 'new']);
    expect(r.sections[0].rows.map((x) => [x.kind, x.aSeg, x.bSeg])).toEqual([['chg', 2, 2]]);
    expect((await compareDocs(fakeStore() as never, 'new', 'old', true)).a.job.id).toBe('new');
  });

  it('shrnutí se uloží a příště vrátí bez modelu; obrácený směr ho nepoužije', async () => {
    const store = fakeStore();
    ask.mockResolvedValueOnce(answer);
    expect((await summarizeChanges(store as never, settings, 'old', 'new')).summary).toBe('Vyšší nájemné.');
    expect((ask.mock.calls[0][2] as { content: string }[])[0].content).toContain('– Nájemné činí 15 000 Kč měsíčně. / + Nájemné činí 16 500 Kč měsíčně.');
    expect((await compareDocs(store as never, 'old', 'new')).summary?.changes[0].after).toBe('16 500 Kč');
    expect((await summarizeChanges(store as never, settings, 'old', 'new')).summary).toBe('Vyšší nájemné.');
    expect(ask).toHaveBeenCalledTimes(1);
    expect((await compareDocs(store as never, 'new', 'old', true)).summary).toBeUndefined();
    ask.mockResolvedValueOnce('nevím');
    await expect(summarizeChanges(store as never, settings, 'old', 'new', true)).rejects.toThrow();
  });
});
