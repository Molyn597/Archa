import * as fs from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
import { migrateUserData } from '../src/main/user-data-migration';
import { MIGRATED_MARK, userDataStep, type UserDataState } from '../src/shared/user-data-migration';

const state = (s: Partial<UserDataState> = {}): UserDataState => ({ oldExists: true, oldRunning: false, newExists: false, newHasDocs: false, migrated: false, ...s });

describe('userDataStep', () => {
  it('přesune starou složku, když nová neexistuje', () => {
    expect(userDataStep(state())).toEqual({ step: 'move' });
  });
  it('neprázdnou novou složku bez dokumentů odsune stranou', () => {
    expect(userDataStep(state({ newExists: true }))).toEqual({ step: 'move-aside' });
  });
  it('nic nedělá bez staré složky, po převzetí, s dokumenty v nové nebo když stará aplikace běží', () => {
    expect(userDataStep(state({ oldExists: false }))).toEqual({ step: 'skip', reason: 'no-old' });
    expect(userDataStep(state({ migrated: true, newExists: true }))).toEqual({ step: 'skip', reason: 'migrated' });
    expect(userDataStep(state({ newExists: true, newHasDocs: true }))).toEqual({ step: 'skip', reason: 'new-has-docs' });
    expect(userDataStep(state({ oldRunning: true }))).toEqual({ step: 'skip', reason: 'old-running' });
  });
});

describe('migrateUserData', () => {
  let base: string;
  let oldDir: string;
  let newDir: string;
  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'archa-migrate-'));
    oldDir = path.join(base, 'TransLatte');
    newDir = path.join(base, 'Archa');
    await mkdir(path.join(oldDir, 'libraries', 'a', 'jobs', 'j1'), { recursive: true });
    await writeFile(path.join(oldDir, 'libraries.json'), '{"current":"a"}');
    await writeFile(path.join(oldDir, 'libraries', 'a', 'jobs', 'j1', 'job.json'), '{}');
  });
  afterEach(() => rm(base, { recursive: true, force: true }));

  it('přejmenuje celou složku i do prázdné nové (tu zakládá Electron) a zapíše značku', async () => {
    await mkdir(newDir);
    expect(migrateUserData(oldDir, newDir, false)).toEqual({ step: 'done', method: 'rename' });
    expect(existsSync(oldDir)).toBe(false);
    expect(await readFile(path.join(newDir, 'libraries', 'a', 'jobs', 'j1', 'job.json'), 'utf8')).toBe('{}');
    expect(JSON.parse(await readFile(path.join(newDir, MIGRATED_MARK), 'utf8'))).toMatchObject({ from: oldDir, method: 'rename' });
    expect(migrateUserData(oldDir, newDir, false)).toEqual({ step: 'skip', reason: 'no-old' });
  });

  it('novou složku s dokumenty nikdy nepřepíše', async () => {
    await mkdir(path.join(newDir, 'libraries', 'b', 'jobs', 'x'), { recursive: true });
    expect(migrateUserData(oldDir, newDir, false)).toEqual({ step: 'skip', reason: 'new-has-docs' });
    expect(existsSync(path.join(oldDir, 'libraries.json'))).toBe(true);
    expect(await readdir(path.join(newDir, 'libraries'))).toEqual(['b']);
  });

  it('neprázdnou novou složku bez dokumentů odsune stranou a nic nesmaže', async () => {
    await mkdir(path.join(newDir, 'libraries', 'b'), { recursive: true });
    await writeFile(path.join(newDir, 'libraries.json'), '{"current":"b"}');
    const r = migrateUserData(oldDir, newDir, false);
    expect(r).toMatchObject({ step: 'done', method: 'rename' });
    const aside = (r as { aside: string }).aside;
    expect(await readFile(path.join(aside, 'libraries.json'), 'utf8')).toBe('{"current":"b"}');
    expect(await readFile(path.join(newDir, 'libraries.json'), 'utf8')).toBe('{"current":"a"}');
  });

  it('se staré složky nedotkne, když běží stará aplikace nebo je složka vlastní', async () => {
    await symlink(`host-${process.pid}`, path.join(oldDir, 'SingletonLock'));
    expect(migrateUserData(oldDir, newDir, false)).toEqual({ step: 'skip', reason: 'old-running' });
    expect(migrateUserData(oldDir, newDir, true)).toEqual({ step: 'skip', reason: 'custom' });
    expect(existsSync(oldDir)).toBe(true);
    expect(existsSync(newDir)).toBe(false);
  });

  it('na jiném svazku zkopíruje přes dočasnou složku a starou nechá', async () => {
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    });
    expect(migrateUserData(oldDir, newDir, false)).toEqual({ step: 'done', method: 'copy' });
    expect(existsSync(`${newDir}.part`)).toBe(false);
    expect(await readFile(path.join(newDir, 'libraries', 'a', 'jobs', 'j1', 'job.json'), 'utf8')).toBe('{}');
    expect(existsSync(path.join(oldDir, 'libraries.json'))).toBe(true);
    expect(migrateUserData(oldDir, newDir, false)).toEqual({ step: 'skip', reason: 'migrated' });
  });

  it('když přesun selže (Windows: stará aplikace drží soubory), vrátí odsunutou složku a data zůstanou ve staré', async () => {
    await mkdir(newDir);
    await writeFile(path.join(newDir, 'Local State'), '{}');
    const real = vi.mocked(fs.renameSync).getMockImplementation()!;
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (from === oldDir) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      real(from, to);
    });
    expect(migrateUserData(oldDir, newDir, false)).toEqual({ step: 'failed', error: 'busy' });
    vi.mocked(fs.renameSync).mockImplementation(real);
    expect(await readFile(path.join(newDir, 'Local State'), 'utf8')).toBe('{}');
    expect(existsSync(path.join(oldDir, 'libraries.json'))).toBe(true);
    expect((await readdir(base)).sort()).toEqual(['Archa', 'TransLatte']);
  });

  it('zámek po pádu (neživý proces) přesunu nebrání', async () => {
    await symlink('host-999999999', path.join(oldDir, 'SingletonLock'));
    expect(migrateUserData(oldDir, newDir, false)).toEqual({ step: 'done', method: 'rename' });
  });
});
