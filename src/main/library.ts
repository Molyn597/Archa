import { randomUUID } from 'node:crypto';
import { childFolders, DEFAULT_FOLDER_KEYS, fold, folderName, folderPath, isLocked, subtree } from '../shared/folders';
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
  const existing = ensurePath(library, path, false).id ?? matchFolder(library, path);
  if (existing) {
    library.assign[jobId] = { folder: existing };
    return undefined;
  }
  if (!path) {
    autoAssign(library, jobId);
    return undefined;
  }
  const { id, created } = ensurePath(library, path, true, newId);
  if (!id) return undefined;
  library.assign[jobId] = { folder: id };
  return { jobId, path, created, ...(current && { previous: current.folder }) };
}

/** Vrátí zařazení AI: dokument zpět (pokud ho mezitím nikdo nepřesunul), prázdné založené složky pryč. */
export function undoPlacement(library: Library, p: Placement) {
  const now = library.assign[p.jobId];
  const target = p.created.at(-1);
  if (now && !now.manual && now.folder === target) {
    if (p.previous && library.folders.some((f) => f.id === p.previous)) library.assign[p.jobId] = { folder: p.previous };
    else delete library.assign[p.jobId];
  }
  for (const id of [...p.created].reverse()) {
    const used = Object.values(library.assign).some((a) => a.folder === id) || library.folders.some((f) => f.parent === id);
    if (!used) library.folders = library.folders.filter((f) => f.id !== id);
  }
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
