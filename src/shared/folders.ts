import { t, type MessageKey } from './i18n';

/** Výchozí složky knihovny; názvy jsou v i18n (`folder.<klíč>`), AI z nich vybírá návrh složky karty. */
export const DEFAULT_FOLDER_KEYS = ['contracts', 'invoices', 'study', 'articles', 'manuals', 'official', 'other'] as const;

/** Názvy výchozích složek v jazyce rozhraní. */
export const defaultFolders = (): string[] => DEFAULT_FOLDER_KEYS.map((k) => t(`folder.${k}` as MessageKey));
