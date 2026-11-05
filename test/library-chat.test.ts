import { beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../src/shared/i18n';
import type { ChatMessage, DocumentCard, Job, Library, Segment } from '../src/shared/types';

const ask = vi.fn<(...args: unknown[]) => Promise<string>>();
vi.mock('../src/main/pipeline', () => ({
  ask: (...args: unknown[]) => ask(...args),
  askStream: vi.fn(),
  connect: async () => ({ provider: 'local', baseUrl: '', headers: {} }),
  loadModel: async () => undefined,
}));
vi.mock('../src/main/keystore', () => ({ readKey: async () => 'key' }));

const {
  askLibrary,
  isOrganizeRequest,
  buildCorpus,
  cardHits,
  cardText,
  catalogDocs,
  factsText,
  libraryDocs,
  LIMITS,
  parseRoute,
  pickPassages,
} = await import('../src/main/library-chat');

const job = (id: string, over: Partial<Job> = {}) => ({ id, name: id, ext: '.pdf', status: 'done', sourceLang: 'en', targetLang: 'cs', createdAt: 0, ...over }) as Job;
const card = (over: Partial<DocumentCard> = {}): DocumentCard => ({ summary: '', type: 'other', keywords: [], biblio: { authors: [], title: '' }, lang: 'cs', createdAt: 0, ...over });
const seg = (id: number, source: string, extra: Partial<Segment> = {}): Segment => ({ id, kind: 'paragraph', source, ...extra });

const library: Library = {
  folders: [
    { id: 'invoices', createdAt: 0 },
    { id: 'secret', name: 'Tajné', createdAt: 0, locked: true },
  ],
  assign: { rent: { folder: 'invoices' }, diary: { folder: 'secret' } },
};

describe('libraryDocs', () => {
  const jobs = [job('rent'), job('diary'), job('paper'), job('running', { status: 'running' })];

  it('vynechá zamčené složky a nehotové úlohy', () => {
    expect(libraryDocs(jobs, {}, library).map((d) => d.job.id)).toEqual(['rent', 'paper']);
  });

  it('omezí hledání na složku', () => {
    expect(libraryDocs(jobs, {}, library, 'invoices').map((d) => d.job.id)).toEqual(['rent']);
  });

  it('zamčená složka zvolená výslovně nic nevrátí', () => {
    expect(libraryDocs(jobs, {}, library, 'secret')).toEqual([]);
  });

  it('připojí kartu a název složky', () => {
    const [doc] = libraryDocs([job('rent')], { rent: card({ summary: 'Nájem' }) }, library);
    expect(doc.card?.summary).toBe('Nájem');
    expect(doc.folder).toBeTruthy();
  });
});

describe('katalog karet', () => {
  const docs = [
    { job: job('a'), card: card({ type: 'invoice', summary: 'Faktura za nájem bytu', facts: { supplier: 'Bytové družstvo', amount: '12 500 Kč', due: '2025-03-15', parties: ['A', 'B'] } }) },
    { job: job('b'), card: card({ type: 'article', summary: 'Článek o fotosyntéze', keywords: ['rostliny'] }) },
    { job: job('c') },
  ];

  it('fakta jako text bez prázdných polí', () => {
    expect(factsText({ supplier: 'X', amount: '', parties: ['A', 'B'] })).toBe('supplier: X; parties: A, B');
    expect(factsText(undefined)).toBe('');
  });

  it('řádek obsahuje typ, shrnutí i fakta a umí zkrátit shrnutí', () => {
    const line = cardText(docs[0]);
    expect(line).toContain('a.pdf');
    expect(line).toContain('invoice');
    expect(line).toContain('due: 2025-03-15');
    expect(cardText(docs[0], 6)).toContain('Faktur…');
  });

  it('BM25 nad kartou najde dokument podle shrnutí nebo faktů', () => {
    expect(cardHits(docs, 'nájem', 3)).toEqual([0]);
    expect(cardHits(docs, 'Bytové družstvo', 3)).toEqual([0]);
    expect(cardHits(docs, 'rostliny', 3)).toEqual([1]);
  });

  it('katalog vezme všechny, když se vejdou; jinak shody napřed', () => {
    expect(catalogDocs(docs, 'cokoli', LIMITS.local)).toEqual([0, 1, 2]);
    const tight = { ...LIMITS.local, catalog: cardText(docs[1], LIMITS.local.line).length + 10 };
    expect(catalogDocs(docs, 'fotosyntéza', tight)).toEqual([1]);
  });
});

describe('isOrganizeRequest', () => {
  it.each([
    'kam by si zařadil tento článek od adobe?',
    'kam bys ho přesunul? do jaké kategorie?',
    'Roztřiď mi články do podsložek',
    'vytvoř podsložky na jednotlivé články',
    'kam to patří?',
    'move this to a folder',
    'where would you put this article?',
  ])('příkaz: %s', (q) => expect(isOrganizeRequest(q)).toBe(true));

  it.each(['Kdy jsme platili nájem?', 'Co je ve složce Faktury?', 'Kde se psalo o sociálním kapitálu?', 'where is the invoice from May?'])('dotaz: %s', (q) =>
    expect(isOrganizeRequest(q)).toBe(false),
  );
});

describe('parseRoute', () => {
  it('přečte id v různých tvarech a zahodí mimo katalog', () => {
    const r = parseRoute('```json\n{"docs": [2, "D1", "[3]", 9, 2], "terms": ["nájem", " rent ", ""], "clarify": ""}\n```', 3);
    expect(r).toEqual({ docs: [1, 0, 2], terms: ['nájem', 'rent'], clarify: '', organize: false, scope: '' });
  });

  it('nečitelná odpověď = prázdný výběr', () => {
    expect(parseRoute('nevím', 3)).toEqual({ docs: [], terms: [], clarify: '', organize: false, scope: '' });
  });

  it('příkaz roztřídit', () => {
    expect(parseRoute('{"action": "Organize", "scope": "Studium / Články", "docs": []}', 3)).toMatchObject({ organize: true, scope: 'Studium / Články' });
  });

  it('doplňující otázka', () => {
    expect(parseRoute('{"docs": [], "clarify": "Který dokument myslíš?"}', 3).clarify).toBe('Který dokument myslíš?');
  });
});

describe('buildCorpus / pickPassages', () => {
  const a = { job: job('a'), card: card({ type: 'invoice', facts: { amount: '100 Kč' } }) };
  const b = { job: job('b') };
  const corpus = buildCorpus([
    { doc: a, items: [{ id: 7, page: 1, heading: false, text: 'Nájemné za březen', search: 'Nájemné za březen' }] },
    { doc: b, items: [{ id: 3, page: 2, heading: false, text: 'Smlouva o dílo', search: 'Smlouva o dílo' }, { id: 4, page: 5, heading: false, text: 'Výpovědní lhůta', search: 'Výpovědní lhůta' }] },
  ]);

  it('čísluje úseky napříč dokumenty a pamatuje si segment a stránku', () => {
    expect(corpus.items.map((p) => p.id)).toEqual([1, 2, 3, 4, 5]);
    expect(corpus.refs.get(5)).toEqual({ n: 5, jobId: 'b', segment: 4, page: 5 });
    expect(corpus.refs.get(1)).toEqual({ n: 1, jobId: 'a', segment: 7, page: 1 });
    expect(corpus.items[0]).toMatchObject({ heading: true, text: expect.stringContaining('facts: amount: 100 Kč') });
  });

  it('k zásahu přidá úvod jeho dokumentu, ne cizího', () => {
    const { chosen, hits } = pickPassages(corpus, 'výpovědní', 10000);
    expect(chosen.map((p) => p.id)).toEqual([3, 5]);
    expect(hits).toBe(1);
  });

  it('dokument vybraný modelem dostane úvod i bez zásahu', () => {
    const { chosen, hits } = pickPassages(corpus, 'xyz', 10000, ['a']);
    expect(chosen.map((p) => p.id)).toEqual([1]);
    expect(hits).toBe(0);
  });
});

describe('askLibrary', () => {
  let saved: ChatMessage[] = [];
  const store = {
    root: '/tmp',
    jobs: async () => [job('rent'), job('paper'), job('diary')],
    card: async (id: string) =>
      id === 'rent' ? card({ type: 'invoice', summary: 'Faktura za nájem bytu', facts: { subject: 'nájem', due: '2025-03-15' } }) : id === 'paper' ? card({ summary: 'Článek o fotosyntéze' }) : null,
    library: async () => library,
    libraryChat: async () => [] as ChatMessage[],
    saveLibraryChat: async (m: ChatMessage[]) => void (saved = m),
    segments: async (id: string) =>
      ({
        rent: [seg(10, 'Faktura č. 5', { page: 1 }), seg(11, 'Nájemné za březen splatné 15. 3. 2025', { page: 1 })],
        paper: [seg(20, 'Photosynthesis converts light', { page: 3 })],
        diary: [seg(30, 'Tajný nájem', { page: 1 })],
      })[id] ?? [],
  };
  const settings = { provider: 'local', models: { polish: 'm' }, remoteModels: { polish: 'r' } } as never;

  beforeEach(() => {
    ask.mockReset();
    saved = [];
  });

  it('vybere dokument, najde úsek a citace převede na dokument a segment', async () => {
    ask.mockResolvedValueOnce('{"docs": [1], "terms": ["nájemné"], "clarify": ""}').mockResolvedValueOnce('Nájem byl splatný 15. 3. 2025 [3].');
    const reply = await askLibrary(store as never, settings, 'Kdy jsme platili nájem?');
    expect(reply.steps?.length).toBeGreaterThan(2);
    expect(reply.refs).toEqual([{ n: 3, jobId: 'rent', segment: 11, page: 1 }]);
    expect(reply.text).toBe('Nájem byl splatný 15. 3. 2025 [3].');
    expect(saved).toHaveLength(2);
    const system = (ask.mock.calls[1][2] as { content: string }[])[0].content;
    expect(system).not.toContain('Tajný');
    // Zamčená složka se nedostane ani do katalogu.
    expect((ask.mock.calls[0][2] as { content: string }[])[0].content).not.toContain('diary');
  });

  it('bez výběru a bez zásahu nevolá model podruhé a požádá o upřesnění', async () => {
    ask.mockResolvedValueOnce('{"docs": [], "terms": [], "clarify": "Co přesně hledáš?"}');
    const reply = await askLibrary(store as never, settings, 'qwerty', undefined, undefined);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(reply.text).toBe('Co přesně hledáš?');
    expect(reply.docs).toBe(2);
  });

  it('bez doplňující otázky obecná hláška', async () => {
    ask.mockResolvedValueOnce('nic');
    expect((await askLibrary(store as never, settings, 'qwerty')).text).toBe(t('libraryChat.notFound'));
  });

  it('bez zásahu ve vybraných hledá ve všech', async () => {
    ask.mockResolvedValueOnce('{"docs": [1], "terms": []}').mockResolvedValueOnce('Light [4].');
    const reply = await askLibrary(store as never, settings, 'photosynthesis light');
    expect(reply.docs).toBe(2);
    expect(reply.refs?.[0]).toMatchObject({ jobId: 'paper', segment: 20 });
  });

  it('příkaz roztřídit vrátí návrh místo odpovědi a nic nezmění', async () => {
    ask
      .mockResolvedValueOnce('{"action": "organize", "scope": "", "docs": []}')
      .mockResolvedValueOnce('{"folders": [{"path": "Ekonomie", "docs": [2]}], "questions": [{"doc": 1, "options": ["Bydlení", "Faktury"]}]}');
    const reply = await askLibrary(store as never, settings, 'Roztřiď mi dokumenty do složek');
    expect(ask).toHaveBeenCalledTimes(2);
    expect(reply.plan).toEqual({ folders: [{ path: 'Ekonomie', jobIds: ['paper'] }], questions: [{ jobId: 'rent', options: ['Bydlení', 'Faktury'], at: expect.any(Number) }] });
    expect(reply.text).toBe(t('organize.proposal', { count: 2 }));
  });

  it('„kam bys zařadil tento článek“ navrhne jen pro vybraný dokument', async () => {
    ask
      .mockResolvedValueOnce('{"action": "organize", "scope": "", "docs": [1]}')
      .mockResolvedValueOnce('{"folders": [{"path": "Studium / Články / Biologie", "docs": [1]}], "questions": []}');
    const reply = await askLibrary(store as never, settings, 'Kam bys zařadil článek o fotosyntéze?');
    const prompt = (ask.mock.calls[1][2] as { content: string }[])[0].content;
    expect(prompt).toContain('paper.pdf');
    expect(prompt).not.toContain('rent.pdf');
    // Zamčená složka se modelu neukáže ani názvem.
    expect(prompt).not.toContain('Tajné');
    expect(reply.plan?.folders).toEqual([{ path: 'Studium / Články / Biologie', jobIds: ['paper'] }]);
  });

  it('model řekne search, ale otázka je na zařazení: stejně návrh', async () => {
    ask
      .mockResolvedValueOnce('{"action": "search", "docs": [1], "terms": []}')
      .mockResolvedValueOnce('{"folders": [{"path": "Bydlení", "docs": [1]}], "questions": []}');
    const reply = await askLibrary(store as never, settings, 'Kam bys zařadil fakturu za nájem?');
    expect(reply.plan?.folders).toEqual([{ path: 'Bydlení', jobIds: ['rent'] }]);
  });

  it('„toto“ = dokument, na který se uživatel dívá', async () => {
    ask
      .mockResolvedValueOnce('{"action": "organize", "scope": "", "docs": []}')
      .mockResolvedValueOnce('{"folders": [{"path": "Faktury / Bydlení", "docs": [1]}], "questions": []}');
    const reply = await askLibrary(store as never, settings, 'kam by si zařadil toto?', undefined, undefined, ['rent']);
    const route = (ask.mock.calls[0][2] as { content: string }[])[0].content;
    expect(route).toContain('[1] rent.pdf');
    expect(route).toContain('looking at documents [1]');
    const plan = (ask.mock.calls[1][2] as { content: string }[])[0].content;
    expect(plan).toContain('rent.pdf');
    expect(plan).not.toContain('paper.pdf');
    expect(reply.plan?.folders).toEqual([{ path: 'Faktury / Bydlení', jobIds: ['rent'] }]);
  });

  it('prázdná knihovna = chyba', async () => {
    await expect(askLibrary(store as never, settings, 'x', undefined, 'secret')).rejects.toThrow();
  });
});
