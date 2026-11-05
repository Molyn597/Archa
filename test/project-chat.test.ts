import { beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../src/shared/i18n';
import type { ChatMessage, Job, Library, Project, Segment } from '../src/shared/types';

const ask = vi.fn<(...args: unknown[]) => Promise<string>>();
vi.mock('../src/main/pipeline', () => ({
  ask: (...args: unknown[]) => ask(...args),
  askStream: vi.fn(),
  connect: async () => ({ provider: 'local', baseUrl: '', headers: {} }),
  loadModel: async () => undefined,
}));
vi.mock('../src/main/keystore', () => ({ readKey: async () => 'key' }));

const { askProject } = await import('../src/main/project-chat');

const job = (id: string) => ({ id, name: id, ext: '.pdf', status: 'done', sourceLang: 'en', targetLang: 'cs', createdAt: 0 }) as Job;
const seg = (id: number, source: string, page: number): Segment => ({ id, kind: 'paragraph', source, page });
const library: Library = { folders: [{ id: 'secret', name: 'Tajné', createdAt: 0, locked: true }], assign: { diary: { folder: 'secret' } } };
const project = (sources: string[], extra: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'Hodnocení výkonu',
  kind: 'bachelor',
  assignment: 'Zhodnotit roční hodnocení zaměstnanců.',
  outline: 'Úvod\nTeorie',
  notes: '',
  sources,
  style: 'apa7',
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

describe('askProject', () => {
  let saved: { id: string; messages: ChatMessage[] } | null = null;
  const store = {
    root: '/tmp',
    jobs: async () => [job('sutton'), job('adobe'), job('other'), job('diary')],
    card: async () => null,
    library: async () => library,
    projectChat: async () => [] as ChatMessage[],
    saveProjectChat: async (id: string, messages: ChatMessage[]) => void (saved = { id, messages }),
    segments: async (id: string) =>
      ({
        sutton: [seg(10, 'Annual performance reviews often do more harm than good.', 4)],
        adobe: [seg(20, 'Adobe replaced annual reviews with regular check-ins.', 2)],
        other: [seg(30, 'Annual reviews in photosynthesis research.', 1)],
        diary: [seg(40, 'Secret annual reviews diary.', 1)],
      })[id] ?? [],
  };
  const settings = { provider: 'local', models: { polish: 'm' }, remoteModels: { polish: 'r' } } as never;

  beforeEach(() => {
    ask.mockReset();
    saved = null;
  });

  it('jen zdroje projektu (bez zamčených), zadání v promptu, citace → dokument a strana', async () => {
    ask.mockResolvedValueOnce('Roční hodnocení často škodí [2]. Adobe je nahradilo [4].');
    const reply = await askProject(store as never, settings, project(['sutton', 'adobe', 'diary']), 'Co říkají zdroje o ročním hodnocení (annual reviews)?');
    const system = (ask.mock.calls[0][2] as { content: string }[])[0].content;
    expect(system).toContain('Zhodnotit roční hodnocení');
    expect(system).toContain('Bakalářská práce');
    expect(system).not.toContain('photosynthesis');
    expect(system).not.toContain('Secret');
    expect(reply.docs).toBe(2);
    expect(reply.refs).toEqual([
      { n: 2, jobId: 'sutton', segment: 10, page: 4 },
      { n: 4, jobId: 'adobe', segment: 20, page: 2 },
    ]);
    expect(saved?.id).toBe('p1');
    expect(saved?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('návrh textu bez shody v dotazu hledá podle zadání', async () => {
    ask.mockResolvedValueOnce('Úvod… [2]');
    const reply = await askProject(store as never, settings, project(['sutton', 'adobe'], { assignment: 'performance reviews harm' }), 'Napiš úvod.');
    expect(ask).toHaveBeenCalledTimes(1);
    expect(reply.refs?.[0]).toMatchObject({ jobId: 'sutton', page: 4 });
  });

  it('bez zásahu nevolá model a řekne, že ve zdrojích nic není', async () => {
    const reply = await askProject(store as never, settings, project(['sutton'], { assignment: '' }), 'qwerty');
    expect(ask).not.toHaveBeenCalled();
    expect(reply.text).toBe(t('projectChat.notFound'));
  });

  it('projekt bez dostupných zdrojů = chyba', async () => {
    await expect(askProject(store as never, settings, project(['diary']), 'cokoli')).rejects.toThrow(t('projectChat.empty'));
  });
});
