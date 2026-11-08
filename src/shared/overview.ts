import type { Library } from './types';

/** Složka, do které AI řadí nerozpoznané dokumenty (v každé šabloně knihovny). */
export const OTHER_FOLDER = 'other';

export interface ToSort {
  /** Bez složky. */
  unsorted: string[];
  /** Ve složce Ostatní. */
  other: string[];
  /** Čekající dotazy AI, kam dokument zařadit. */
  questions: string[];
  /** Počet různých dokumentů (dokument může být ve více skupinách). */
  total: number;
}

/** Dokumenty, které čekají na zařazení; počítají se jen ty, které jsou vidět (`jobIds`). */
export function toSort(jobIds: string[], library: Pick<Library, 'folders' | 'assign' | 'questions'>): ToSort {
  const ids = new Set(jobIds);
  const folderOf = (id: string) => {
    const folder = library.assign[id]?.folder;
    return library.folders.some((f) => f.id === folder) ? folder : undefined;
  };
  const unsorted = jobIds.filter((id) => !folderOf(id));
  const other = jobIds.filter((id) => folderOf(id) === OTHER_FOLDER);
  const questions = [...new Set((library.questions ?? []).map((q) => q.jobId))].filter((id) => ids.has(id));
  return { unsorted, other, questions, total: new Set([...unsorted, ...other, ...questions]).size };
}

/**
 * Naposledy otevřené dokumenty: pořadí z `recent` omezené na viditelné dokumenty (zamčené bez hesla tam nejsou);
 * když nic není, nejnovější přidané.
 */
export function recentJobs<T extends { id: string; createdAt: number }>(recent: string[] | undefined, jobs: T[], limit = 5): T[] {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const opened = [...new Set(recent ?? [])].map((id) => byId.get(id)).filter((j): j is T => Boolean(j));
  return (opened.length ? opened : [...jobs].sort((a, b) => b.createdAt - a.createdAt)).slice(0, limit);
}

/** Nejnověji upravené projekty. */
export const latestProjects = <T extends { updatedAt: number }>(projects: T[], limit = 3) =>
  [...projects].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
