import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentCard, Job, Library, PracticeSet, Project, Segment, Settings } from '../src/shared/types';

const ask = vi.fn<(...args: unknown[]) => Promise<string>>();
const loadModel = vi.fn(async () => undefined);
vi.mock('../src/main/pipeline', () => ({ ask: (...args: unknown[]) => ask(...args), connect: async () => ({}), loadModel: () => loadModel() }));
vi.mock('../src/main/keystore', () => ({ readKey: async () => 'key' }));

const { buildPractice, explainPrompt, explainQuestion, gradePractice, parsePractice, passageFor, practiceDue, practicePrompt, practiceState } = await import('../src/main/practice');

const job = (id: string, createdAt: number, extra: Partial<Job> = {}) => ({ id, name: `doc-${id}`, ext: '.pdf', status: 'done', createdAt, ...extra }) as Job;
const card = (type: DocumentCard['type'], title = ''): DocumentCard => ({ summary: '', type, keywords: [], biblio: { authors: [], title }, lang: 'cs', createdAt: 0 });
const seg = (id: number, page: number, source: string): Segment => ({ id, kind: 'paragraph', page, source });

function makeStore(opts: { jobs: Job[]; cards?: Record<string, DocumentCard>; library: Library; projects?: Project[]; segments?: Record<string, Segment[]> }) {
  const sets = new Map<string, PracticeSet>();
  return {
    sets,
    appRoot: '/x',
    library: async () => opts.library,
    jobs: async () => opts.jobs,
    job: async (id: string) => opts.jobs.find((j) => j.id === id) ?? null,
    card: async (id: string) => opts.cards?.[id] ?? null,
    segments: async (id: string) => opts.segments?.[id] ?? [seg(1, 1, `Text ${id}.`)],
    project: async (id: string) => opts.projects?.find((p) => p.id === id) ?? null,
    projects: async () => opts.projects ?? [],
    practice: async (scope: string) => structuredClone(sets.get(scope) ?? null),
    savePractice: async (set: PracticeSet) => void sets.set(set.scope, structuredClone(set)),
    practiceSets: async () => [...sets.values()],
  };
}

const library: Library = {
  folders: [
    { id: 'mgmt', name: 'Management', createdAt: 0 },
    { id: 'hr', name: 'HR', parent: 'mgmt', createdAt: 0 },
    { id: 'priv', name: 'Soukromé', parent: 'mgmt', createdAt: 0, locked: true },
    { id: 'eco', name: 'Ekonomie', createdAt: 0 },
  ],
  assign: { a: { folder: 'mgmt' }, b: { folder: 'hr' }, c: { folder: 'priv' }, d: { folder: 'mgmt' }, e: { folder: 'eco' }, f: { folder: 'mgmt' } },
};
const settings = { provider: 'local', targetLang: 'cs' } as Settings;

const answer = () =>
  JSON.stringify({
    cards: [
      { front: ' Co je Check-in? ', back: 'Průběžný rozhovor.', source: 1, page: 2 },
      { front: 'co je check-in?', back: 'Duplicita.', source: 1 },
      { front: 'Bez zdroje', back: 'x', source: 9 },
      { front: '', back: 'x', source: 1 },
      { front: 'Strana textem', back: 'y', source: 'S2', page: 'abc' },
    ],
    questions: [
      { question: 'Co nahradilo hodnocení?', options: ['Check-in', '360°', 'KPI', 'Nic'], answer: 0, source: 2, page: 3 },
      { question: 'Málo možností', options: ['a', 'b'], answer: 0, source: 1 },
      { question: 'Opakované možnosti', options: ['a', 'A', 'b'], answer: 0, source: 1 },
      { question: 'Mimo rozsah', options: ['a', 'b', 'c'], answer: 3, source: 1 },
    ],
  });

