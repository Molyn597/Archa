import { t } from './i18n';
import type { DocumentCard } from './types';

export const DEFAULT_NAME_TEMPLATE = '{datum} {dodavatel} {typ} {cislo}';
const NAME_MAX = 120;

/** Zástupné značky šablony (česky i anglicky) → údaj z karty. */
const TOKENS: Record<string, (card: DocumentCard) => string | undefined> = {
  datum: (c) => c.facts?.issued || c.facts?.validFrom || c.biblio.year,
  dodavatel: (c) => c.facts?.supplier || c.facts?.parties?.[0] || c.biblio.authors[0]?.family,
  typ: (c) => (c.type === 'other' ? undefined : t(`docType.${c.type}`)),
  cislo: (c) => c.facts?.number,
  nazev: (c) => c.biblio.title,
};
const ALIASES: Record<string, string> = { date: 'datum', party: 'dodavatel', type: 'typ', number: 'cislo', title: 'nazev' };

/** Bez znaků, které souborový systém nepřijme; okraje bez mezer, teček a oddělovačů zbylých po prázdných hodnotách. */
export const safeFileName = (s: string) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s._–-]+|[\s._–-]+$/g, '')
    .slice(0, NAME_MAX)
    .trim();

/** Název dokumentu podle šablony z karty; prázdné hodnoty se vynechají, bez jediné hodnoty vrací prázdný řetězec. */
export function applyTemplate(card: DocumentCard, template: string): string {
  return safeFileName(
    template.replace(/\{(\w+)\}/g, (_, key: string) => {
      const token = TOKENS[ALIASES[key.toLowerCase()] ?? key.toLowerCase()];
      return token?.(card)?.trim() ?? '';
    }),
  );
}
