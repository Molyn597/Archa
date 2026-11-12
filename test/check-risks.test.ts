import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Segment, Settings } from '../src/shared/types';

const ask = vi.fn<(...args: unknown[]) => Promise<string>>();
vi.mock('../src/main/pipeline', () => ({ ask: (...args: unknown[]) => ask(...args) }));
vi.mock('../src/main/keystore', () => ({}));

const { checkRisks } = await import('../src/main/make-card');

const segments: Segment[] = [
  { id: 1, kind: 'paragraph', page: 1, source: 'Nájem se automaticky prodlužuje o další 3 roky.' },
  { id: 2, kind: 'paragraph', page: 2, source: 'Smluvní pokuta činí 0,5 % denně.' },
];
const store = { segments: async () => segments };
const job = { id: 'j1' };
const settings = (extra: Partial<Settings> = {}) => ({ provider: 'local', ...extra }) as Settings;
const answer = JSON.stringify({ risks: [{ severity: 'high', title: 'Prodloužení', quote: 'automaticky prodlužuje o další 3 roky', why: 'x' }] });
const run = (s = settings()) => checkRisks({} as never, store as never, job as never, s, 'cs');

describe('checkRisks', () => {
  beforeEach(() => ask.mockReset());

  it('vrátí rizika s existující citací, text posílá bez čísel stran', async () => {
    ask.mockResolvedValueOnce(answer);
    const risks = await run();
    expect(risks?.map((r) => r.title)).toEqual(['Prodloužení']);
    const prompt = (ask.mock.calls[0][2] as { content: string }[])[0].content;
    expect(prompt).toContain('Smluvní pokuta činí');
    expect(prompt).not.toContain('[p. ');
  });

  it('vlastní firma jde do promptu', async () => {
    ask.mockResolvedValueOnce('{"risks": []}');
    expect(await run(settings({ ownCompany: { name: 'Pila Servis s.r.o.' } as Settings['ownCompany'] }))).toEqual([]);
    expect((ask.mock.calls[0][2] as { content: string }[])[0].content).toContain('Pila Servis s.r.o.');
  });

  it('nečitelná odpověď = undefined, chyba modelu se propaguje (makeCard ji zachytí)', async () => {
    ask.mockResolvedValueOnce('nevím');
    expect(await run()).toBeUndefined();
    ask.mockRejectedValueOnce(new Error('model spadl'));
    await expect(run()).rejects.toThrow('model spadl');
  });

  it('dokument bez textu model nevolá', async () => {
    expect(await checkRisks({} as never, { segments: async () => [] } as never, job as never, settings(), 'cs')).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('makeCard + rizika', () => {
  const connect = vi.fn(async () => ({}));
  const loadModel = vi.fn(async () => undefined);
  const cardAnswer = (type: string) => JSON.stringify({ summary: 'Shrnutí smlouvy.', type, keywords: ['nájem'], folder: 'Práce / Smlouvy' });

  async function make(type: string, riskAnswer?: string | Error) {
    vi.resetModules();
    vi.doMock('../src/main/pipeline', () => ({ ask: (...a: unknown[]) => ask(...a), connect, loadModel }));
    const { makeCard } = await import('../src/main/make-card');
    const saved: { risks?: unknown }[] = [];
    const library = { folders: [], assign: {} };
    const s = {
      appRoot: '/x',
      segments: async () => segments,
      library: async () => library,
      updateLibrary: async (fn: (l: typeof library) => unknown) => fn(library),
      saveCard: async (_id: string, c: { risks?: unknown }) => void saved.push(c),
      saveJob: async () => undefined,
    };
    ask.mockResolvedValueOnce(cardAnswer(type));
    if (riskAnswer instanceof Error) ask.mockRejectedValueOnce(riskAnswer);
    else if (riskAnswer) ask.mockResolvedValueOnce(riskAnswer);
    const card = await makeCard(s as never, { id: 'j1', ext: '.txt', targetLang: 'cs' } as never, settings());
    return { card, saved };
  }

  beforeEach(() => ask.mockReset());

  it('u smlouvy se rizika zkontrolují a uloží do karty', async () => {
    const { card, saved } = await make('contract', answer);
    expect(card.risks).toHaveLength(1);
    expect(saved[0].risks).toHaveLength(1);
  });

  it('u faktury a článku se rizika nekontrolují', async () => {
    for (const type of ['invoice', 'article']) {
      ask.mockReset();
      const { card } = await make(type);
      expect(card.risks).toBeUndefined();
      expect(ask).toHaveBeenCalledTimes(1);
    }
  });

  it('selhání kontroly kartu neshodí', async () => {
    const { card } = await make('contract', new Error('model spadl'));
    expect(card.summary).toBe('Shrnutí smlouvy.');
    expect(card.risks).toBeUndefined();
  });
});
