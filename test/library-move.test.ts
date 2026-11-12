import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyDirVerified, moveToLibrary } from '../src/main/library-move';
import { alignLibraryFile, alignOpenLibrary, libraryRoot, setLibraryKind } from '../src/main/libraries';
import { LOCK_MARK, Store } from '../src/main/store';
import { templateLibrary } from '../src/shared/library-templates';
import type { Job, Libraries, Library, Project } from '../src/shared/types';

let app: string;
let src: Store;
let libs: Libraries;
const SRC = 'src-lib';
const DST = 'dst-lib';

const job = (id: string, status: Job['status'] = 'done') => ({ id, name: `Dok ${id}`, ext: '.pdf', mode: 'fast', sourceLang: 'en', targetLang: 'cs', status, createdAt: 1 }) as Job;

beforeEach(async () => {
  app = await mkdtemp(path.join(tmpdir(), 'move-'));
  libs = { current: SRC, list: [{ id: SRC, kind: 'work', createdAt: 1 }, { id: DST, kind: 'study', createdAt: 2 }] };
  src = new Store(libraryRoot(app, SRC), app);
  await mkdir(libraryRoot(app, DST), { recursive: true });
  await writeFile(path.join(libraryRoot(app, DST), 'library.json'), JSON.stringify(templateLibrary('study', ['Právo'])));
  const library = templateLibrary('work');
  library.assign = { a: { folder: 'invoices' }, b: { folder: 'contracts' } };
  library.paid = { a: 9 };
  library.recent = ['a'];
  await src.saveLibrary(library);
  for (const id of ['a', 'b']) {
    await src.saveJob(job(id));
    await src.writeJobFile(id, 'input.pdf', Buffer.from(`pdf-${id}`));
    await src.writeJobFile(id, 'figures/f1.png', Buffer.from('img'));
  }
  await src.saveCard('a', { type: 'invoice', folder: 'Články' } as never);
  await src.saveProject({ id: 'p', name: 'P', kind: 'work', sources: ['a', 'b'] } as Project);
});
afterEach(() => rm(app, { recursive: true, force: true }));

const dstLibrary = async () => JSON.parse(await readFile(path.join(libraryRoot(app, DST), 'library.json'), 'utf8')) as Library;

describe('moveToLibrary', () => {
  it('přesune složku, upraví obě knihovny i projekt a zdroj smaže', async () => {
    expect(await moveToLibrary(src, app, libs, ['a'], DST)).toBe(1);
    const moved = path.join(libraryRoot(app, DST), 'jobs', 'a');
    expect((await readFile(path.join(moved, 'input.pdf'))).toString()).toBe('pdf-a');
    expect(existsSync(path.join(moved, 'figures', 'f1.png'))).toBe(true);
    expect(existsSync(src.jobDir('a'))).toBe(false);
    expect(existsSync(src.jobDir('b'))).toBe(true);

    const to = await dstLibrary();
    expect(to.assign.a.folder).toBe('articles');
    expect(to.paid).toEqual({ a: 9 });
    const from = await src.library();
    expect(from.assign).toEqual({ b: { folder: 'contracts' } });
    expect(from.paid).toBeUndefined();
    expect(from.recent).toBeUndefined();
    expect((await src.project('p'))!.sources).toEqual(['b']);
    expect(await readdir(path.join(libraryRoot(app, DST), '.moving')).catch(() => [])).toEqual([]);
  });

  it('přesune projekt i se zdroji, ve zdroji ho smaže', async () => {
    await src.saveProject({ id: 'bp', name: 'Japonsko', kind: 'bachelor', sources: ['b'] } as Project);
    await src.saveProjectChat('bp', [{ role: 'user', text: 'hi', at: 1 }]);
    expect(await moveToLibrary(src, app, libs, ['b'], DST, { keepFolders: true, projectIds: ['bp'] })).toBe(1);
    const copy = JSON.parse(await readFile(path.join(libraryRoot(app, DST), 'projects', 'bp', 'project.json'), 'utf8')) as Project;
    expect(copy.sources).toEqual(['b']);
    expect(existsSync(path.join(libraryRoot(app, DST), 'projects', 'bp', 'chat.json'))).toBe(true);
    expect(existsSync(src.projectDir('bp'))).toBe(false);
    expect(existsSync(path.join(libraryRoot(app, DST), 'jobs', 'b'))).toBe(true);
    expect((await src.project('p'))!.sources).toEqual(['a']);
  });

  it('bez návrhu složky dokument skončí v Ostatní', async () => {
    await moveToLibrary(src, app, libs, ['b'], DST);
    expect((await dstLibrary()).assign.b.folder).toBe('other');
  });

  it('zamčený dokument odmítne a nic nezmění', async () => {
    await writeFile(path.join(src.jobDir('b'), LOCK_MARK), '');
    await expect(moveToLibrary(src, app, libs, ['a', 'b'], DST)).rejects.toThrow(/Zamčený/);
    expect(existsSync(src.jobDir('a'))).toBe(true);
    expect(existsSync(path.join(libraryRoot(app, DST), 'jobs', 'a'))).toBe(false);
    expect((await dstLibrary()).assign).toEqual({});
  });

  it('dokument ve zpracování odmítne', async () => {
    await src.saveJob(job('a', 'running'));
    await expect(moveToLibrary(src, app, libs, ['a'], DST)).rejects.toThrow(/zpracovává/);
    expect(existsSync(src.jobDir('a'))).toBe(true);
  });

  it('existující cíl nepřepíše', async () => {
    const dir = path.join(libraryRoot(app, DST), 'jobs', 'a');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'job.json'), 'cizí');
    await expect(moveToLibrary(src, app, libs, ['b', 'a'], DST)).rejects.toThrow(/už v cílové/);
    expect((await readFile(path.join(dir, 'job.json'), 'utf8'))).toBe('cizí');
    expect(existsSync(path.join(libraryRoot(app, DST), 'jobs', 'b'))).toBe(false);
    expect(existsSync(src.jobDir('a'))).toBe(true);
  });

  it('neznámá nebo otevřená cílová knihovna je chyba', async () => {
    await expect(moveToLibrary(src, app, libs, ['a'], SRC)).rejects.toThrow();
    await expect(moveToLibrary(src, app, libs, ['a'], 'nic')).rejects.toThrow();
  });
});

