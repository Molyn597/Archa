import { randomUUID } from 'node:crypto';
import { childFolders, DEFAULT_FOLDER_KEYS, fold, folderName, folderPath, isLocked, placementActive, similarName, subtree } from '../shared/folders';

export { placementActive };
import type { DocumentCard, Library, OrganizePlan, Placement } from '../shared/types';

/** Výchozí knihovna: jedna složka za každý klíč, bez zařazených dokumentů. */
export const defaultLibrary = (): Library => ({
  folders: DEFAULT_FOLDER_KEYS.map((id) => ({ id, createdAt: 0 })),
  assign: {},
});

const normPath = (s: string) => fold(s).split(/\s*[/>]\s*/).filter(Boolean).join('/');

/**
 * Složka podle návrhu AI bez ohledu na velikost písmen a diakritiku: celá cesta „Studium / Články“,
 * pak název (poslední část cesty) nebo klíč výchozí složky.
 */
export function matchFolder(library: Library, suggestion?: string): string | undefined {
  const wanted = normPath(suggestion ?? '');
  if (!wanted) return undefined;
  const { folders } = library;
  const leaf = wanted.split('/').at(-1)!;
  return (
    folders.find((f) => normPath(folderPath(folders, f)) === wanted)?.id ??
    folders.find((f) => fold(folderName(f)) === leaf)?.id ??
    folders.find((f) => f.id === leaf)?.id
  );
}

/** Zařadí dokument podle návrhu karty; ruční zařazení nechá být. Vrací, zda se něco změnilo. */
export function autoAssign(library: Library, jobId: string, suggestion?: string): boolean {
  const current = library.assign[jobId];
  if (current?.manual) return false;
  const fallback = library.folders.some((f) => f.id === 'other') ? 'other' : undefined;
  const folder = matchFolder(library, suggestion) ?? fallback;
  if (current?.folder === folder) return false;
  if (folder) library.assign[jobId] = { folder };
  else delete library.assign[jobId];
  return true;
}

/** Smaže složku; podsložky i dokumenty se posunou o úroveň výš (z nejvyšší úrovně dokumenty do nezařazených). */
export function removeFolder(library: Library, id: string) {
  const parent = library.folders.find((f) => f.id === id)?.parent;
  library.folders = library.folders.filter((f) => f.id !== id);
  for (const f of library.folders) {
    if (f.parent !== id) continue;
    if (parent) f.parent = parent;
    else delete f.parent;
  }
  for (const [job, a] of Object.entries(library.assign)) {
    if (a.folder !== id) continue;
    if (parent) a.folder = parent;
    else delete library.assign[job];
  }
}

/** Přesune složku pod jinou (`null` = nejvyšší úroveň). Do sebe nebo vlastní podsložky nejde: vrací false. */
export function moveFolder(library: Library, id: string, parent: string | null): boolean {
  const folder = library.folders.find((f) => f.id === id);
  if (!folder || (parent !== null && (!library.folders.some((f) => f.id === parent) || subtree(library.folders, id).has(parent)))) return false;
  if (parent) folder.parent = parent;
  else delete folder.parent;
  return true;
}

/** Ruční přesun dokumentů; `null` = mezi nezařazené. */
export function moveDocs(library: Library, jobIds: string[], folderId: string | null) {
  for (const id of jobIds) {
    if (folderId === null) delete library.assign[id];
    else library.assign[id] = { folder: folderId, manual: true };
  }
}

/** Části cesty „Studium / Články“ (oddělovač / nebo >), bez prázdných. */
export const pathParts = (path: string) => path.split(/\s*[/>]\s*/).map((p) => p.trim()).filter(Boolean);

/**
 * Složka podle cesty od nejvyšší úrovně (název bez ohledu na velikost písmen a diakritiku, nebo klíč výchozí složky).
 * S `create` chybějící úrovně založí; vrací id cílové složky a založené složky od nejvyšší úrovně.
 */
export function ensurePath(library: Library, path: string, create: boolean, newId: () => string = randomUUID): { id?: string; created: string[] } {
  const created: string[] = [];
  let parent: string | undefined;
  for (const part of pathParts(path)) {
    const wanted = fold(part);
    const found = childFolders(library.folders, parent).find((f) => fold(folderName(f)) === wanted || f.id === wanted);
    if (found) {
      parent = found.id;
      continue;
    }
    if (!create) return { created };
    // Skoro stejná sourozenecká složka („Ekonomika“ vedle „Ekonomie“) se použije místo zakládání duplicity.
    const similar = childFolders(library.folders, parent).find((f) => similarName(folderName(f), part));
    if (similar) {
      parent = similar.id;
      continue;
    }
    const folder = { id: newId(), name: part.slice(0, 60), createdAt: Date.now(), ...(parent && { parent }) };
    library.folders.push(folder);
    created.push(folder.id);
    parent = folder.id;
  }
  return { id: parent, created };
}

const dropQuestion = (library: Library, jobId: string) => {
  library.questions = library.questions?.filter((q) => q.jobId !== jobId);
  if (!library.questions?.length) delete library.questions;
};

/**
 * Zařazení podle karty. Ruční zařazení nechá být. Nejistý návrh = dotaz uživateli (dokument zůstane, kde je).
 * Existující složka se použije rovnou, jistý návrh nové cesty chybějící složky založí a vrátí `Placement` pro Vrátit.
 */
