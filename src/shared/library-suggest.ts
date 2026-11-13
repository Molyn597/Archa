import { t } from './i18n';
import { isLiterature } from './nav';
import type { DocType, LibraryInfo, LibraryKind } from './types';

type LibraryRef = Pick<LibraryInfo, 'id' | 'kind'>;

/** Návrh jiné knihovny: kam dokument patří a jak se má jmenovat složka v ní (první shoda z `folders` v cíli, jinak složka z karty). */
export interface LibrarySuggestion {
  libraryId: string;
  folders: string[];
}

/** Názvy složek v cílové knihovně daného typu, kam typ dokumentu patří (články a knihy do Studia, faktury a smlouvy do Práce). */
export function folderHints(type: DocType | undefined, targetKind: LibraryKind): string[] {
  if (targetKind === 'study' && isLiterature(type)) return type === 'book' ? ['Knihy', 'Books', t('folder.articles')] : [t('folder.articles')];
  if (targetKind === 'work' && type === 'invoice') return [t('folder.invoices')];
  if (targetKind === 'work' && type === 'contract') return [t('folder.contracts')];
  return [];
}

/**
 * Jiná knihovna, kam dokument patří víc než do otevřené: články a knihy mimo Studium → studijní knihovna,
 * faktury a smlouvy ve Studiu → pracovní. Jinak null (zůstane tady).
 */
export function suggestLibrary(opts: { kind: LibraryKind; currentId: string; type: DocType | undefined; cardFolder?: string; libraries: LibraryRef[] }): LibrarySuggestion | null {
  const wanted: LibraryKind | null = isLiterature(opts.type) ? (opts.kind === 'study' ? null : 'study') : opts.kind === 'study' && (opts.type === 'invoice' || opts.type === 'contract') ? 'work' : null;
  const target = wanted && opts.libraries.find((l) => l.kind === wanted && l.id !== opts.currentId);
  if (!target) return null;
  return { libraryId: target.id, folders: [...folderHints(opts.type, target.kind), ...(opts.cardFolder ? [opts.cardFolder] : [])] };
}
