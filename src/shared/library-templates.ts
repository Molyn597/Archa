import { DEFAULT_FOLDER_KEYS, fold } from './folders';
import type { Library, LibraryFolder, LibraryKind } from './types';

const top = (...ids: string[]): LibraryFolder[] => ids.map((id) => ({ id, createdAt: 0 }));
const sub = (parent: string, ...ids: string[]): LibraryFolder[] => ids.map((id) => ({ id: `${parent}-${id}`, createdAt: 0, parent }));

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
  if (kind === 'work') {
    folders = [
      ...top('invoices'),
      ...sub('invoices', 'rent', 'contractors', 'employees', 'internal'),
      ...top('contracts'),
      ...sub('contracts', 'rent', 'contractors', 'employees', 'partners'),
      ...top('declarations', 'internal-docs', 'other'),
    ];
  } else if (kind === 'personal') {
    folders = top('invoices', 'contracts', 'insurance', 'official', 'bank', 'health', 'study', 'manuals', 'other');
  } else if (kind === 'study') {
    const names = parseSubjects(subjects.join('\n'));
    folders = [
      ...(names.length ? names.map((name): LibraryFolder => ({ id: crypto.randomUUID(), name, createdAt: 0 })) : top('subjects')),
      ...top('articles', 'schedule', 'other'),
    ];
  } else folders = top(...DEFAULT_FOLDER_KEYS);
  return { folders, assign: {} };
}
