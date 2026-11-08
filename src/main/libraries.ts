import { randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { templateLibrary } from '../shared/library-templates';
import type { Libraries, LibraryInfo, LibraryKind } from '../shared/types';
import { LIBRARY_SETTINGS } from './store';

/**
 * Oddělené knihovny: každá má vlastní složku userData/libraries/<id> (dokumenty, projekty, složky, chat, trezor, část nastavení).
 * Šifra souboru je vázaná na cestu vůči kořeni knihovny (jobs/<id>/…), takže přesun celé knihovny ji neporuší.
 */

const FILE = 'libraries.json';
/** Deník rozpracovaného převzetí dat: přerušené převzetí se při dalším startu dokončí. */
const JOURNAL = 'migrating.json';
/** Záloha malých, ale nenahraditelných souborů před převzetím (vault.json = zašifrovaný hlavní klíč). */
export const BACKUP = 'backup-pre-libraries';
/** Data starší verze přímo v userData, která patří knihovně. */
export const MOVED = ['jobs', 'projects', 'library.json', 'library-chat.json', 'vault.json'] as const;
const BACKED_UP = ['library.json', 'settings.json', 'vault.json'];

export const libraryRoot = (appRoot: string, id: string) => path.join(appRoot, 'libraries', id);

const exists = (file: string) => access(file).then(() => true, () => false);

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeAtomic(file: string, data: unknown) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 1));
  await rename(tmp, file);
}

export const saveLibraries = (appRoot: string, libs: Libraries) => writeAtomic(path.join(appRoot, FILE), libs);

/** Platný seznam: aktuální knihovna musí existovat. */
const valid = (libs: Libraries | null): libs is Libraries => !!libs?.list?.length && libs.list.some((l) => l.id === libs.current);

/**
 * Seznam knihoven; při prvním startu nové verze převezme data starší verze do první knihovny.
 * Postup: záloha → deník → přesun přejmenováním (nic se nekopíruje ani nepřepisuje) → libraries.json → smazání deníku.
 */
export async function loadLibraries(appRoot: string): Promise<Libraries> {
  const saved = await readJson<Libraries>(path.join(appRoot, FILE));
  const journal = await readJson<{ id: string }>(path.join(appRoot, JOURNAL));
  if (valid(saved) && !journal) return saved;

  // Poškozený seznam: knihovny se obnoví podle složek (žádná data se neztratí z dohledu).
  const dirs = valid(saved) ? [] : await readdir(path.join(appRoot, 'libraries')).catch(() => [] as string[]);
  const found: Libraries | null = dirs.length ? { current: dirs[0], list: dirs.map((d) => ({ id: d, kind: 'general' as const, createdAt: 0 })), setupDone: true } : null;
  const known = valid(saved) ? saved : found;

  const old = (await Promise.all(MOVED.map((n) => exists(path.join(appRoot, n))))).some(Boolean);
  const id = journal?.id ?? known?.current ?? randomUUID();
  const root = libraryRoot(appRoot, id);
  await mkdir(root, { recursive: true });

  if (old || journal) {
    if (!journal) {
      await mkdir(path.join(appRoot, BACKUP), { recursive: true });
      for (const n of BACKED_UP) {
        const src = path.join(appRoot, n);
        const dst = path.join(appRoot, BACKUP, n);
        if ((await exists(src)) && !(await exists(dst))) await copyFile(src, dst);
      }
      await writeAtomic(path.join(appRoot, JOURNAL), { id });
    }
    for (const n of MOVED) {
      const src = path.join(appRoot, n);
      // Cíl už existuje (nečekaný stav): nic se nepřepíše, původní data zůstanou na místě.
      if ((await exists(src)) && !(await exists(path.join(root, n)))) await rename(src, path.join(root, n));
    }
    const own = path.join(root, 'settings.json');
    const global = await readJson<Record<string, unknown>>(path.join(appRoot, 'settings.json'));
    if (global && !(await exists(own))) await writeAtomic(own, Object.fromEntries(LIBRARY_SETTINGS.filter((k) => k in global).map((k) => [k, global[k]])));
  }

  const libs: Libraries = known ?? { current: id, list: [{ id, kind: 'general', createdAt: Date.now() }] };
  if (!libs.list.some((l) => l.id === id)) libs.list.push({ id, kind: 'general', createdAt: Date.now() });
  await saveLibraries(appRoot, libs);
  await rm(path.join(appRoot, JOURNAL), { force: true });
  return libs;
}

/** Nová knihovna se šablonou složek podle typu. */
export async function createLibrary(appRoot: string, libs: Libraries, kind: LibraryKind, subjects?: string[], name?: string): Promise<LibraryInfo> {
  const info: LibraryInfo = { id: randomUUID(), kind, createdAt: Date.now(), ...(name?.trim() && { name: name.trim() }) };
  const root = libraryRoot(appRoot, info.id);
  await mkdir(root, { recursive: true });
  await writeAtomic(path.join(root, 'library.json'), templateLibrary(kind, subjects));
  libs.list.push(info);
  await saveLibraries(appRoot, libs);
  return info;
}

/** Knihovna zatím bez dokumentů i projektů (šablonu lze bez obav přepsat). */
export async function isEmptyLibrary(appRoot: string, id: string) {
  const root = libraryRoot(appRoot, id);
  const [jobs, projects] = await Promise.all(['jobs', 'projects'].map((d) => readdir(path.join(root, d)).catch(() => [] as string[])));
  return !jobs.length && !projects.length;
}

/**
 * Výběr knihoven při prvním spuštění. Prázdná první knihovna dostane typ a šablonu prvního vybraného typu;
 * převzatá data zůstanou ve své knihovně se svými složkami (jen dostane typ `keep`). Ostatní typy = nové knihovny.
 */
export async function setupLibraries(appRoot: string, libs: Libraries, kinds: LibraryKind[], opts: { subjects?: string[]; keep?: LibraryKind } = {}) {
  // Výběr proběhne jen jednou (dvojí klik nesmí založit knihovny dvakrát).
  if (libs.setupDone) return libs;
  const first = libs.list.find((l) => l.id === libs.current)!;
  const todo = [...new Set(kinds)];
  if (await isEmptyLibrary(appRoot, first.id)) {
    const kind = todo.shift();
    if (kind) {
      first.kind = kind;
      await writeAtomic(path.join(libraryRoot(appRoot, first.id), 'library.json'), templateLibrary(kind, opts.subjects));
    }
  } else {
    const keep = opts.keep && todo.includes(opts.keep) ? opts.keep : (todo[0] ?? first.kind);
    first.kind = keep;
    todo.splice(todo.indexOf(keep), todo.includes(keep) ? 1 : 0);
  }
  libs.setupDone = true;
  await saveLibraries(appRoot, libs);
  for (const kind of todo) await createLibrary(appRoot, libs, kind, kind === 'study' ? opts.subjects : undefined);
  return libs;
}
