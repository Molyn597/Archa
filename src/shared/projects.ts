import { t, type MessageKey } from './i18n';
import type { CitationStyle, Project, ProjectKind } from './types';

export const PROJECT_KINDS: ProjectKind[] = ['seminar', 'bachelor', 'master', 'dissertation', 'work', 'other'];

/** Studijní práce mají seznam literatury, pracovní projekty podklady. */
export const isStudy = (kind: ProjectKind) => kind !== 'work' && kind !== 'other';

export const kindName = (kind: ProjectKind) => t(`project.kind.${kind}` as MessageKey);

/** Nový projekt s osnovou ze šablony druhu (v jazyce rozhraní). */
export function newProject(name: string, kind: ProjectKind, style: CitationStyle, id: string, now = Date.now()): Project {
  return {
    id,
    name: name.trim() || kindName(kind),
    kind,
    assignment: '',
    outline: t(`project.outline.${kind}` as MessageKey),
    notes: '',
    sources: [],
    style,
    createdAt: now,
    updatedAt: now,
  };
}

/** Přidá dokumenty na konec zdrojů, bez opakování; vrací počet nově přidaných. */
export function addSources(project: Project, jobIds: string[]) {
  const before = project.sources.length;
  project.sources = [...new Set([...project.sources, ...jobIds])];
  return project.sources.length - before;
}
