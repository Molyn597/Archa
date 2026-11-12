import { ancestors, childFolders, fold, folderName, isLocked, resolvePath, subtree } from './folders';
import { isStudy } from './projects';
import type { Library, LibraryKind, Project } from './types';

/** Složka cílové knihovny pro přesunutý dokument: podle návrhu karty (cesta nebo název složky), jinak Ostatní, jinak nezařazený. Zamčené složky se nepoužijí. */
export function targetFolder(target: Library, suggestion?: string): string | undefined {
  const open = target.folders.filter((f) => !isLocked(target.folders, f));
  const wanted = suggestion?.trim();
  if (wanted) {
    const byPath = resolvePath(open, wanted);
    if (byPath) return byPath;
    const leaf = fold(wanted.split(/\s*[/>]\s*/).filter(Boolean).at(-1) ?? '');
    const byName = leaf && open.find((f) => fold(folderName(f)) === leaf);
    if (byName) return byName.id;
  }
  return open.find((f) => f.id === 'other')?.id;
}

/** Názvy složek od `from` (nebo od nejvyšší úrovně) dolů k složce; prázdné pole = dokument bez složky (nebo mimo `from`). */
/**
 * Cesta pro cílovou knihovnu: úvodní složka pojmenovaná jako typ cíle („Studium“ při přesunu do studijní knihovny)
 * se vynechá, ať se její podsložky spojí s tím, co v cíli už je (Studium › Články → Články).
 */
export function pathForTarget(names: string[], kind: LibraryKind): string[] {
  const own: Partial<Record<LibraryKind, string>> = { study: folderName({ id: 'study', createdAt: 0 }) };
  return own[kind] && names.length > 1 && fold(names[0]) === fold(own[kind]!) ? names.slice(1) : names;
}

export function pathNames(folders: Library['folders'], folderId: string | undefined, from?: string): string[] {
  const f = folders.find((x) => x.id === folderId);
  if (!f) return [];
  const chain = [...ancestors(folders, f.id), f];
  const start = from ? chain.findIndex((x) => x.id === from) : 0;
  return start < 0 ? [] : chain.slice(start).map(folderName);
}

/**
 * Složka v cíli pro cestu názvů: existující nezamčená složka se stejným názvem (`fold`) na stejné úrovni se použije,
 * chybějící se založí s novým id a vlastním názvem (i pro výchozí složky zdroje, takže nehrozí kolize výchozího id).
 */
export function ensureNamedPath(target: Library, names: string[], newId: () => string = () => crypto.randomUUID()): string | undefined {
  let parent: string | undefined;
  for (const name of names) {
    const wanted = fold(name);
    const open = childFolders(target.folders, parent).filter((f) => !isLocked(target.folders, f));
    const found = open.find((f) => fold(folderName(f)) === wanted);
    if (found) {
      parent = found.id;
      continue;
    }
    const folder = { id: newId(), name: name.slice(0, 60), createdAt: Date.now(), ...(parent && { parent }) };
    target.folders.push(folder);
    parent = folder.id;
  }
  return parent;
}

/** Zařadí dokument do složky podle cesty názvů (založí chybějící). Bez cesty nic nedělá a vrací undefined. */
export function placeWithPath(target: Library, jobId: string, names: string[], newId?: () => string): string | undefined {
  const folder = ensureNamedPath(target, names, newId);
  if (folder) target.assign[jobId] = { folder };
  return folder;
}

/** Zařadí dokumenty v cílové knihovně (`suggestions`: id → návrh složky z karty; `paths`: id → cesta názvů ze zdroje, má přednost) a přenese zaplacení (`paid` ze zdroje). Vrací id složky nebo undefined. */
export function placeEntries(target: Library, ids: string[], suggestions: Record<string, string | undefined> = {}, paid: Library['paid'] = {}, paths: Record<string, string[] | undefined> = {}) {
  const placed: Record<string, string | undefined> = {};
  for (const id of ids) {
    const folder = (paths[id]?.length ? placeWithPath(target, id, paths[id]!) : undefined) ?? targetFolder(target, suggestions[id]);
    placed[id] = folder;
    if (folder) target.assign[id] = { folder };
    else delete target.assign[id];
    if (paid?.[id] !== undefined) (target.paid ??= {})[id] = paid[id];
  }
  return placed;
}

