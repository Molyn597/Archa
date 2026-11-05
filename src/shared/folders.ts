import { t, type MessageKey } from './i18n';
import type { Library, LibraryFolder, Placement } from './types';

/** Výchozí složky knihovny; názvy jsou v i18n (`folder.<klíč>`), AI z nich vybírá návrh složky karty. */
export const DEFAULT_FOLDER_KEYS = ['contracts', 'invoices', 'study', 'articles', 'manuals', 'official', 'other'] as const;

/** Po tolika dnech se dokument z koše smaže natrvalo. */
export const TRASH_DAYS = 30;

/** jobId v průběhu (chat-progress / chat-delta) chatu s knihovnou. */
export const LIBRARY_CHAT = 'library';


/** Zobrazený název složky: vlastní, jinak přeložený název výchozí složky. */
export const folderName = (f: LibraryFolder) => f.name || t(`folder.${f.id}` as MessageKey);

/** Rodič složky; odkaz na smazanou složku = nejvyšší úroveň. */
const parentOf = (folders: LibraryFolder[], f: LibraryFolder) => (f.parent && folders.some((x) => x.id === f.parent) ? f.parent : undefined);

/** Přímé podsložky (`parent` undefined = nejvyšší úroveň) v uloženém pořadí. */
export const childFolders = (folders: LibraryFolder[], parent?: string) => folders.filter((f) => parentOf(folders, f) === parent);

/** Složka a všechny její podsložky (id). */
export function subtree(folders: LibraryFolder[], id: string): Set<string> {
  const out = new Set([id]);
  for (let added = true; added; ) {
    added = false;
    for (const f of folders) {
      const p = parentOf(folders, f);
      if (p && out.has(p) && !out.has(f.id)) {
        out.add(f.id);
        added = true;
      }
    }
  }
  return out;
}

/** Předkové od nejvyššího, bez složky samotné; cyklus v datech se přeruší. */
export function ancestors(folders: LibraryFolder[], id: string): LibraryFolder[] {
  const out: LibraryFolder[] = [];
  const seen = new Set([id]);
  let p = folders.find((f) => f.id === id);
  while (p && (p = folders.find((f) => f.id === parentOf(folders, p!))) && !seen.has(p.id)) {
    seen.add(p.id);
    out.unshift(p);
  }
  return out;
}

/** Cesta složky „Studium / Články / Management“. */
export const folderPath = (folders: LibraryFolder[], f: LibraryFolder) => [...ancestors(folders, f.id), f].map(folderName).join(' / ');

/** Složka je zamčená sama nebo některým předkem. */
export const isLocked = (folders: LibraryFolder[], f: LibraryFolder) => !!f.locked || ancestors(folders, f.id).some((a) => a.locked);

/** Id složky na cestě „Studium / Články“ (název bez ohledu na diakritiku, nebo klíč výchozí složky); neexistuje = undefined. */
export function resolvePath(folders: LibraryFolder[], path: string): string | undefined {
  let parent: string | undefined;
  const parts = path.split(/\s*[/>]\s*/).map((p) => fold(p)).filter(Boolean);
  if (!parts.length) return undefined;
  for (const part of parts) {
    parent = childFolders(folders, parent).find((f) => fold(folderName(f)) === part || f.id === part)?.id;
    if (!parent) return undefined;
  }
  return parent;
}

/** Cesty všech nezamčených složek pro prompty (zamčená složka se modelu neukáže ani názvem). */
export const openPaths = (folders: LibraryFolder[]) => folders.filter((f) => !isLocked(folders, f)).map((f) => folderPath(folders, f));

/** Zařazení AI ještě platí (dokument je pořád tam, kam ho AI dala, a nikdo ho nepřesunul). */
export const placementActive = (library: Library, p: Placement) => !p.undone && library.assign[p.jobId]?.folder === p.folder && !library.assign[p.jobId]?.manual;

/** Text bez diakritiky a velikosti písmen, pro hledání a porovnání názvů. */
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
