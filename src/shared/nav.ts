import type { MessageKey } from './i18n';
import type { DocType, LibraryKind } from './types';

/** Položky hlavního menu, které se podle typu knihovny zobrazují (Přehled a Dokumenty jsou vždy). */
export type NavId = 'overview' | 'history' | 'invoices' | 'deadlines' | 'projects';

export interface NavEntry {
  id: NavId;
  label: MessageKey;
}

/** Hlavní menu knihovny daného typu v pořadí, v jakém se ukazuje. */
export function navFor(kind: LibraryKind): NavEntry[] {
  const base: NavEntry[] = [
    { id: 'overview', label: 'nav.overview' },
    { id: 'history', label: 'nav.history' },
  ];
  const invoices: NavEntry[] = [
    { id: 'invoices', label: 'inv.title' },
    { id: 'deadlines', label: 'dl.title' },
  ];
  if (kind === 'work') return [...base, ...invoices, { id: 'projects', label: 'nav.projects' }];
  // Články a knihy jsou jen filtr dokumentů: jsou ve stromu pod Dokumenty, ne v hlavním menu.
  if (kind === 'study') return [...base, { id: 'projects', label: 'nav.works' }];
  return [...base, ...invoices, { id: 'projects', label: 'nav.projects' }];
}

/** Typy karet, které patří do pohledu Články a knihy. */
export const LITERATURE_TYPES: readonly DocType[] = ['article', 'book', 'chapter', 'thesis'];

export const isLiterature = (type: DocType | undefined) => !!type && LITERATURE_TYPES.includes(type);
