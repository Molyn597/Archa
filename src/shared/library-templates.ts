import { DEFAULT_FOLDER_KEYS, fold, folderName, isLocked, subtree } from './folders';
import type { Library, LibraryFolder, LibraryKind } from './types';

const top = (...ids: string[]): LibraryFolder[] => ids.map((id) => ({ id, createdAt: 0 }));

/** Verze šablon složek; knihovna s nižší (nebo žádnou) se jednou upraví podle šablony svého typu (`alignToTemplate`). */
export const TEMPLATE_VERSION = 1;

/** Klíče složek šablony typu v pořadí, v jakém se ukazují (studium: bez předmětů, ty mají vlastní id). */
export const TEMPLATE_KEYS: Record<Exclude<LibraryKind, 'general'>, readonly string[]> = {
  work: ['contracts', 'invoices', 'hr', 'manuals', 'official', 'internal-docs', 'other'],
  personal: ['invoices', 'contracts', 'insurance', 'official', 'bank', 'health', 'study', 'manuals', 'other'],
  study: ['articles', 'schedule', 'other'],
};

/** Všechny výchozí klíče složek, které kdy nějaká šablona (i starší) použila. */
export const KNOWN_FOLDER_KEYS: ReadonlySet<string> = new Set([
  ...DEFAULT_FOLDER_KEYS,
  ...Object.values(TEMPLATE_KEYS).flat(),
  'subjects',
  'declarations',
  'invoices-rent',
  'invoices-contractors',
  'invoices-employees',
  'invoices-internal',
  'contracts-rent',
  'contracts-contractors',
  'contracts-employees',
  'contracts-partners',
]);

/** Předměty z textu (čárka, středník nebo nový řádek), oříznuté, bez prázdných a duplicit. */
export function parseSubjects(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter((s) => s && !seen.has(fold(s)) && seen.add(fold(s)));
}

/** Šablona složek nové knihovny podle typu; u studia se předměty stanou složkami. Složka `other` je vždy. */
export function templateLibrary(kind: LibraryKind, subjects: string[] = []): Library {
  let folders: LibraryFolder[];
  if (kind === 'work' || kind === 'personal') {
    folders = top(...TEMPLATE_KEYS[kind]);
  } else if (kind === 'study') {
    const names = parseSubjects(subjects.join('\n'));
    folders = [
      ...(names.length ? names.map((name): LibraryFolder => ({ id: crypto.randomUUID(), name, createdAt: 0 })) : top('subjects')),
      ...top('articles', 'schedule', 'other'),
    ];
  } else folders = top(...DEFAULT_FOLDER_KEYS);
  // Pořadí složek ve stromu je pořadí v poli; createdAt jen drží pořadí i pro případné řazení.
  folders.forEach((f, i) => (f.createdAt = i));
  return { folders, assign: {}, ...(kind !== 'general' && { templateVersion: TEMPLATE_VERSION }) };
}

export interface AlignResult {
  library: Library;
  added: string[];
  removed: string[];
}

/** Počet dokumentů přímo v každé složce (včetně těch v koši: ty se nikdy nesmí ztratit z dohledu). */
export function docCountByFolder(library: Library): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of Object.values(library.assign)) out[a.folder] = (out[a.folder] ?? 0) + 1;
  return out;
}

/**
 * Úprava knihovny podle šablony typu: doplní chybějící složky šablony a odstraní složky s výchozím klíčem, které
 * do šablony nepatří a jsou v celém podstromu prázdné (bez dokumentů, vlastních podsložek a zámku).
 * Vlastní složky (jiné id) a vše s dokumenty zůstává. Pořadí: nejdřív složky šablony v jejím pořadí, pak ostatní.
 * `general` se nemění. Vrací novou knihovnu; vstup se neupravuje.
 */
export function alignToTemplate(library: Library, kind: LibraryKind, counts: Record<string, number> = docCountByFolder(library)): AlignResult {
  if (kind === 'general') return { library, added: [], removed: [] };
  const keys = TEMPLATE_KEYS[kind];
  // Studium: prázdná výchozí složka Předměty je dovolená, ale nepřidává se.
  const allowed = new Set<string>(kind === 'study' ? [...keys, 'subjects'] : keys);
  const folders = library.folders.map((f) => ({ ...f }));

  const removable = (f: LibraryFolder) => {
    const tree = subtree(folders, f.id);
    return [...tree].every((id) => {
      const x = folders.find((y) => y.id === id)!;
      return KNOWN_FOLDER_KEYS.has(id) && !x.name && !allowed.has(id) && !x.locked && !counts[id];
    }) && !isLocked(folders, f);
  };
  const drop = new Set<string>();
  for (const f of folders) if (KNOWN_FOLDER_KEYS.has(f.id) && !allowed.has(f.id) && removable(f)) for (const id of subtree(folders, f.id)) drop.add(id);
  const kept = folders.filter((f) => !drop.has(f.id));

  const have = new Set(kept.map((f) => f.id));
  // Nepřidat složku, kterou uživatel už má pod stejným názvem jinde (např. vlastní „Studium / Články“).
  const names = new Set(kept.map((f) => fold(folderName(f))));
  const added = keys.filter((k) => !have.has(k) && !names.has(fold(folderName({ id: k, createdAt: 0 }))));
  const create = (id: string): LibraryFolder => ({ id, createdAt: 0 });
  let ordered: LibraryFolder[];
  if (kind === 'study') ordered = [...kept, ...added.map(create)];
  else {
    // Složky šablony v jejím pořadí, vlastní složky před Ostatní.
    const pick = (k: string) => kept.find((f) => f.id === k) ?? create(k);
    const own = kept.filter((f) => !keys.includes(f.id));
    const present = (k: string) => have.has(k) || added.includes(k);
    ordered = [...keys.filter((k) => k !== 'other' && present(k)).map(pick), ...own, ...(present('other') ? [pick('other')] : [])];
  }
  return { library: { ...library, folders: ordered, templateVersion: TEMPLATE_VERSION }, added, removed: [...drop] };
}

