import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { t } from '../shared/i18n';
import { folderHints } from '../shared/library-suggest';
import { dropSources, pathForTarget, pathNames, placeEntries, pruneFolders, releaseEntries, touchedFolders } from '../shared/library-transfer';
import { templateLibrary } from '../shared/library-templates';
import type { Libraries, Library, MoveOptions, Project } from '../shared/types';
import { libraryRoot } from './libraries';
import { shouldBeLocked } from './library';
import type { Store } from './store';

const exists = (p: string) => stat(p).then(() => true, () => false);

/** Soubory složky (i v podsložkách) s velikostí: relativní cesta → bajty. */
async function manifest(dir: string, sub = ''): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const e of await readdir(path.join(dir, sub), { withFileTypes: true })) {
    const rel = path.join(sub, e.name);
    if (e.isDirectory()) for (const [k, v] of await manifest(dir, rel)) out.set(k, v);
    else out.set(rel, (await stat(path.join(dir, rel))).size);
  }
  return out;
}

const sameManifest = (a: Map<string, number>, b: Map<string, number>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/**
 * Zkopíruje složku do cíle přes dočasné místo mimo `jobs/`, ověří úplnost (počet souborů a velikosti)
 * a teprve potom ji přejmenuje na místo; cíl se nikdy nepřepisuje. Zdroj se nemění.
 */
export async function copyDirVerified(src: string, dst: string, tmp: string, incomplete: () => Error): Promise<void> {
  if (await exists(dst)) throw new Error('target exists');
  await rm(tmp, { recursive: true, force: true });
  await mkdir(path.dirname(tmp), { recursive: true });
  try {
    await cp(src, tmp, { recursive: true, errorOnExist: true, force: false });
    if (!sameManifest(await manifest(src), await manifest(tmp))) throw incomplete();
    await mkdir(path.dirname(dst), { recursive: true });
    await rename(tmp, dst);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
}

async function writeAtomic(file: string, data: unknown) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 1));
  await rename(tmp, file);
}

const BUSY = new Set(['running', 'queued', 'picking']);

/**
 * Přesune dokumenty do jiné (nyní neotevřené) knihovny. Pořadí:
 * 1. kontrola všeho předem (zamčené, běžící, existující cíl) – při chybě se nic nezmění;
 * 2. kopie každé složky dokumentu do cíle + ověření úplnosti (při chybě se smažou jen vlastní kopie v cíli);
 * 3. zápis cílové library.json (zařazení, zaplacení);
 * 4. úprava zdrojové library.json a projektů (odebrání zdrojů; přesouvané projekty `opts.projectIds` se kopírují s dokumenty a ve zdroji mažou);
 * 5. teprve nakonec smazání složek ve zdroji.
 * S `keepFolders` se v cíli vytvoří stejné složky (podle názvů) a ve zdroji se odstraní jen ty dotčené, které jsou teď bez dokumentů.
 * Chat s knihovnou i vektory: vektory jsou ve složce dokumentu (přesunou se s ním), chat knihovny ve zdroji zůstává beze změny.
 */
export async function moveToLibrary(store: Store, appRoot: string, libs: Libraries, jobIds: string[], targetId: string, opts: MoveOptions = {}): Promise<number> {
  const info = libs.list.find((l) => l.id === targetId);
  if (!info || targetId === libs.current) throw new Error(t('libs.moveUnknown'));
  let ids = [...new Set(jobIds)];
  const targetRoot = libraryRoot(appRoot, targetId);
  const source = await store.library();

  // 1. Kontrola předem. Karty a názvy se čtou ještě před jakoukoli změnou.
  const suggestions: Record<string, string[]> = {};
  const hints: Record<string, string[]> = {};
  const names: Record<string, string> = {};
  for (const id of [...ids]) {
    const locked = (await store.isLockedJob(id)) || shouldBeLocked(source, id);
    const job = locked ? null : await store.job(id);
    const name = job?.name ?? id;
    if (locked) throw new Error(t('libs.moveLocked', { name }));
    // Dokument, který už neexistuje, se přeskočí.
    if (!job) {
      ids = ids.filter((x) => x !== id);
      continue;
    }
    if (BUSY.has(job.status)) throw new Error(t('libs.moveBusy', { name }));
    if (await exists(path.join(targetRoot, 'jobs', id))) throw new Error(t('libs.moveExists', { name }));
    const card = await store.card(id);
    hints[id] = opts.folders ?? folderHints(card?.type, info.kind);
    suggestions[id] = [...hints[id], ...(card?.folder ? [card.folder] : [])];
    names[id] = name;
  }
  // Přesouvané projekty se čtou předem; chybějící se přeskočí.
  const projects = (await Promise.all([...new Set(opts.projectIds ?? [])].map((id) => store.project(id)))).filter((p): p is Project => !!p);
  for (const p of projects) if (await exists(path.join(targetRoot, 'projects', p.id))) throw new Error(t('libs.moveExists', { name: p.name }));
  if (!ids.length && !projects.length) return 0;

  // 2. Kopie a ověření.
  const copied: string[] = [];
  const undoCopies = () => Promise.all(copied.map((dir) => rm(path.join(targetRoot, dir), { recursive: true, force: true })));
  try {
    for (const id of ids) {
      await copyDirVerified(store.jobDir(id), path.join(targetRoot, 'jobs', id), path.join(targetRoot, '.moving', id), () => new Error(t('libs.moveIncomplete', { name: names[id] })));
      copied.push(path.join('jobs', id));
    }
    // Projekt se kopíruje celý (chat i soubory); zdroje už jsou v cíli ve stejných id.
    for (const p of projects) {
      await copyDirVerified(store.projectDir(p.id), path.join(targetRoot, 'projects', p.id), path.join(targetRoot, '.moving', p.id), () => new Error(t('libs.moveIncomplete', { name: p.name })));
      copied.push(path.join('projects', p.id));
    }

    // 3. Cílová knihovna.
    const file = path.join(targetRoot, 'library.json');
    const raw = await readFile(file, 'utf8').then((s) => JSON.parse(s) as Library, () => null);
    const target: Library = raw?.folders ? { ...raw, assign: raw.assign ?? {} } : templateLibrary(info.kind);
    const paths: Record<string, string[]> = {};
    // Dokument z Ostatní nebo bez složky (např. článek z Práce do Studia) se zařadí podle návrhu, ne do Ostatní v cíli.
    const byHint = (id: string) => !opts.fromFolder && hints[id].length > 0 && (!!opts.folders || [undefined, 'other'].includes(source.assign[id]?.folder));
    if (opts.keepFolders) for (const id of ids) if (!byHint(id)) paths[id] = pathForTarget(pathNames(source.folders, source.assign[id]?.folder, opts.fromFolder), info.kind);
    placeEntries(target, ids, suggestions, source.paid, paths);
    await writeAtomic(file, target);
  } catch (e) {
    await undoCopies();
    throw e;
  }

  // 4. Zdroj: knihovna a projekty.
  const touched = opts.keepFolders ? touchedFolders(source, ids, opts.fromFolder) : new Set<string>();
  await store.updateLibrary((library) => {
    releaseEntries(library, ids);
    pruneFolders(library, touched);
  });
  const moved = new Set(projects.map((p) => p.id));
  for (const project of await store.projects()) if (!moved.has(project.id) && dropSources(project, ids)) await store.saveProject(project);

  // 5. Smazání původních složek až po všem ostatním.
  await Promise.allSettled([...ids.map((id) => store.deleteJob(id)), ...projects.map((p) => store.deleteProject(p.id))]);
  return ids.length;
}
