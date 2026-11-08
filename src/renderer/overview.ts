import { t } from '../shared/i18n';
import { latestProjects, recentJobs, toSort } from '../shared/overview';
import { kindName } from '../shared/projects';
import type { Job, LibraryState, Mode, Project, Settings } from '../shared/types';
import { cleanError, h, icon, ICONS, toast } from './dom';
import { libraryTitle } from './library-switch';

type OverviewView = 'overview' | 'history' | 'projects' | 'home' | 'settings';

interface OverviewHost {
  jobs(): Job[];
  settings(): Settings;
  jobMode(): Mode;
  show(view: OverviewView): void;
  /** Soubory s duplicitou projdou dnešním tokem Překladu, který ji ukáže. */
  addFiles(paths: string[]): void;
  jobCard(job: Job): HTMLElement;
  recentRow(job: Job): HTMLElement;
  openProject(id: string): void;
  newProject(): void;
  showUnsorted(): void;
  /** Stav AI pro řádek v Přehledu: kde běží, jestli je dostupná a popis stavu. */
  ai(): { remote: boolean; online: boolean; state: string } | undefined;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const isActive = (j: Job) => j.status === 'running' || j.status === 'queued';

let host: OverviewHost;
let libraryState: LibraryState = { library: { folders: [], assign: {} }, cards: {} };
let projects: Project[] = [];
let libraryName = '';

/** Přidá soubory z Přehledu: nejdřív kontrola duplicit, pak rovnou do fronty. */
export async function addToLibrary(paths: string[]) {
  if (!paths.length) return;
  try {
    const dups = await window.api.checkDuplicates(paths);
    if (dups.some((d) => d.length)) {
      host.show('home');
      host.addFiles(paths);
      return;
    }
    const s = host.settings();
    await window.api.addJobs(paths, { mode: host.jobMode(), sourceLang: s.sourceLang, targetLang: s.targetLang, keepFigures: s.keepFigures, provider: s.provider });
    toast(paths.length === 1 ? t('home.queued') : t('home.queuedMany', { count: paths.length }));
  } catch (e) {
    toast(cleanError(e), true);
  }
}

const tile = (path: string, label: string, text: string, to: OverviewView) =>
  h('button', { class: 'ov-tile', type: 'button', onclick: () => host.show(to) }, icon(path), h('strong', {}, label), h('span', { class: 'muted small' }, text));

const card = (title: string, ...body: (Node | string | false)[]) => h('section', { class: 'ov-card' }, h('h2', {}, title), ...body);

const row = (name: string, meta: string, onclick: () => void) =>
  h('button', { class: 'recent-row', type: 'button', onclick, title: name }, h('span', { class: 'recent-name' }, name), h('span', { class: 'recent-meta' }, meta));

/** Překreslí Přehled z poslední načtené knihovny a aktuálních úloh. */
export function renderOverview() {
  const jobs = host.jobs();
  const active = jobs.filter(isActive).sort((a, b) => (a.status === 'running' ? -1 : b.status === 'running' ? 1 : a.createdAt - b.createdAt));
  $('overview-lib').textContent = libraryName;
  $('overview-active-title').hidden = !active.length;
  $('overview-active').replaceChildren(...active.map(host.jobCard));

  const { library } = libraryState;
  const idle = jobs.filter((j) => !isActive(j));
  const recent = recentJobs(library.recent, idle);
  const sort = toSort(
    idle.map((j) => j.id),
    library,
  );
  const ai = host.ai();

  $('overview-grid').replaceChildren(
    h(
      'div',
      { class: 'ov-tiles' },
      tile(ICONS.folder, t('nav.history'), t('overview.docs', { count: jobs.length }), 'history'),
      tile(ICONS.book, t('nav.projects'), t('overview.projects', { count: projects.length }), 'projects'),
      tile(ICONS.globe, t('nav.translate'), t('overview.translateText'), 'home'),
    ),
    card(t('overview.recent'), ...(recent.length ? recent.map(host.recentRow) : [h('p', { class: 'muted small' }, t('overview.recentEmpty'))])),
    card(
      t('overview.projectsActive'),
      ...(projects.length
        ? latestProjects(projects).map((p) => row(p.name, `${kindName(p.kind)} · ${t('project.sourceCount', { count: p.sources.length })}`, () => host.openProject(p.id)))
        : [h('p', { class: 'muted small' }, t('overview.projectsEmpty')), h('button', { class: 'btn', type: 'button', onclick: host.newProject }, icon(ICONS.plus), t('project.new'))]),
    ),
    card(
      t('overview.toSort'),
      sort.total
        ? h('div', { class: 'ov-line' }, h('span', {}, t('overview.toSortCount', { count: sort.total })), h('button', { class: 'btn', type: 'button', onclick: host.showUnsorted }, t('overview.toSortOpen')))
        : h('p', { class: 'muted small' }, t('overview.allSorted')),
    ),
    card(
      t('overview.ai'),
      h(
        'div',
        { class: 'ov-line' },
        h('span', { class: 'ov-ai' }, h('span', { class: `status-dot ${ai ? (ai.online ? 'online' : 'offline') : ''}` }), h('span', {}, ai ? `${t(ai.remote ? 'side.online' : 'side.local')} · ${ai.state}` : t('lm.checking'))),
        h('button', { class: 'btn', type: 'button', onclick: () => host.show('settings') }, t('overview.aiSettings')),
      ),
    ),
  );
}

/** Znovu načte knihovnu, projekty a název knihovny a překreslí. */
export async function refreshOverview() {
  try {
    let libs;
    [libraryState, projects, libs] = await Promise.all([window.api.libraryState(), window.api.listProjects(), window.api.libraries()]);
    const cur = libs.list.find((l) => l.id === libs.current);
    libraryName = cur ? libraryTitle(cur) : '';
  } catch (e) {
    toast(cleanError(e), true);
  }
  renderOverview();
}

export function setupOverview(overviewHost: OverviewHost) {
  host = overviewHost;
  $('overview-drop').addEventListener('click', async () => addToLibrary(await window.api.pickFiles()));
  window.api.onLibraryChanged(() => void refreshOverview());
  document.addEventListener('libraries-changed', () => void refreshOverview());
  void refreshOverview();
}
