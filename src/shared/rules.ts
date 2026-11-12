import { fold } from './folders';
import type { DocumentCard, FolderRule } from './types';

/** Kolik pravidel se z oprav uchová (nejnovější první). */
export const RULES_MAX = 50;
const MATCH_MAX = 60;

/** Čím se dokument pozná: dodavatel nebo protistrana z karty, jinak první klíčové slovo. */
export function ruleMatch(card: Pick<DocumentCard, 'facts' | 'keywords'>): Pick<FolderRule, 'by' | 'match'> | undefined {
  const party = (card.facts?.supplier || card.facts?.parties?.[0] || '').trim();
  if (party) return { by: 'party', match: party.slice(0, MATCH_MAX) };
  const keyword = card.keywords[0]?.trim();
  return keyword ? { by: 'keyword', match: keyword.slice(0, MATCH_MAX) } : undefined;
}

export const ruleId = (r: Pick<FolderRule, 'by' | 'match'>) => `${r.by}:${fold(r.match)}`;

/** Přidá pravidlo „tento dodavatel / slovo patří do cesty“; stejné pravidlo se přepíše novou cestou. */
export function learnRule(rules: FolderRule[] | undefined, card: Pick<DocumentCard, 'facts' | 'keywords'>, path: string, at = Date.now()): FolderRule[] | undefined {
  const m = ruleMatch(card);
  if (!m || !path.trim()) return rules;
  const rule: FolderRule = { ...m, path: path.trim(), at };
  return [rule, ...(rules ?? []).filter((r) => ruleId(r) !== ruleId(rule))].slice(0, RULES_MAX);
}

export const removeRule = (rules: FolderRule[] | undefined, id: string) => (rules ?? []).filter((r) => ruleId(r) !== id);

/** Řádky pravidel pro prompt; text pochází z dokumentů, proto jednořádkový a bez uvozovek. */
export function ruleLines(rules: FolderRule[] | undefined): string[] {
  const clean = (s: string) => s.replace(/["\s]+/g, ' ').trim();
  return (rules ?? []).map((r) => `${r.by === 'party' ? 'party' : 'keyword'} "${clean(r.match)}" -> "${clean(r.path)}"`);
}
