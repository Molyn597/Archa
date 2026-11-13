import type { MessageKey } from './i18n';
import type { DocType, LibraryKind } from './types';

/** Položky hlavního menu knihovny. Dokumenty v něm nejsou: otevírají se klikem na složku. */
export type NavId = 'overview' | 'upload' | 'invoices' | 'deadlines' | 'projects';

export interface NavEntry {
  id: NavId;
  label: MessageKey;
}

/** Hlavní menu knihovny daného typu v pořadí, v jakém se ukazuje. */
export function navFor(kind: LibraryKind): NavEntry[] {
  const base: NavEntry[] = [
    { id: 'overview', label: 'nav.overview' },
    { id: 'upload', label: 'nav.upload' },
  ];
  const deadlines: NavEntry = { id: 'deadlines', label: 'dl.title' };
  if (kind === 'study') return [...base, { id: 'projects', label: 'nav.myWork' }, deadlines];
  // Nepřevzatý typ (general) je osobní prostor; faktury a zakázky jen v knihovně Práce.
  if (kind === 'personal' || kind === 'general') return [...base, deadlines];
  return [...base, { id: 'invoices', label: 'inv.title' }, deadlines, { id: 'projects', label: 'nav.jobs' }];
}

/** Typy karet, které patří do pohledu Články a knihy. */
export const LITERATURE_TYPES: readonly DocType[] = ['article', 'book', 'chapter', 'thesis', 'web'];

export const isLiterature = (type: DocType | undefined) => !!type && LITERATURE_TYPES.includes(type);
