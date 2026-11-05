import { t, type MessageKey } from './i18n';
import type { LibraryFolder } from './types';

/** Výchozí složky knihovny; názvy jsou v i18n (`folder.<klíč>`), AI z nich vybírá návrh složky karty. */
export const DEFAULT_FOLDER_KEYS = ['contracts', 'invoices', 'study', 'articles', 'manuals', 'official', 'other'] as const;


/** Zobrazený název složky: vlastní, jinak přeložený název výchozí složky. */
export const folderName = (f: LibraryFolder) => f.name || t(`folder.${f.id}` as MessageKey);

/** Text bez diakritiky a velikosti písmen, pro hledání a porovnání názvů. */
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
