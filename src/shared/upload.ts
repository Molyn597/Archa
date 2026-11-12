import { folderPath } from './folders';
import type { DocumentCard, Library } from './types';

/** Kam AI dokument po nahrání zařadila (nebo kam by ho dala): cesta, jistota a potvrzení uživatelem. */
export interface Suggestion {
  /** Existující složka; chybí u návrhu cesty, která se teprve založí. */
  folder?: string;
  path: string;
  sure: boolean;
  /** Uživatel zařazení potvrdil (nebo dokument přesunul ručně). */
  confirmed: boolean;
}

/** Návrh složky pro právě nahraný dokument: otevřený dotaz AI, jinak dnešní zařazení, jinak cesta z karty. */
export function suggestion(library: Library, jobId: string, card?: DocumentCard): Suggestion | undefined {
  const question = library.questions?.find((q) => q.jobId === jobId);
  if (question?.options[0]) return { path: question.options[0], sure: false, confirmed: false };
  const assigned = library.assign[jobId];
  const folder = assigned && library.folders.find((f) => f.id === assigned.folder);
  if (folder) return { folder: folder.id, path: folderPath(library.folders, folder), sure: card?.folderSure !== false, confirmed: Boolean(assigned.manual) };
  return card?.folder ? { path: card.folder, sure: false, confirmed: false } : undefined;
}

/** Návrh, který jde potvrdit hromadně: jistý a ještě nepotvrzený. */
export const bulkSavable = (s?: Suggestion): s is Suggestion => Boolean(s?.sure && !s.confirmed && s.folder);