export function placeDoc(library: Library, jobId: string, card: Pick<DocumentCard, 'folder' | 'folderSure' | 'folderOptions'>, newId?: () => string): Placement | undefined {
  const current = library.assign[jobId];
  if (current?.manual) return undefined;
  dropQuestion(library, jobId);
  const path = card.folder?.trim() ?? '';
  if (card.folderSure === false) {
    const options = [...new Set([path, ...(card.folderOptions ?? [])].map((o) => o.trim()).filter(Boolean))].slice(0, 3);
    if (options.length) {
      (library.questions ??= []).push({ jobId, options, at: Date.now() });
      return undefined;
    }
  }
  const placed = (folder: string, created: string[] = []): Placement | undefined => {
    if (current?.folder === folder) return undefined;
    library.assign[jobId] = { folder };
    const target = library.folders.find((f) => f.id === folder)!;
    return { jobId, path: folderPath(library.folders, target), folder, created, at: Date.now(), ...(current && { previous: current.folder }) };
  };
  const existing = ensurePath(library, path, false).id ?? matchFolder(library, path);
  if (existing) return placed(existing);
  if (!path) {
    const fallback = library.folders.some((f) => f.id === 'other') ? 'other' : undefined;
    return fallback ? placed(fallback) : undefined;
  }
  const { id, created } = ensurePath(library, path, true, newId);
  return id ? placed(id, created) : undefined;
}

const AI_LOG = 50;

/** Zapíše automatické zařazení do přehledu (nejnovější první, nejvýš AI_LOG); starší záznam téhož dokumentu nahradí. */
export function logPlacement(library: Library, p: Placement) {
  library.aiLog = [p, ...(library.aiLog ?? []).filter((e) => e.jobId !== p.jobId)].slice(0, AI_LOG);
}

/** Vrátí zařazení AI: dokument zpět (pokud ho mezitím nikdo nepřesunul), prázdné založené složky pryč. */
export function undoPlacement(library: Library, p: Placement) {
  if (placementActive(library, p)) {
    if (p.previous && library.folders.some((f) => f.id === p.previous)) library.assign[p.jobId] = { folder: p.previous };
    else delete library.assign[p.jobId];
  }
  for (const id of [...p.created].reverse()) {
    const used = Object.values(library.assign).some((a) => a.folder === id) || library.folders.some((f) => f.parent === id);
    if (!used) library.folders = library.folders.filter((f) => f.id !== id);
  }
  for (const e of library.aiLog ?? []) if (e.jobId === p.jobId && e.at === p.at) e.undone = true;
}

/** Odpověď na dotaz: vybraná cesta se případně založí a dokument se do ní ručně zařadí; `null` = nechat. */
export function answerQuestion(library: Library, jobId: string, path: string | null, newId?: () => string) {
  dropQuestion(library, jobId);
  if (!path) return;
  const { id } = ensurePath(library, path, true, newId);
  if (id) library.assign[jobId] = { folder: id, manual: true };
}

/** Provede potvrzený návrh: založí složky, zařadí dokumenty (ručně – AI je už nepřesune), dotazy uloží. */
export function applyPlan(library: Library, plan: OrganizePlan, newId?: () => string) {
  for (const { path, jobIds } of plan.folders) {
    if (!jobIds.length) continue;
    const { id } = ensurePath(library, path, true, newId);
    if (!id) continue;
    for (const jobId of jobIds) {
      library.assign[jobId] = { folder: id, manual: true };
      dropQuestion(library, jobId);
    }
  }
  for (const q of plan.questions) {
    dropQuestion(library, q.jobId);
    (library.questions ??= []).push(q);
  }
}

/** Navržená složka existuje a má (nezamčené) podsložky: dokument má jít do některé z nich. Vrací její cestu a cesty podsložek. */
export function subfolderTarget(library: Library, path: string): { path: string; children: string[] } | undefined {
  const id = ensurePath(library, path, false).id ?? matchFolder(library, path);
  const folder = library.folders.find((f) => f.id === id);
  if (!folder) return undefined;
  const children = childFolders(library.folders, folder.id).filter((f) => !isLocked(library.folders, f));
  return children.length ? { path: folderPath(library.folders, folder), children: children.map((f) => folderPath(library.folders, f)) } : undefined;
}

/**
 * Sloučí složku `from` do `into`: dokumenty i podsložky přejdou do cílové, stejnojmenné (i skoro stejné) podsložky
 * se sloučí také, `from` zmizí. Do vlastní podsložky ani do sebe nejde: vrací false.
 */
export function mergeFolders(library: Library, from: string, into: string): boolean {
  const source = library.folders.find((f) => f.id === from);
  if (!source || !library.folders.some((f) => f.id === into) || subtree(library.folders, from).has(into)) return false;
  for (const a of Object.values(library.assign)) if (a.folder === from) a.folder = into;
  for (const child of childFolders(library.folders, from)) {
    const twin = childFolders(library.folders, into).find((f) => similarName(folderName(f), folderName(child)));
    if (twin) mergeFolders(library, child.id, twin.id);
    else child.parent = into;
  }
  library.folders = library.folders.filter((f) => f.id !== from);
  for (const e of library.aiLog ?? []) if (e.folder === from) e.folder = into;
  return true;
}

/** Dvojice skoro stejně pojmenovaných sourozeneckých složek (bez AI); cílem je ta s víc dokumenty. */
export function similarFolders(library: Library): { from: string; into: string }[] {
  const count = (id: string) => [...subtree(library.folders, id)].reduce((n, f) => n + Object.values(library.assign).filter((a) => a.folder === f).length, 0);
  const pairs: { from: string; into: string }[] = [];
  const open = library.folders.filter((f) => !isLocked(library.folders, f));
  for (const [i, a] of open.entries()) {
    for (const b of open.slice(i + 1)) {
      if ((a.parent ?? '') !== (b.parent ?? '') || !similarName(folderName(a), folderName(b))) continue;
      pairs.push(count(a.id) >= count(b.id) ? { from: b.id, into: a.id } : { from: a.id, into: b.id });
    }
  }
  return pairs;
}
