import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addFromOpenAlex, downloadPdf, lookupWork, searchWorks } from '../src/main/openalex';
import type { OpenAlexWork } from '../src/shared/openalex';

const pdf = (type = 'application/pdf', body = '%PDF-1.4 test') => new Response(body, { headers: { 'content-type': type } });
const mockFetch = (...responses: Response[]) => {
  const fn = vi.fn();
  responses.forEach((r) => fn.mockResolvedValueOnce(r));
  vi.stubGlobal('fetch', fn);
  return fn;
};
afterEach(() => vi.unstubAllGlobals());

describe('downloadPdf', () => {
  it('přijme application/pdf i PDF s jiným typem', async () => {
    mockFetch(pdf());
    expect((await downloadPdf('https://x.org/a.pdf')).length).toBeGreaterThan(0);
    mockFetch(pdf('application/octet-stream'));
    expect((await downloadPdf('https://x.org/a')).toString().startsWith('%PDF')).toBe(true);
  });
  it('HTML místo PDF, chyba serveru i síťová chyba = čitelná chyba', async () => {
    mockFetch(pdf('text/html', '<html></html>'));
    await expect(downloadPdf('https://x.org/a')).rejects.toThrow('PDF se nepodařilo stáhnout');
    mockFetch(new Response('', { status: 403 }));
    await expect(downloadPdf('https://x.org/a')).rejects.toThrow('PDF se nepodařilo stáhnout');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(downloadPdf('https://x.org/a')).rejects.toThrow('PDF se nepodařilo stáhnout');
  });
  it('příliš velký soubor odmítne podle hlavičky', async () => {
    mockFetch(new Response('%PDF', { headers: { 'content-type': 'application/pdf', 'content-length': String(60 * 1024 * 1024) } }));
    await expect(downloadPdf('https://x.org/a.pdf')).rejects.toThrow();
  });
});

describe('addFromOpenAlex', () => {
  const work: OpenAlexWork = { id: 'W1', title: 'Human: Capital/Growth?', authors: [{ given: 'A', family: 'B' }], year: '2015', pdfUrl: 'https://x.org/a.pdf' };
  it('předá frontě dočasný soubor bez překladu s údaji z OpenAlex, přidá do projektu a soubor smaže', async () => {
    mockFetch(pdf());
    let file = '';
    let content = '';
    const queue = {
      add: vi.fn(async (f: string, options: object) => {
        file = f;
        content = await readFile(f, 'utf8');
        expect(options).toMatchObject({ translate: false, sourceLang: 'auto', biblioHint: { title: work.title, year: '2015' } });
        return 'job1';
      }),
    };
    const project = { id: 'p', sources: ['old'], updatedAt: 0 };
    const store = { settings: async () => ({ mode: 'fast', targetLang: 'cs', provider: 'local' }), project: async () => project, saveProject: vi.fn() };
    expect(await addFromOpenAlex(store as never, queue as never, work, 'p')).toBe('job1');
    expect(content).toContain('%PDF');
    expect(file).toMatch(/Human Capital Growth\.pdf$|Human Capital Growth/);
    expect(existsSync(file)).toBe(false);
    expect(project.sources).toEqual(['old', 'job1']);
    expect(store.saveProject).toHaveBeenCalledOnce();
  });
  it('bez PDF nebo se staženým HTML nic nezařadí', async () => {
    const queue = { add: vi.fn() };
    await expect(addFromOpenAlex({} as never, queue as never, { ...work, pdfUrl: undefined })).rejects.toThrow('PDF');
    mockFetch(pdf('text/html', 'x'));
    await expect(addFromOpenAlex({} as never, queue as never, work)).rejects.toThrow('PDF');
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('hledání', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  it('searchWorks odešle jen dotaz a vrátí práce; chyba = čitelná zpráva', async () => {
    const fn = mockFetch(json({ results: [{ display_name: 'Human capital' }] }));
    expect((await searchWorks('human capital'))[0].title).toBe('Human capital');
    expect(String(fn.mock.calls[0][0])).toContain('search=human%20capital');
    expect(fn.mock.calls[0][1].headers).toEqual({ accept: 'application/json' });
    mockFetch(json({}, 500));
    await expect(searchWorks('x')).rejects.toThrow('OpenAlex teď neodpovídá');
  });
  it('lookupWork: DOI má přednost, jinak název s kontrolou shody', async () => {
    const fn = mockFetch(json({ display_name: 'Z DOI', doi: 'https://doi.org/10.1/x' }));
    expect((await lookupWork({ authors: [], title: 'Jiný', doi: '10.1/x' }))?.title).toBe('Z DOI');
    expect(fn).toHaveBeenCalledOnce();
    mockFetch(json({}, 404), json({ results: [{ display_name: 'Human capital' }] }));
    expect((await lookupWork({ authors: [], title: 'Human Capital', doi: '10.1/nic' }))?.title).toBe('Human capital');
    mockFetch(json({ results: [{ display_name: 'Úplně jiný název práce' }] }));
    expect(await lookupWork({ authors: [], title: 'Human Capital' })).toBeUndefined();
  });
});
