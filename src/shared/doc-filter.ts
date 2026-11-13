import { isLiterature } from './nav';
import type { DocType } from './types';

/** Filtr seznamu dokumentů: vše, články a knihy, chybějící údaje citace, nebo jeden typ karty. */
export type DocFilter = 'all' | 'literature' | 'missing' | `type:${DocType}`;

/** Dokument pro filtr: typ karty (bez karty nic) a zda mu v citaci chybí autor nebo rok. */
export interface FilterDoc {
  type?: DocType;
  gap: boolean;
}

/** Filtr se shoduje s dokumentem? */
export function matchesFilter(filter: DocFilter, doc: FilterDoc): boolean {
  if (filter === 'all') return true;
  if (filter === 'literature') return isLiterature(doc.type);
  if (filter === 'missing') return doc.gap;
  return filter === `type:${doc.type}`;
}

/**
 * Čipy nad seznamem (bez „Vše“) s počty: chybějící údaje, články a knihy (jeden čip za všechny literární typy), ostatní typy zvlášť.
 * Čip, který by ukázal všechno nebo nic, se vynechá; jediný zbylý čip taky nemá smysl, tak se neukáže žádný.
 */
export function filterChips(docs: FilterDoc[]): { filter: DocFilter; count: number }[] {
  const counts = new Map<DocFilter, number>();
  const add = (f: DocFilter) => counts.set(f, (counts.get(f) ?? 0) + 1);
  for (const d of docs) {
    if (d.gap) add('missing');
    if (isLiterature(d.type)) add('literature');
    else if (d.type) add(`type:${d.type}`);
  }
  const order = (f: DocFilter) => (f === 'literature' ? 0 : f === 'missing' ? 2 : 1);
  const chips = [...counts].filter(([f, n]) => f === 'missing' || n < docs.length).map(([filter, count]) => ({ filter, count }));
  if (chips.length < 2 && !chips.some((c) => c.filter === 'missing')) return [];
  return chips.sort((a, b) => order(a.filter) - order(b.filter));
}
