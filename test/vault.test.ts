import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensurePath, matchFolder, placeDoc } from '../src/main/library';
import { lockTransitions, syncLocks } from '../src/main/locks';
import { ENC, LOCK_MARK, LockedError, Store } from '../src/main/store';
import { tempCopy, wipeTempCopies } from '../src/main/temp-open';
import { createVault, decrypt, encrypt, openVault, rewrapVault, TamperedError, WrongPasswordError } from '../src/main/vault';
import type { Job, Library } from '../src/shared/types';

// Rychlé parametry jen pro testy; aplikace používá DEFAULT_KDF (N = 2^17).
const FAST = { N: 2 ** 10, r: 8, p: 1 };

describe('šifrování souboru', () => {
  const key = Buffer.alloc(32, 7);

  it('tam a zpět', () => {
    const blob = encrypt(key, Buffer.from('tajné'), 'jobs/a/card.json');
    expect(blob.includes(Buffer.from('tajné'))).toBe(false);
    expect(decrypt(key, blob, 'jobs/a/card.json').toString()).toBe('tajné');
  });

  it('jiné místo (podstrčený soubor), změněný bajt, cizí soubor i jiný klíč = chyba', () => {
    const blob = encrypt(key, Buffer.from('tajné'), 'jobs/a/card.json');
    expect(() => decrypt(key, blob, 'jobs/b/card.json')).toThrow(TamperedError);
    const bad = Buffer.from(blob);
    bad[bad.length - 1] ^= 1;
    expect(() => decrypt(key, bad, 'jobs/a/card.json')).toThrow(TamperedError);
    expect(() => decrypt(key, Buffer.from('{"plain": true}'), 'jobs/a/card.json')).toThrow(TamperedError);
    expect(() => decrypt(Buffer.alloc(32, 8), blob, 'jobs/a/card.json')).toThrow(TamperedError);
  });

  it('stejný obsah dává pokaždé jinou šifru (náhodné IV)', () => {
    expect(encrypt(key, Buffer.from('x'), 'a').equals(encrypt(key, Buffer.from('x'), 'a'))).toBe(false);
  });
});

describe('trezor', () => {
  it('heslo otevře hlavní klíč, špatné heslo ne', async () => {
    const { meta, key } = await createVault('správné heslo', FAST);
    expect(JSON.stringify(meta)).not.toContain('správné');
    expect((await openVault(meta, 'správné heslo')).equals(key)).toBe(true);
    await expect(openVault(meta, 'špatné heslo')).rejects.toThrow(WrongPasswordError);
  });

  it('změna hesla zachová hlavní klíč, staré heslo přestane platit', async () => {
    const { meta, key } = await createVault('staré heslo', FAST);
    const next = await rewrapVault(meta, 'staré heslo', 'nové heslo');
    expect((await openVault(next, 'nové heslo')).equals(key)).toBe(true);
    await expect(openVault(next, 'staré heslo')).rejects.toThrow(WrongPasswordError);
    await expect(rewrapVault(meta, 'špatné', 'x')).rejects.toThrow(WrongPasswordError);
  });

  it('heslo se porovnává po Unicode normalizaci (á složené i rozložené)', async () => {
    const { meta, key } = await createVault('heslo á', FAST);
    expect((await openVault(meta, 'heslo á')).equals(key)).toBe(true);
  });
});

