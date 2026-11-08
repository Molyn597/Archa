import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markOpened, RECENT_MAX } from '../src/main/library';
import { BACKUP, createLibrary, libraryRoot, loadLibraries, setupLibraries } from '../src/main/libraries';
import { DEFAULT_SETTINGS, ENC, Store } from '../src/main/store';
import { createVault, openVault, type VaultMeta } from '../src/main/vault';
import type { Job, Library, Project } from '../src/shared/types';

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'tajné heslo 123';
const job = (id: string) => ({ id, name: `Smlouva ${id}`, ext: '.pdf', mode: 'fast', sourceLang: 'en', targetLang: 'cs', status: 'done', createdAt: 1 }) as Job;
const project = (id: string) => ({ id, name: `Projekt ${id}`, kind: 'seminar', sources: [], createdAt: 1, updatedAt: 1 }) as unknown as Project;
const json = async <T>(file: string) => JSON.parse(await readFile(file, 'utf8')) as T;

let app: string;
beforeEach(async () => {
  app = await mkdtemp(path.join(tmpdir(), 'libs-'));
});
afterEach(() => rm(app, { recursive: true, force: true }));

/** Data starší verze přímo v userData: zamčený dokument a, otevřený b, projekt, nastavení, API klíč, slovníky. */
async function oldLayout() {
  const old = new Store(app);
  const { meta, key } = await createVault(PASSWORD, FAST);
  await writeFile(path.join(app, 'vault.json'), JSON.stringify(meta));
  const library: Library = { folders: [{ id: 'safe', name: 'Trezor', createdAt: 1, locked: true }, { id: 'other', createdAt: 0 }], assign: { a: { folder: 'safe' }, b: { folder: 'other' } } };
  await old.saveLibrary(library);
  old.setKey(key);
  for (const id of ['a', 'b']) {
    await old.saveJob(job(id));
    await old.saveSegments(id, [{ id: 1, kind: 'paragraph', source: `Nájemné ${id}` }]);
    await old.writeJobFile(id, 'input.pdf', Buffer.from(`%PDF ${id}`));
  }
  await old.encryptJob('a');
  await old.saveProject(project('p'));
  await old.saveLibraryChat([{ role: 'user', text: 'kde je smlouva?', at: 1 }]);
  await old.saveSettings({ ...DEFAULT_SETTINGS, provider: 'openrouter', targetLang: 'de', citation: { enabled: true, style: 'apa7' }, onboarded: true });
  await writeFile(path.join(app, 'openrouter.key'), 'klíč');
  await mkdir(path.join(app, 'dictionaries'));
  await writeFile(path.join(app, 'dictionaries', 'cs.dic'), 'slovník');
}

describe('převzetí dat starší verze', () => {
  it('vše se přesune do první knihovny, zamčený dokument jde otevřít stejným heslem', async () => {
    await oldLayout();
    const vaultBefore = await readFile(path.join(app, 'vault.json'), 'utf8');
    const libs = await loadLibraries(app);

    expect(libs.list).toHaveLength(1);
    expect(libs.list[0]).toMatchObject({ id: libs.current, kind: 'general' });
    expect(libs.setupDone).toBeUndefined();
    for (const n of ['jobs', 'projects', 'library.json', 'library-chat.json', 'vault.json', 'migrating.json']) expect(existsSync(path.join(app, n))).toBe(false);
    // Společné věci aplikace zůstávají v userData.
    expect(await readFile(path.join(app, 'openrouter.key'), 'utf8')).toBe('klíč');
    expect(existsSync(path.join(app, 'dictionaries', 'cs.dic'))).toBe(true);
    // Záloha nenahraditelných souborů.
    expect(await readFile(path.join(app, BACKUP, 'vault.json'), 'utf8')).toBe(vaultBefore);
    expect(existsSync(path.join(app, BACKUP, 'library.json'))).toBe(true);
    expect(existsSync(path.join(app, BACKUP, 'settings.json'))).toBe(true);

    const root = libraryRoot(app, libs.current);
    const store = new Store(root, app);
    expect(existsSync(path.join(root, 'jobs', 'a', 'segments.json' + ENC))).toBe(true);
    // Bez hesla zamčený dokument není vidět, s heslem ano.
    expect((await store.jobs()).map((j) => j.id)).toEqual(['b']);
    store.setKey(await openVault(await json<VaultMeta>(path.join(root, 'vault.json')), PASSWORD));
    expect((await store.jobs()).map((j) => j.id).sort()).toEqual(['a', 'b']);
    expect((await store.segments('a'))[0].source).toBe('Nájemné a');
    expect((await store.readJobFile('a', 'input.pdf')).toString()).toBe('%PDF a');
    expect((await store.library()).folders.find((f) => f.id === 'safe')?.locked).toBe(true);
    expect((await store.projects()).map((p) => p.id)).toEqual(['p']);
    expect((await store.libraryChat())[0].text).toBe('kde je smlouva?');

    const settings = await store.settings();
    expect(settings).toMatchObject({ provider: 'openrouter', targetLang: 'de', onboarded: true });
    expect(settings.citation.style).toBe('apa7');
    expect(await json(path.join(root, 'settings.json'))).toEqual({ targetLang: 'de', citation: { enabled: true, style: 'apa7' }, autoCard: true });
  });

  it('druhé spuštění už nic nemění', async () => {
    await oldLayout();
    const first = await loadLibraries(app);
    const before = await readdir(libraryRoot(app, first.current));
    expect(await loadLibraries(app)).toEqual(first);
    expect(await readdir(libraryRoot(app, first.current))).toEqual(before);
  });

  it('přerušené převzetí se při dalším startu dokončí', async () => {
    await oldLayout();
    // Stav po pádu: deník zapsaný, přesunuté jen jobs.
    await writeFile(path.join(app, 'migrating.json'), JSON.stringify({ id: 'L1' }));
    await mkdir(libraryRoot(app, 'L1'), { recursive: true });
    await rename(path.join(app, 'jobs'), path.join(libraryRoot(app, 'L1'), 'jobs'));

    const libs = await loadLibraries(app);
    expect(libs.current).toBe('L1');
    for (const n of ['jobs', 'projects', 'library.json', 'library-chat.json', 'vault.json']) {
      expect(existsSync(path.join(app, n))).toBe(false);
      expect(existsSync(path.join(libraryRoot(app, 'L1'), n))).toBe(true);
    }
    expect(existsSync(path.join(app, 'migrating.json'))).toBe(false);
  });

  it('nic se nepřepíše: existující cíl zůstane a původní soubor také', async () => {
    await oldLayout();
    await writeFile(path.join(app, 'migrating.json'), JSON.stringify({ id: 'L1' }));
    await mkdir(libraryRoot(app, 'L1'), { recursive: true });
    await writeFile(path.join(libraryRoot(app, 'L1'), 'library.json'), '{"folders":[],"assign":{}}');

    await loadLibraries(app);
    expect(await readFile(path.join(libraryRoot(app, 'L1'), 'library.json'), 'utf8')).toBe('{"folders":[],"assign":{}}');
    expect(existsSync(path.join(app, 'library.json'))).toBe(true);
  });

  it('nová instalace: jedna prázdná knihovna, nic se nezálohuje', async () => {
    const libs = await loadLibraries(app);
    expect(libs.list).toHaveLength(1);
    expect(existsSync(path.join(app, BACKUP))).toBe(false);
    expect(await readdir(libraryRoot(app, libs.current))).toEqual([]);
  });

  it('poškozený seznam knihoven se obnoví podle jejich složek', async () => {
    await mkdir(libraryRoot(app, 'X'), { recursive: true });
    await mkdir(libraryRoot(app, 'Y'), { recursive: true });
    await writeFile(path.join(app, 'libraries.json'), '{nesmysl');
    const libs = await loadLibraries(app);
    expect(libs.list.map((l) => l.id).sort()).toEqual(['X', 'Y']);
    expect(['X', 'Y']).toContain(libs.current);
  });
});

