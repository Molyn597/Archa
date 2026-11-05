import { DEFAULT_FOLDER_KEYS, fold, folderName } from '../shared/folders';
import type { Library } from '../shared/types';

/** Výchozí knihovna: jedna složka za každý klíč, bez zařazených dokumentů. */
export const defaultLibrary = (): Library => ({
  folders: DEFAULT_FOLDER_KEYS.map((id) => ({ id, createdAt: 0 })),
  assign: {},
});

/** Složka podle návrhu AI (název bez ohledu na velikost písmen a diakritiku, nebo klíč výchozí složky). */
export function matchFolder(library: Library, suggestion?: string): string | undefined {
  const wanted = fold(suggestion ?? '');
  if (!wanted) return undefined;
  return library.folders.find((f) => fold(folderName(f)) === wanted)?.id ?? library.folders.find((f) => f.id === wanted)?.id;
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

/** Smaže složku; její dokumenty zůstanou nezařazené. */
export function removeFolder(library: Library, id: string) {
  library.folders = library.folders.filter((f) => f.id !== id);
  for (const [job, a] of Object.entries(library.assign)) if (a.folder === id) delete library.assign[job];
}

/** Ruční přesun dokumentů; `null` = mezi nezařazené. */
export function moveDocs(library: Library, jobIds: string[], folderId: string | null) {
  for (const id of jobIds) {
    if (folderId === null) delete library.assign[id];
    else library.assign[id] = { folder: folderId, manual: true };
  }
}
