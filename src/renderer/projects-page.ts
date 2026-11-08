import { t } from '../shared/i18n';
import { kindName } from '../shared/projects';
import type { Project } from '../shared/types';
import { cleanError, date, h, icon, ICONS, toast } from './dom';

interface ProjectsPageHost {
  open(id: string): void;
  create(): void;
}

let host: ProjectsPageHost;

/** Načte projekty a vykreslí mřížku karet; volá se při zobrazení view Projekty. */
export async function renderProjectsPage() {
  let projects: Project[] = [];
  try {
    projects = await window.api.listProjects();
  } catch (e) {
    toast(cleanError(e), true);
  }
  const grid = document.getElementById('project-grid')!;
  grid.hidden = !projects.length;
  document.getElementById('projects-empty')!.hidden = projects.length > 0;
  grid.replaceChildren(
    ...[...projects]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((p) =>
        h(
          'button',
          { class: 'project-card', type: 'button', onclick: () => host.open(p.id) },
          icon(ICONS.book),
          h('strong', { class: 'project-card-name' }, p.name),
          h('span', { class: 'muted small' }, `${kindName(p.kind)} · ${t('project.sourceCount', { count: p.sources.length })}`),
          h('span', { class: 'muted small' }, t('projects.updated', { date: date(p.updatedAt) })),
        ),
      ),
  );
}

export function setupProjectsPage(projectsHost: ProjectsPageHost) {
  host = projectsHost;
  document.getElementById('projects-new')!.addEventListener('click', () => host.create());
}