describe('oddělené knihovny', () => {
  it('dokumenty, projekty, chat, trezor a nastavení knihovny se nemíchají; AI nastavení je společné', async () => {
    await oldLayout();
    const libs = await loadLibraries(app);
    const second = await createLibrary(app, libs, 'study', ['Matematika']);
    expect(libs.list.map((l) => l.id)).toEqual([libs.current, second.id]);
    expect((await json<{ list: unknown[] }>(path.join(app, 'libraries.json'))).list).toHaveLength(2);

    const one = new Store(libraryRoot(app, libs.current), app);
    const two = new Store(libraryRoot(app, second.id), app);
    await two.saveJob(job('c'));
    expect((await one.jobs()).map((j) => j.id)).toEqual(['b']);
    expect((await two.jobs()).map((j) => j.id)).toEqual(['c']);
    expect(await two.projects()).toEqual([]);
    expect(await two.libraryChat()).toEqual([]);
    expect(existsSync(path.join(libraryRoot(app, second.id), 'vault.json'))).toBe(false);

    // Nastavení: knihovna má vlastní cílový jazyk, AI a vzhled sdílí.
    await two.saveSettings({ ...(await two.settings()), targetLang: 'en', provider: 'local', theme: 'dark' });
    expect(await one.settings()).toMatchObject({ targetLang: 'de', provider: 'local', theme: 'dark' });
    expect(await two.settings()).toMatchObject({ targetLang: 'en', provider: 'local', theme: 'dark' });
  });
});

describe('výběr knihoven při prvním spuštění', () => {
  it('nová instalace: první knihovna dostane šablonu prvního typu, ostatní typy jsou nové knihovny', async () => {
    const libs = await loadLibraries(app);
    await setupLibraries(app, libs, ['work', 'personal']);
    expect(libs.setupDone).toBe(true);
    expect(libs.list.map((l) => l.kind)).toEqual(['work', 'personal']);
    for (const l of libs.list) expect(existsSync(path.join(libraryRoot(app, l.id), 'library.json'))).toBe(true);
  });

  it('převzatá data: knihovna si nechá složky a jen dostane typ', async () => {
    await oldLayout();
    const libs = await loadLibraries(app);
    const file = path.join(libraryRoot(app, libs.current), 'library.json');
    const before = await readFile(file, 'utf8');
    await setupLibraries(app, libs, ['work', 'study'], { keep: 'study', subjects: ['Fyzika'] });
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(libs.list.map((l) => l.kind)).toEqual(['study', 'work']);
    expect(libs.current).toBe(libs.list[0].id);
  });
});

describe('naposledy otevřené', () => {
  it('nejnovější první, bez duplicit, nejvýš RECENT_MAX; Store si seznam pamatuje', async () => {
    const store = new Store(app);
    for (const id of ['a', 'b', 'a', ...Array.from({ length: RECENT_MAX }, (_, i) => `x${i}`), 'b']) await store.updateLibrary((l) => markOpened(l, id));
    const recent = (await store.library()).recent!;
    expect(recent).toHaveLength(RECENT_MAX);
    expect(recent[0]).toBe('b');
    expect(new Set(recent).size).toBe(RECENT_MAX);
    expect(recent).not.toContain('a');
  });
});