describe('moveToLibrary se strukturou složek', () => {
  it('vytvoří cestu v cíli a ve zdroji uklidí jen dotčené prázdné složky', async () => {
    const library = templateLibrary('work');
    library.folders.push({ id: 'study', createdAt: 0 }, { id: 'f1', name: 'Články', createdAt: 0, parent: 'study' }, { id: 'f2', name: 'Management', createdAt: 0, parent: 'f1' }, { id: 'keep', name: 'Jiná prázdná', createdAt: 0 });
    library.assign = { a: { folder: 'f2' }, b: { folder: 'contracts' } };
    await src.saveLibrary(library);
    await moveToLibrary(src, app, libs, ['a'], DST, { keepFolders: true });
    const to = await dstLibrary();
    const f = to.folders.find((x) => x.id === to.assign.a.folder)!;
    expect(f.name).toBe('Management');
    // Do studijní knihovny bez úvodní složky „Studium“: Management padne pod výchozí Články.
    const parent = to.folders.find((x) => x.id === f.parent)!;
    expect([parent.id, parent.parent]).toEqual(['articles', undefined]);
    const from = await src.library();
    expect(from.folders.map((x) => x.id)).not.toContain('f2');
    expect(from.folders.map((x) => x.id)).not.toContain('f1');
    expect(from.folders.map((x) => x.id)).not.toContain('study');
    expect(from.folders.map((x) => x.id)).toContain('keep');
    expect(from.assign).toEqual({ b: { folder: 'contracts' } });
  });

  it('fromFolder: cesta začíná přesouvanou složkou', async () => {
    const library = templateLibrary('work');
    library.folders.push({ id: 'study', createdAt: 0 }, { id: 'f1', name: 'Články', createdAt: 0, parent: 'study' }, { id: 'f2', name: 'Management', createdAt: 0, parent: 'f1' });
    library.assign = { a: { folder: 'f2' } };
    await src.saveLibrary(library);
    await moveToLibrary(src, app, libs, ['a'], DST, { keepFolders: true, fromFolder: 'f1' });
    const to = await dstLibrary();
    const f = to.folders.find((x) => x.id === to.assign.a.folder)!;
    const parent = to.folders.find((x) => x.id === f.parent)!;
    // „Články“ ve studijní šabloně už je (výchozí složka), použije se znovu.
    expect([f.name, parent.id, parent.parent]).toEqual(['Management', 'articles', undefined]);
    // Osiřelé nadřazené složky bez dokumentů zmizí také.
    expect((await src.library()).folders.map((x) => x.id)).not.toContain('study');
    expect((await src.library()).folders.map((x) => x.id)).not.toContain('f1');
  });
});

describe('copyDirVerified', () => {
  it('zkopíruje a existující cíl nikdy nepřepíše', async () => {
    const from = path.join(app, 'x');
    await mkdir(from);
    await writeFile(path.join(from, 'f'), 'data');
    const dst = path.join(app, 'dst');
    await copyDirVerified(from, dst, path.join(app, 'tmp'), () => new Error('neúplné'));
    expect((await readFile(path.join(dst, 'f'), 'utf8'))).toBe('data');
    await expect(copyDirVerified(from, dst, path.join(app, 'tmp'), () => new Error('neúplné'))).rejects.toThrow();
    expect(existsSync(from)).toBe(true);
  });
});

describe('úprava podle šablony', () => {
  it('alignOpenLibrary s onlyOutdated proběhne jen jednou', async () => {
    const old: Library = { folders: [{ id: 'declarations', createdAt: 0 }, { id: 'other', createdAt: 0 }], assign: {} };
    await src.saveLibrary(old);
    await alignOpenLibrary(src, 'work', true);
    const once = await src.library();
    expect(once.folders.map((f) => f.id)).toEqual(['contracts', 'invoices', 'hr', 'manuals', 'official', 'internal-docs', 'other']);
    expect(once.templateVersion).toBe(1);
    await src.saveLibrary({ ...once, folders: [...once.folders, { id: 'declarations', createdAt: 0 }] });
    await alignOpenLibrary(src, 'work', true);
    expect((await src.library()).folders.some((f) => f.id === 'declarations')).toBe(true);
  });

  it('změna typu jiné knihovny upraví její library.json a libraries.json', async () => {
    await writeFile(path.join(libraryRoot(app, DST), 'library.json'), JSON.stringify({ folders: [{ id: 'study', createdAt: 0 }, { id: 'other', createdAt: 0 }], assign: {} }));
    await alignLibraryFile(app, DST, 'work');
    expect((await dstLibrary()).folders.map((f) => f.id)).toContain('hr');
    await setLibraryKind(app, libs, DST, 'work');
    expect(libs.list.find((l) => l.id === DST)!.kind).toBe('work');
    expect(JSON.parse(await readFile(path.join(app, 'libraries.json'), 'utf8')).list[1].kind).toBe('work');
  });
});