describe('parsePractice', () => {
  it('zahodí prázdné, duplicitní, bez zdroje a vadné otázky; neplatná strana se jen vynechá', () => {
    const r = parsePractice(answer(), ['j1', 'j2'])!;
    expect(r.cards.map((c) => [c.front, c.source, c.page])).toEqual([
      ['Co je Check-in?', 'j1', 2],
      ['Strana textem', 'j2', undefined],
    ]);
    expect(r.questions).toHaveLength(1);
    const q = r.questions[0];
    expect(q.options[q.answer]).toBe('Check-in');
    expect([q.source, q.page]).toEqual(['j2', 3]);
    expect(r.cards[0].id).not.toBe(r.cards[1].id);
  });

  it('omezí počet na 15 kartiček a 10 otázek', () => {
    const cards = Array.from({ length: 20 }, (_, i) => ({ front: `F${i}`, back: 'b', source: 1 }));
    const questions = Array.from({ length: 12 }, (_, i) => ({ question: `Q${i}`, options: ['a', 'b', 'c'], answer: 1, source: 1 }));
    const r = parsePractice(JSON.stringify({ cards, questions }), ['j1'])!;
    expect([r.cards.length, r.questions.length]).toEqual([15, 10]);
  });

  it('nic použitelného = undefined', () => {
    expect(parsePractice('nevím', ['j1'])).toBeUndefined();
    expect(parsePractice('{"cards": [{"front": "x", "back": "y", "source": 5}], "questions": []}', ['j1'])).toBeUndefined();
  });
});

describe('buildPractice', () => {
  beforeEach(() => {
    ask.mockReset();
    loadModel.mockClear();
  });

  it('zdroje složky i s podsložkami, bez zamčených, faktur, smluv a nehotových; nejnovější první', async () => {
    const jobs = [job('f', 6, { status: 'error' }), job('e', 5), job('d', 4), job('c', 3), job('b', 2), job('a', 1)];
    const store = makeStore({ jobs, library, cards: { d: card('invoice'), b: card('article', 'Hodnocení výkonu') } });
    ask.mockResolvedValueOnce(answer());
    const state = await buildPractice(store as never, settings, 'folder:mgmt');
    expect(state.set?.sources).toEqual(['b', 'a']);
    expect(state.title).toBe('Management');
    expect(state.titles.b).toBe('Hodnocení výkonu');
    const prompt = (ask.mock.calls[0][2] as { content: string }[])[0].content;
    expect(prompt).toContain('in Czech');
    expect(prompt).toContain('[S1] Hodnocení výkonu\n[p. 1]\n\nText b.');
    expect(prompt).toContain('[S2] doc-a');
    expect(prompt).not.toContain('Text c.');
    expect(store.sets.get('folder:mgmt')?.cards[0].source).toBe('b');
    expect(loadModel).toHaveBeenCalled();
  });

  it('projekt: zdroje v pořadí od naposledy přidaného, nejvýš 10', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const project = { id: 'pr', name: 'Seminárka', kind: 'seminar', sources: ids } as Project;
    const store = makeStore({ jobs: ids.map((id, i) => job(id, i)), library: { folders: [], assign: {} }, projects: [project] });
    const before = await practiceState(store as never, 'project:pr');
    expect([before.total, before.sources.length, before.sources[0], before.set]).toEqual([12, 10, 'p11', null]);
    ask.mockResolvedValueOnce(answer());
    const state = await buildPractice(store as never, settings, 'project:pr');
    expect(state.set?.sources).toEqual(ids.slice(2).reverse());
  });

  it('bez zdrojů se model nevolá, nečitelná odpověď = chyba', async () => {
    const store = makeStore({ jobs: [job('a', 1)], library });
    await expect(buildPractice(store as never, settings, 'folder:eco')).rejects.toThrow();
    expect(ask).not.toHaveBeenCalled();
    ask.mockResolvedValueOnce('nic');
    await expect(buildPractice(store as never, settings, 'folder:mgmt')).rejects.toThrow();
    expect(store.sets.size).toBe(0);
  });
});