describe('zamčený dokument ve Store', () => {
  let root: string;
  let store: Store;
  const key = Buffer.alloc(32, 3);
  const job = (id: string) => ({ id, name: `Tajná smlouva ${id}`, ext: '.pdf', mode: 'fast', sourceLang: 'en', targetLang: 'cs', status: 'done', createdAt: 1 }) as Job;
  const dir = (id: string) => path.join(root, 'jobs', id);

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vault-'));
    store = new Store(root);
    await store.saveJob(job('a'));
    await store.saveJob(job('b'));
    await store.saveSegments('a', [{ id: 1, kind: 'paragraph', source: 'Nájemné 12 500 Kč' }]);
    await store.writeJobFile('a', 'input.pdf', Buffer.from('%PDF tajný originál'));
    await store.writeJobFile('a', 'figures/1.png', Buffer.from('obrázek'));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('zašifrování: na disku nezůstane čitelný text ani název, s klíčem jde vše číst', async () => {
    store.setKey(key);
    await store.encryptJob('a');
    expect(existsSync(path.join(dir('a'), LOCK_MARK))).toBe(true);
    for (const f of ['job.json', 'segments.json', 'input.pdf', 'figures/1.png']) {
      expect(existsSync(path.join(dir('a'), f))).toBe(false);
      const raw = await readFile(path.join(dir('a'), f + ENC));
      expect(raw.includes(Buffer.from('Tajná'))).toBe(false);
      expect(raw.includes(Buffer.from('Nájemné'))).toBe(false);
    }
    expect((await store.job('a'))?.name).toBe('Tajná smlouva a');
    expect((await store.segments('a'))[0].source).toBe('Nájemné 12 500 Kč');
    expect((await store.readInput(job('a'))).toString()).toBe('%PDF tajný originál');
  });

  it('zamčený trezor: dokument v seznamu chybí, čtení i zápis selžou (žádná tichá prázdná data)', async () => {
    store.setKey(key);
    await store.encryptJob('a');
    store.setKey(undefined);
    expect((await store.jobs()).map((j) => j.id)).toEqual(['b']);
    await expect(store.segments('a')).rejects.toThrow(LockedError);
    await expect(store.saveChat('a', [])).rejects.toThrow(LockedError);
    expect(existsSync(path.join(dir('a'), 'chat.json'))).toBe(false);
  });

  it('nový zápis do zamčeného dokumentu jde rovnou zašifrovaný', async () => {
    store.setKey(key);
    await store.encryptJob('a');
    await store.saveChat('a', [{ role: 'user', text: 'tajná otázka', at: 1 }]);
    expect(existsSync(path.join(dir('a'), 'chat.json'))).toBe(false);
    expect((await readFile(path.join(dir('a'), 'chat.json' + ENC))).includes(Buffer.from('tajná'))).toBe(false);
    expect((await store.chat('a'))[0].text).toBe('tajná otázka');
  });

  it('soubor přenesený z jiného dokumentu nejde přečíst', async () => {
    store.setKey(key);
    await store.encryptJob('a');
    await store.encryptJob('b');
    await copyFile(path.join(dir('a'), 'job.json' + ENC), path.join(dir('b'), 'job.json' + ENC));
    await expect(store.readJobFile('b', 'job.json')).rejects.toThrow(TamperedError);
  });

  it('dešifrování vrátí původní soubory a zruší značku', async () => {
    store.setKey(key);
    await store.encryptJob('a');
    await store.decryptJob('a');
    expect(existsSync(path.join(dir('a'), LOCK_MARK))).toBe(false);
    expect(existsSync(path.join(dir('a'), 'segments.json' + ENC))).toBe(false);
    expect((await readFile(path.join(dir('a'), 'figures/1.png'))).toString()).toBe('obrázek');
  });

  it('bez klíče nejde zašifrovat ani dešifrovat', async () => {
    await expect(store.encryptJob('a')).rejects.toThrow(LockedError);
  });

  it('pád uprostřed: šifra vyhraje nad nešifrovaným souborem, zbylé nešifrované soubory se dořeší po odemčení', async () => {
    store.setKey(key);
    await store.encryptJob('a');
    // Simulace: nešifrovaná kopie vedle šifry (pád před smazáním) a soubor, který se zašifrovat nestihl.
    await writeFile(path.join(dir('a'), 'segments.json'), 'stará nešifrovaná kopie');
    await writeFile(path.join(dir('a'), 'chat.json'), '[]');
    await writeFile(path.join(dir('a'), 'card.json.tlk.tmp'), 'rozepsané');
    store.setKey(undefined);
    await store.cleanupLocked();
    expect(existsSync(path.join(dir('a'), 'segments.json'))).toBe(false);
    expect(existsSync(path.join(dir('a'), 'card.json.tlk.tmp'))).toBe(false);
    expect(await store.lockedWithPlaintext()).toEqual(['a']);
    store.setKey(key);
    const library: Library = { folders: [{ id: 'safe', createdAt: 0, locked: true }], assign: { a: { folder: 'safe' } } };
    await syncLocks(store, library);
    expect(await store.lockedWithPlaintext()).toEqual([]);
    expect(existsSync(path.join(dir('a'), 'chat.json' + ENC))).toBe(true);
  });

  it('synchronizace se složkami: přesun do zamčené složky šifruje, ven dešifruje, zámek se dědí', async () => {
    store.setKey(key);
    const library: Library = {
      folders: [
        { id: 'safe', createdAt: 0, locked: true },
        { id: 'sub', parent: 'safe', createdAt: 0 },
        { id: 'open', createdAt: 0 },
      ],
      assign: { a: { folder: 'sub' }, b: { folder: 'open' } },
    };
    expect(await lockTransitions(store, library)).toEqual([{ id: 'a', lock: true }]);
    await syncLocks(store, library);
    expect(await store.isLockedJob('a')).toBe(true);
    library.assign.a = { folder: 'open' };
    await syncLocks(store, library);
    expect(await store.isLockedJob('a')).toBe(false);
    expect(await lockTransitions(store, library)).toEqual([]);
  });
});

describe('AI a zamčené složky', () => {
  const library = (): Library => ({
    folders: [
      { id: 'safe', name: 'Smlouvy', createdAt: 0, locked: true },
      { id: 'inner', name: 'Nájem', parent: 'safe', createdAt: 0 },
    ],
    assign: {},
  });

  it('AI zamčenou složku nenajde podle názvu ani cesty a dokument do ní nezařadí', () => {
    const l = library();
    expect(matchFolder(l, 'Smlouvy')).toBeUndefined();
    expect(matchFolder(l, 'Nájem')).toBeUndefined();
    expect(ensurePath(l, 'Smlouvy / Nájem', false).id).toBeUndefined();
    let n = 0;
    const placed = placeDoc(l, 'x', { folder: 'Smlouvy / Nájem' }, () => `new${++n}`);
    expect(placed?.folder).not.toBe('inner');
    expect(['safe', 'inner']).not.toContain(l.assign.x?.folder);
  });
});

describe('dočasné kopie pro jiné aplikace', () => {
  it('se při zamčení smažou', async () => {
    const file = await tempCopy('smlouva.docx', Buffer.from('obsah'));
    expect(existsSync(file)).toBe(true);
    await wipeTempCopies();
    expect(existsSync(file)).toBe(false);
  });
});

void mkdir;
