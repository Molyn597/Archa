import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENC, LockedError, Store } from '../src/main/store';
import { cleanHighlights, locate, sliceTexts, sortHighlights, squeezedOffset } from '../src/shared/highlights';
import type { Highlight, Job } from '../src/shared/types';

const hl = (over: Partial<Highlight> = {}): Highlight => ({
  id: 'h1',
  side: 'target',
  from: 1,
  to: 1,
  quote: 'tajná poznámka',
  hint: 0,
  color: 'yellow',
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('dohledání zvýraznění v textu', () => {
  it('najde citát v jednom segmentu', () => {
    expect(locate(['Ahoj světe, jak se máš?'], 'světe')).toEqual({ start: [0, 5], end: [0, 10] });
  });

  it('přes víc segmentů a s jinými mezerami (seznam s odrážkami × bez)', () => {
    const texts = ['- první\n- druhá', 'třetí odstavec'];
    expect(locate(texts, 'první- druhá třetí')).toEqual({ start: [0, 2], end: [1, 5] });
    expect(locate(['prvnídruhá'], 'první\ndruhá')).toEqual({ start: [0, 0], end: [0, 10] });
  });

  it('z opakovaného citátu vybere výskyt nejblíž nápovědě', () => {
    const text = 'ano ne ano ne ano';
    const hint = squeezedOffset(text, 14);
    expect(locate([text], 'ano', hint)).toEqual({ start: [0, 14], end: [0, 17] });
    expect(locate([text], 'ano', 0)?.start).toEqual([0, 0]);
  });

  it('změněný text nebo prázdný citát = nenalezeno', () => {
    expect(locate(['úplně jiný text'], 'světe')).toBeNull();
    expect(locate(['text'], '   ')).toBeNull();
    expect(locate([], 'text')).toBeNull();
  });

  it('text výběru mezi místy', () => {
    expect(sliceTexts(['abc', 'def', 'ghi'], [0, 1], [2, 2])).toBe('bc\ndef\ngh');
    expect(sliceTexts(['abcdef'], [0, 2], [0, 4])).toBe('cd');
  });

  it('řazení podle pořadí segmentů a místa', () => {
    const list = [hl({ id: 'c', from: 3 }), hl({ id: 'b', from: 1, hint: 9 }), hl({ id: 'a', from: 1, hint: 2 })];
    expect(sortHighlights(list, [1, 2, 3]).map((h) => h.id)).toEqual(['a', 'b', 'c']);
  });

  it('úklid načtených dat: neplatné pryč, prázdná poznámka pryč', () => {
    const raw = [hl({ note: '  ' }), { id: 'x' }, hl({ id: 'h2', color: 'red' as Highlight['color'] }), null];
    const clean = cleanHighlights(raw);
    expect(clean).toHaveLength(1);
    expect(clean[0].note).toBeUndefined();
    expect(cleanHighlights({ not: 'array' })).toEqual([]);
  });
});

describe('zvýraznění ve Store', () => {
  let root: string;
  let store: Store;
  const job = (id: string) => ({ id, name: id, ext: '.pdf', mode: 'fast', sourceLang: 'en', targetLang: 'cs', status: 'done', createdAt: 1 }) as Job;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hl-'));
    store = new Store(root);
    await store.saveJob(job('a'));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('uloží a načte; bez souboru prázdný seznam; poškozený soubor nevadí', async () => {
    expect(await store.highlights('a')).toEqual([]);
    await store.saveHighlights('a', [hl({ note: 'pozor' })]);
    expect((await store.highlights('a'))[0].note).toBe('pozor');
    await writeFile(path.join(root, 'jobs', 'a', 'highlights.json'), '{rozbité');
    expect(await store.highlights('a')).toEqual([]);
  });

  it('v zamčeném dokumentu jen šifrovaně; bez klíče nejde číst ani zapsat', async () => {
    store.setKey(Buffer.alloc(32, 5));
    await store.encryptJob('a');
    await store.saveHighlights('a', [hl({ note: 'tajná poznámka' })]);
    const file = path.join(root, 'jobs', 'a', 'highlights.json');
    expect(existsSync(file)).toBe(false);
    expect((await readFile(file + ENC)).includes(Buffer.from('tajná'))).toBe(false);
    expect((await store.highlights('a'))[0].quote).toBe('tajná poznámka');
    store.setKey(undefined);
    await expect(store.highlights('a')).rejects.toThrow(LockedError);
    await expect(store.saveHighlights('a', [])).rejects.toThrow(LockedError);
  });
});
