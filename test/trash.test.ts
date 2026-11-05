import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../src/shared/types';

vi.mock('../src/main/pipeline', () => ({}));
vi.mock('../src/main/make-card', () => ({}));
vi.mock('../src/main/lmstudio', () => ({ unloadAll: async () => undefined }));

const { Store } = await import('../src/main/store');
const { Queue } = await import('../src/main/queue');

let root: string;
let store: InstanceType<typeof Store>;
let queue: InstanceType<typeof Queue>;
const job = (id: string, over: Partial<Job> = {}) => ({ id, name: id, ext: '.pdf', mode: 'fast', sourceLang: 'en', targetLang: 'cs', status: 'done', createdAt: 1, ...over }) as Job;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'trash-'));
  store = new Store(root);
  queue = new Queue(store, { update: () => undefined, finished: () => undefined, idle: () => undefined, library: () => undefined });
  await store.saveJob(job('a'));
  await store.saveJob(job('b'));
  await store.updateLibrary((l) => (l.assign.a = { folder: 'study' }));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('koš', () => {
  it('smazání přesune do koše; zařazení zůstane a po obnovení platí', async () => {
    await queue.trash('a');
    expect((await store.jobs()).map((j) => j.id)).toEqual(['b']);
    expect((await store.jobs(true)).map((j) => j.id)).toEqual(['a']);
    expect((await store.library()).assign.a).toEqual({ folder: 'study' });
    await queue.restore('a');
    expect((await store.jobs()).map((j) => j.id).sort()).toEqual(['a', 'b']);
    expect((await store.jobs(true))).toEqual([]);
  });

  it('smazání natrvalo odstraní data i zařazení', async () => {
    await queue.trash('a');
    await queue.remove('a');
    expect(await store.job('a')).toBeNull();
    expect((await store.library()).assign.a).toBeUndefined();
  });

  it('po 30 dnech se koš vysype sám, novější zůstanou', async () => {
    await store.saveJob(job('old', { trashedAt: Date.now() - 31 * 24 * 3600 * 1000 }));
    await queue.trash('a');
    await queue.purgeOld(30);
    expect(await store.job('old')).toBeNull();
    expect((await store.jobs(true)).map((j) => j.id)).toEqual(['a']);
  });
});