/** Odebere záznamy o dokumentech ze zdrojové knihovny: zařazení, zaplacení, dotazy AI, deník AI a naposledy otevřené. */
export function releaseEntries(source: Library, ids: string[]) {
  const gone = new Set(ids);
  for (const id of ids) {
    delete source.assign[id];
    if (source.paid) delete source.paid[id];
  }
  if (source.paid && !Object.keys(source.paid).length) delete source.paid;
  if (source.questions) source.questions = source.questions.filter((q) => !gone.has(q.jobId));
  if (source.aiLog) source.aiLog = source.aiLog.filter((p) => !gone.has(p.jobId));
  if (source.recent) source.recent = source.recent.filter((id) => !gone.has(id));
  for (const key of ['questions', 'aiLog', 'recent'] as const) if (!source[key]?.length) delete source[key];
}

/** Obojí najednou (obě knihovny se upraví). */
export function transferEntries(source: Library, target: Library, ids: string[], suggestions: Record<string, string | undefined> = {}) {
  const placed = placeEntries(target, ids, suggestions, source.paid);
  releaseEntries(source, ids);
  return placed;
}

/** Odebere dokumenty ze zdrojů projektu (ať nezůstane odkaz na přesunutý dokument); vrací, zda se něco změnilo. */
export function dropSources(project: Project, ids: string[]): boolean {
  const gone = new Set(ids);
  const kept = project.sources.filter((id) => !gone.has(id));
  if (kept.length === project.sources.length) return false;
  project.sources = kept;
  return true;
}

/** Složky, kterých se přesun dotkl: cesty přesunutých dokumentů a `from` (přesouvaná složka) včetně podsložek. Počítá se před úpravou zdroje. */
export function touchedFolders(source: Library, ids: string[], from?: string): Set<string> {
  const out = new Set<string>();
  const add = (id: string) => subtree(source.folders, id).forEach((x) => out.add(x));
  if (from) add(from);
  for (const id of ids) {
    const folder = source.assign[id]?.folder;
    if (!folder) continue;
    for (const f of [...ancestors(source.folders, folder), source.folders.find((x) => x.id === folder)]) if (f) add(f.id);
  }
  return out;
}

/**
 * Odstraní z `touched` složky, jejichž celý podstrom je bez dokumentů a bez zámku (volat po `releaseEntries`).
 * Jiné složky se nedotknou. Vrací id odstraněných.
 */
export function pruneFolders(library: Library, touched: Set<string>): string[] {
  const used = new Set(Object.values(library.assign).map((a) => a.folder));
  const gone = new Set(
    library.folders
      .filter((f) => touched.has(f.id) && [...subtree(library.folders, f.id)].every((id) => !used.has(id) && !library.folders.some((x) => x.id === id && isLocked(library.folders, x))))
      .map((f) => f.id),
  );
  library.folders = library.folders.filter((f) => !gone.has(f.id));
  return [...gone];
}

/** Studijní obsah, který patří do Studia: článkové dokumenty a studijní projekty (se zdroji). */
export interface StudyOffer {
  action: 'move' | 'create';
  /** Dokumenty k přesunu: články a knihy + zdroje přesouvaných projektů. */
  ids: string[];
  projectIds: string[];
  literature: number;
  /** Zamčené nebo zpracovávané dokumenty a projekty s nimi, které se nepřesunou. */
  skipped: number;
}

/**
 * Nabídka přesunu studijních věcí z pracovní, osobní nebo nepřevzaté knihovny. Projekt se přesouvá celý i se zdroji:
 * má-li zdroj, který přesunout nejde, zůstane i s ostatními zdroji. null = není co nabídnout.
 * `docs`: všechny dokumenty knihovny (`movable` = nezamčený a nezpracovávaný).
 */
export function studyOffer(opts: { kind: LibraryKind; hasStudy: boolean; docs: { id: string; literature: boolean; movable: boolean }[]; projects: Project[] }): StudyOffer | null {
  if (opts.kind === 'study') return null;
  const byId = new Map(opts.docs.map((d) => [d.id, d]));
  const books = opts.docs.filter((d) => d.literature && d.movable);
  const projects = opts.projects.filter((p) => isStudy(p.kind));
  const blocked = projects.filter((p) => p.sources.some((id) => byId.has(id) && !byId.get(id)!.movable));
  const moving = projects.filter((p) => !blocked.includes(p));
  const ids = new Set([...books.map((d) => d.id), ...moving.flatMap((p) => p.sources.filter((id) => byId.has(id)))]);
  if (!ids.size && !moving.length) return null;
  return {
    action: opts.hasStudy ? 'move' : 'create',
    ids: [...ids],
    projectIds: moving.map((p) => p.id),
    literature: books.length,
    skipped: opts.docs.filter((d) => d.literature && !d.movable).length + blocked.length,
  };
}
