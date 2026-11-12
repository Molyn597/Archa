import type { SavedSearch } from './types';

export const SAVED_MAX = 20;

/** Přidá hledání na začátek; stejný název se přepíše. Prázdný název nebo dotaz se ignoruje. */
export function addSaved(list: SavedSearch[] | undefined, search: SavedSearch): SavedSearch[] | undefined {
  const name = search.name.trim();
  if (!name || !search.query.trim()) return list;
  return [{ ...search, name }, ...(list ?? []).filter((s) => s.name !== name)].slice(0, SAVED_MAX);
}

export const removeSaved = (list: SavedSearch[] | undefined, name: string) => (list ?? []).filter((s) => s.name !== name);
