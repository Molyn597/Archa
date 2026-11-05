import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fillHashes, hashBytes, hashFile } from '../src/main/hash';
import { Store } from '../src/main/store';
import { adoptFolder, duplicateGroups, keepOrder, similar } from '../src/shared/duplicates';
import type { DocumentCard, Job, Library } from '../src/shared/types';

const job = (id: string, extra: Partial<Job> = {}) =>
  ({ id, name: id, ext: '.pdf', mode: 'fast', sourceLang: 'en', targetLang: 'cs', status: 'done', createdAt: 1, warnings: 0, ...extra }) as Job;
const card = (title: string, family = '', year?: string) =>
  ({ summary: '', type: 'article', keywords: [], lang: 'cs', createdAt: 1, biblio: { title, year, authors: family ? [{ family, given: '' }] : [] } }) as DocumentCard;
const lib = (assign: Library['assign'] = {}): Library => ({ folders: [], assign });

describe('duplicity', () => {
  it('shodné podle otisku, koš se nepočítá, ponechat hotový s kartou', () => {
    const jobs = [
      job('a', { inputHash: 'h1', createdAt: 1, status: 'error' }),
      job('b', { inputHash: 'h1', createdAt: 2 }),
      job('c', { inputHash: 'h1', createdAt: 3 }),
      job('d', { inputHash: 'h1', trashedAt: 5 }),
      job('e', { inputHash: 'h2' }),
    ];
    expect(duplicateGroups(jobs, { c: card('x') }, lib())).toEqual([{ kind: 'same', ids: ['c', 'b', 'a'] }]);
  });

  it('pořadí: hotový > karta > složka > nejstarší', () => {
    const jobs = [job('a', { createdAt: 3 }), job('b', { createdAt: 2 }), job('c', { createdAt: 1 })];
    expect(keepOrder(jobs, {}, lib({ a: { folder: 'f' } })).map((j) => j.id)).toEqual(['a', 'c', 'b']);
  });

  it('podobné: stejný název karty bez ohledu na diakritiku a velikost', () => {
    const cards = { a: card('Více škody než užitku: Gallup'), b: card('vice skody nez uzitku - GALLUP') };
    expect(duplicateGroups([job('a', { inputHash: '1' }), job('b', { inputHash: '2' })], cards, lib())).toEqual([{ kind: 'similar', ids: ['a', 'b'] }]);
  });

  it('podobné: název souboru s jazykovou příponou', () => {
    expect(similar(job('MamagingambidextrousRnDmanagement'), job('MamagingambidextrousRnDmanagement cs'), {})).toBe(true);
  });

  it('podobné: autor + rok + překrývající se název; jiný rok ne', () => {
    const a = card('What is your management model', 'Birkinshaw', '2009');
    expect(similar(job('a'), job('b'), { a, b: card('What is your management model?', 'Birkinshaw', '2009') })).toBe(true);
    expect(similar(job('a'), job('b'), { a, b: card('Your management model explained', 'Birkinshaw', '2009') })).toBe(true);
    expect(similar(job('a'), job('b'), { a, b: card('Your management model explained', 'Birkinshaw', '2012') })).toBe(false);
  });

  it('krátké názvy a různé dokumenty se nespojují', () => {
    expect(similar(job('a'), job('b'), { a: card('Faktura'), b: card('Faktura') })).toBe(false);
    expect(similar(job('Faktura 1'), job('Faktura 1'), {})).toBe(false);
    expect(similar(job('a'), job('b'), { a: card('Trust and growth in Sweden', 'Berggren'), b: card('Institutions and growth', 'Glaeser') })).toBe(false);
  });

  it('shodná skupina se v podobných neopakuje, podobný dokument se k ní připojí přes zástupce', () => {
    const jobs = [job('a', { inputHash: 'h' }), job('b', { inputHash: 'h' }), job('c', { inputHash: 'x' })];
    const t = card('Lessons learned with Check-in at Adobe');
    const groups = duplicateGroups(jobs, { a: t, b: t, c: t }, lib());
    expect(groups).toEqual([
      { kind: 'same', ids: ['a', 'b'] },
      { kind: 'similar', ids: ['a', 'c'] },
    ]);
  });

  it('ponechaný bez složky převezme složku odstraněného; se složkou si ji nechá', () => {
    const l = lib({ b: { folder: 'f', manual: true } });
    adoptFolder(l, 'a', ['b']);
    expect(l.assign.a).toEqual({ folder: 'f', manual: true });
    const k = lib({ a: { folder: 'g' }, b: { folder: 'f' } });
    adoptFolder(k, 'a', ['b']);
    expect(k.assign.a).toEqual({ folder: 'g' });
  });
});

describe('otisk souboru', () => {
  let root: string;
  let store: Store;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'tl-hash-'));
    store = new Store(root);
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('hashFile = hashBytes', async () => {
    const file = path.join(root, 'x.pdf');
    await writeFile(file, 'obsah');
    expect(await hashFile(file)).toBe(hashBytes(Buffer.from('obsah')));
  });

  it('doplní chybějící otisky (i v koši), běžící a bez originálu přeskočí, zamčený bez trezoru nečte', async () => {
    for (const j of [job('a'), job('b', { trashedAt: 1 }), job('c', { status: 'running' }), job('d'), job('e', { inputHash: 'hotovo' })]) await store.saveJob(j);
    for (const id of ['a', 'b', 'c']) await store.writeJobFile(id, 'input.pdf', `pdf ${id}`);
    store.setKey(Buffer.alloc(32, 1));
    await store.saveJob(job('z'));
    await store.writeJobFile('z', 'input.pdf', 'tajné');
    await store.encryptJob('z');
    store.setKey(undefined);

    expect((await fillHashes(store)).map((j) => j.id).sort()).toEqual(['a', 'b']);
    expect((await store.job('a'))?.inputHash).toBe(hashBytes(Buffer.from('pdf a')));
    expect((await store.job('c'))?.inputHash).toBeUndefined();

    store.setKey(Buffer.alloc(32, 1));
    expect((await fillHashes(store)).map((j) => j.id)).toEqual(['z']);
    expect((await store.job('z'))?.inputHash).toBe(hashBytes(Buffer.from('tajné')));
  });
});
