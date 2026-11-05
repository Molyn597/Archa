import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/main/store';
import { bibliography, bibliographyHtml, bibliographyText, gaps } from '../src/shared/bibliography';
import { setLang } from '../src/shared/i18n';
import { addSources, isStudy, newProject, PROJECT_KINDS } from '../src/shared/projects';
import type { DocumentCard, Job } from '../src/shared/types';

const job = (id: string) => ({ id, name: `soubor-${id}`, ext: '.pdf', status: 'done', createdAt: 1 }) as Job;
const card = (title: string, family: string, year?: string, type: DocumentCard['type'] = 'article') =>
  ({ summary: '', type, keywords: [], lang: 'cs', createdAt: 1, biblio: { title, year, authors: family ? [{ family, given: 'A.' }] : [], container: 'Journal' } }) as DocumentCard;

describe('projekty', () => {
  afterEach(() => setLang('cs'));

  it('nový projekt: osnova ze šablony v jazyce rozhraní, prázdný název = druh', () => {
    const p = newProject('  ', 'bachelor', 'apa7', 'id1', 5);
    expect(p).toMatchObject({ id: 'id1', name: 'Bakalářská práce', kind: 'bachelor', style: 'apa7', sources: [], createdAt: 5, updatedAt: 5 });
    expect(p.outline.split('\n')).toContain('  Přehled literatury');
    setLang('en');
    expect(newProject('X', 'seminar', 'iso690', 'id2').outline.startsWith('Introduction')).toBe(true);
    expect(newProject('X', 'other', 'iso690', 'id3').outline).toBe('');
  });

  it('každý druh má název a šablonu; studijní jsou jen práce', () => {
    for (const kind of PROJECT_KINDS) expect(newProject('', kind, 'iso690', 'x').name).not.toMatch(/^project\./);
    expect(PROJECT_KINDS.filter(isStudy)).toEqual(['seminar', 'bachelor', 'master', 'dissertation']);
  });

  it('zdroje bez opakování, v pořadí přidání', () => {
    const p = newProject('P', 'seminar', 'iso690', 'p');
    expect(addSources(p, ['a', 'b'])).toBe(2);
    expect(addSources(p, ['b', 'c', 'a'])).toBe(1);
    expect(p.sources).toEqual(['a', 'b', 'c']);
  });

  it('Store: uložit, seznam od naposledy upraveného, smazat', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tl-proj-'));
    try {
      const store = new Store(root);
      expect(await store.projects()).toEqual([]);
      await store.saveProject({ ...newProject('A', 'seminar', 'iso690', 'a'), updatedAt: 1 });
      await store.saveProject({ ...newProject('B', 'work', 'iso690', 'b'), updatedAt: 2 });
      expect((await store.projects()).map((p) => p.id)).toEqual(['b', 'a']);
      await store.deleteProject('b');
      expect((await store.projects()).map((p) => p.id)).toEqual(['a']);
      expect(await store.project('b')).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('seznam literatury', () => {
  it('chybějící údaje karty', () => {
    expect(gaps(null)).toEqual(['card']);
    expect(gaps(card('', '', ''))).toEqual(['title', 'author', 'year']);
    expect(gaps(card('Titul', 'Novák', '2020'))).toEqual([]);
  });

  it('abecedně podle citace (diakritika česky), bez karty jen mezi chybějícími', () => {
    const { entries, missing } = bibliography(
      [
        { job: job('1'), card: card('Zweite', 'Žák', '2019') },
        { job: job('2'), card: card('Erste', 'Adams', '2020') },
        { job: job('3'), card: null },
        { job: job('4'), card: card('Třetí', 'Čapek') },
      ],
      'iso690',
      'cs',
      '2026-11-05',
    );
    expect(entries.map((e) => e.jobId)).toEqual(['2', '4', '1']);
    expect(entries[1]!.gaps).toEqual(['year']);
    expect(missing).toEqual([{ jobId: '3', parts: [{ text: 'soubor-3' }], gaps: ['card'] }]);
  });

  it('text a HTML do schránky; APA jiný tvar než ISO', () => {
    const src = [{ job: job('1'), card: card('Title', 'Adams', '2020') }];
    const iso = bibliography(src, 'iso690', 'cs').entries;
    const apa = bibliography(src, 'apa7', 'cs').entries;
    expect(bibliographyText(iso)).toContain('ADAMS');
    expect(bibliographyText(apa)).toContain('Adams, A. (2020)');
    expect(bibliographyHtml(apa)).toMatch(/^<p>.*<i>Journal<\/i>.*<\/p>$/);
  });
});