describe('hodnocení, vysvětlení a K zopakování', () => {
  const base = (): PracticeSet => ({
    scope: 'folder:mgmt',
    sources: ['a'],
    createdAt: 0,
    cards: [
      { id: 'c1', front: 'F1', back: 'B1', source: 'a' },
      { id: 'c2', front: 'F2', back: 'B2', source: 'a', review: { box: 2, due: '2026-12-01' } },
    ],
    questions: [{ id: 'q1', question: 'Q?', options: ['dobře', 'špatně', 'jinak'], answer: 0, source: 'a', page: 5 }],
  });

  beforeEach(() => ask.mockReset());

  it('gradePractice uloží stav opakování kartičky i otázky', async () => {
    const store = makeStore({ jobs: [job('a', 1)], library });
    await store.savePractice(base());
    await gradePractice(store as never, 'folder:mgmt', 'c1', true, '2026-11-30');
    const set = await gradePractice(store as never, 'folder:mgmt', 'q1', false, '2026-11-30');
    expect(set.cards[0].review).toEqual({ box: 1, due: '2026-12-02' });
    expect(set.questions[0].review).toEqual({ box: 0, due: '2026-12-01' });
  });

  it('explainQuestion: text kolem strany, odpověď se uloží a podruhé se model nevolá', async () => {
    const segments = { a: [seg(1, 1, 'Úvod.'), seg(2, 4, 'Strana čtyři.'), seg(3, 6, 'Strana šest.'), seg(4, 9, 'Daleko.')] };
    const store = makeStore({ jobs: [job('a', 1)], library, segments });
    await store.savePractice(base());
    ask.mockResolvedValueOnce(' Protože zdroj to říká. ');
    expect(await explainQuestion(store as never, settings, 'folder:mgmt', 'q1', 1)).toBe('Protože zdroj to říká.');
    const prompt = (ask.mock.calls[0][2] as { content: string }[])[0].content;
    expect(prompt).toContain("Student's answer: špatně");
    expect(prompt).toContain('Strana čtyři.\n\nStrana šest.');
    expect(prompt).not.toContain('Daleko.');
    expect(await explainQuestion(store as never, settings, 'folder:mgmt', 'q1', 1)).toBe('Protože zdroj to říká.');
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('explainPrompt bez špatné odpovědi a passageFor bez strany', () => {
    const q = base().questions[0];
    const p = explainPrompt(q, 0, 'TEXT', 'en');
    expect(p).toContain('why the correct answer is right, using only');
    expect(p).not.toContain("Student's answer");
    expect(passageFor([seg(1, 1, 'x'.repeat(5000))])).toHaveLength(4000);
    expect(passageFor([seg(1, 1, 'Jen první strana.')], 20)).toBe('Jen první strana.');
  });

  it('practiceDue: jen existující a nezamčené rozsahy, nejvíc kartiček první', async () => {
    const project = { id: 'pr', name: 'Seminárka', kind: 'seminar', sources: [] } as unknown as Project;
    const store = makeStore({ jobs: [], library, projects: [project] });
    await store.savePractice(base());
    await store.savePractice({ ...base(), scope: 'project:pr', cards: [...base().cards, { id: 'c3', front: 'F3', back: 'B3', source: 'a' }] });
    await store.savePractice({ ...base(), scope: 'folder:priv' });
    await store.savePractice({ ...base(), scope: 'folder:gone' });
    expect(await practiceDue(store as never, '2026-11-12')).toEqual({
      total: 3,
      scopes: [
        { scope: 'project:pr', title: 'Seminárka', count: 2 },
        { scope: 'folder:mgmt', title: 'Management', count: 1 },
      ],
    });
  });

  it('practicePrompt čísluje zdroje', () => {
    expect(practicePrompt([{ title: 'A', text: 'x' }, { title: 'B', text: 'y' }], 'en')).toMatch(/SOURCES:\n\[S1\] A\nx\n\n\[S2\] B\ny$/);
  });
});
