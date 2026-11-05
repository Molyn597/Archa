import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, Job, Settings } from '../src/shared/types';

// Falešný embedding model: vektor podle témat ve slovníku (důvěra/trust = osa 0, nájem/rent = osa 1, jiné = osa 2).
const AXES = [/d[ůu]v[ěe]r|trust/i, /n[áa]jem|rent/i];
const fake = (text: string) => {
  const v = AXES.map((re) => (re.test(text) ? 1 : 0));
  return Float32Array.from([...v, v.some(Boolean) ? 0 : 1]);
};
const embedCalls: string[][] = [];
vi.mock('../src/main/embed', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/main/embed')>();
  return {
    ...orig,
    embedder: async (settings: Settings) =>
      orig.embedModelFor(settings) && {
        model: orig.embedModelFor(settings)!,
        embed: async (texts: string[]) => (embedCalls.push(texts), texts.map((t) => orig.normalize(fake(t)))),
      },
  };
});
const ask = vi.fn<(...args: unknown[]) => Promise<string>>();
vi.mock('../src/main/pipeline', () => ({
  ask: (...args: unknown[]) => ask(...args),
  askStream: vi.fn(),
  connect: async () => ({ provider: 'local', baseUrl: '', headers: {} }),
  loadModel: async () => undefined,
}));
vi.mock('../src/main/keystore', () => ({ readKey: async () => 'key' }));

const { buildIndex, dot, embedder, embedPrefix, loadIndex, normalize, rrf } = await import('../src/main/embed');
const { askLibrary } = await import('../src/main/library-chat');
const { Store } = await import('../src/main/store');

describe('pomocné funkce', () => {
  it('rrf: položka vysoko v obou pořadích vyhraje', () => {
    expect(rrf([['a', 'b', 'c'], ['c', 'b', 'a'], ['b']], (x) => x)).toEqual(['b', 'a', 'c']);
  });
  it('normalize + dot = kosinová podobnost', () => {
    expect(dot(normalize([3, 4]), normalize([3, 4]))).toBeCloseTo(1);
    expect(dot(normalize([1, 0]), normalize([0, 2]))).toBeCloseTo(0);
  });
  it('předpony podle rodiny modelu', () => {
    expect(embedPrefix('multilingual-e5-large', 'query')).toBe('query: ');
    expect(embedPrefix('text-embedding-nomic-embed-text-v1.5', 'passage')).toBe('search_document: ');
    expect(embedPrefix('openai/text-embedding-3-small', 'query')).toBe('');
  });
});

describe('index a hybridní hledání', () => {
  let root: string;
  let store: InstanceType<typeof Store>;
  const settings = { provider: 'local', models: { polish: 'm' }, remoteModels: { polish: 'r' }, embedModels: { local: 'e5' } } as unknown as Settings;
  const job = (id: string) => ({ id, name: id, ext: '.pdf', mode: 'fast', sourceLang: 'en', targetLang: 'cs', status: 'done', createdAt: 1 }) as Job;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'embed-'));
    store = new Store(root);
    embedCalls.length = 0;
    ask.mockReset();
    await store.saveJob(job('paper'));
    await store.saveJob(job('rent'));
    await store.saveSegments('paper', [
      { id: 1, kind: 'paragraph', source: 'Economic freedom and growth in fifty countries.', page: 1 },
      { id: 2, kind: 'paragraph', source: 'Generalized trust in institutions rises with the rule of law.', page: 4 },
    ]);
    await store.saveSegments('rent', [{ id: 9, kind: 'paragraph', source: 'Faktura za nájem bytu, splatnost 15. 3. 2025.', page: 1 }]);
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('index se uloží a načte jen pro stejný model', async () => {
    const emb = (await embedder(settings, root))!;
    await buildIndex(store, 'paper', 'paper', emb);
    const index = (await loadIndex(store, 'paper', 'e5'))!;
    expect(index.ids).toEqual([1, 2]);
    expect(index.vectors[1][0]).toBeCloseTo(1);
    expect(await loadIndex(store, 'paper', 'jiný-model')).toBeUndefined();
  });

  it('dotaz bez společných slov najde úsek podle významu', async () => {
    const emb = (await embedder(settings, root))!;
    await buildIndex(store, 'paper', 'paper', emb);
    await buildIndex(store, 'rent', 'rent', emb);
    ask.mockResolvedValueOnce('{"action": "search", "docs": [], "terms": []}').mockResolvedValueOnce('O důvěře se píše v článku [3].');
    const reply = await askLibrary(store, settings, 'Kde se psalo o důvěře?');
    expect(reply.steps?.some((s) => s.includes(t('libraryChat.stepSemantic')))).toBe(true);
    const system = (ask.mock.calls[1][2] as { content: string }[])[0].content;
    expect(system).toContain('Generalized trust');
    expect(reply.refs?.[0]).toMatchObject({ jobId: 'paper', segment: 2, page: 4 });
    expect(embedCalls.at(-1)).toEqual(['Kde se psalo o důvěře?']);
  });

  it('bez embedding modelu se hledá jen podle slov a nic se nevektorizuje', async () => {
    // Odpověď cituje číslo úseku s nájmem podle toho, jak ho aplikace očíslovala.
    const cite = (...args: unknown[]) => {
      const system = (args[2] as { content: string }[])[0].content;
      return Promise.resolve(`Nájem [${/\[(\d+)\][^\n]*Faktura za nájem/.exec(system)?.[1]}].`);
    };
    ask.mockResolvedValueOnce('{"action": "search", "docs": [], "terms": []}').mockImplementationOnce(cite);
    const reply = await askLibrary(store, { ...settings, embedModels: undefined }, 'Kdy jsme platili nájem?');
    expect(embedCalls).toEqual([]);
    expect(reply.refs?.[0]).toMatchObject({ jobId: 'rent', segment: 9 });
  });
});

const { t } = await import('../src/shared/i18n');
void (null as unknown as ChatMessage);
