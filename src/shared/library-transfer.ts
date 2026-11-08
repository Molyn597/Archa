import { fold, folderName, isLocked, resolvePath } from './folders';
import type { Library, Project } from './types';

/** Složka cílové knihovny pro přesunutý dokument: podle návrhu karty (cesta nebo název složky), jinak Ostatní, jinak nezařazený. Zamčené složky se nepoužijí. */
export function targetFolder(target: Library, suggestion?: string): string | undefined {
  const open = target.folders.filter((f) => !isLocked(target.folders, f));
  const wanted = suggestion?.trim();
  if (wanted) {
    const byPath = resolvePath(open, wanted);
    if (byPath) return byPath;
    const leaf = fold(wanted.split(/\s*[/>]\s*/).filter(Boolean).at(-1) ?? '');
    const byName = leaf && open.find((f) => fold(folderName(f)) === leaf);
    if (byName) return byName.id;
  }
  return open.find((f) => f.id === 'other')?.id;
}

/** Zařadí dokumenty v cílové knihovně (`suggestions`: id → návrh složky z karty) a přenese zaplacení (`paid` ze zdroje). Vrací id složky nebo undefined. */
export function placeEntries(target: Library, ids: string[], suggestions: Record<string, string | undefined> = {}, paid: Library['paid'] = {}) {
  const placed: Record<string, string | undefined> = {};
  for (const id of ids) {
    const folder = targetFolder(target, suggestions[id]);
    placed[id] = folder;
    if (folder) target.assign[id] = { folder };
    else delete target.assign[id];
    if (paid?.[id] !== undefined) (target.paid ??= {})[id] = paid[id];
  }
  return placed;
}

/** Odebere záznamy o dokumentech ze zdrojové knihovny: zařazení, zaplacení, dotazy AI, deník AI a naposledy otevřené. */
export function releaseEntries(source: Library, ids: string[]) {
  const gone = new Set(ids);
  for (const id of ids) {
    delete source.assign[id];
    if (source.paid) delete source.paid[id];
  }
  if (source.paid && !Object.keys(source.paid).length) delete source.paid;
  if (source.questions) source.questions = source.questions.filter((q) => !gone.has(q.jobId));
  if (source.aiLog) source.aiLog = source.aiLog.filter((p) => !gone.has(p.jobId));
  if (source.recent) source.recent = source.recent.filter((id) => !gone.has(id));
  for (const key of ['questions', 'aiLog', 'recent'] as const) if (!source[key]?.length) delete source[key];
}

/** Obojí najednou (obě knihovny se upraví). */
export function transferEntries(source: Library, target: Library, ids: string[], suggestions: Record<string, string | undefined> = {}) {
  const placed = placeEntries(target, ids, suggestions, source.paid);
  releaseEntries(source, ids);
  return placed;
}

/** Odebere dokumenty ze zdrojů projektu (ať nezůstane odkaz na přesunutý dokument); vrací, zda se něco změnilo. */
export function dropSources(project: Project, ids: string[]): boolean {
  const gone = new Set(ids);
  const kept = project.sources.filter((id) => !gone.has(id));
  if (kept.length === project.sources.length) return false;
  project.sources = kept;
  return true;
}
