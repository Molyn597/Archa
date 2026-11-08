import type { Deadline } from '../shared/deadlines';
import { docSubtitle, docTitle } from '../shared/doc-title';
import { locale, t, type MessageKey } from '../shared/i18n';
import { day, invoiceRows, isoDay, type CurrencySum, type InvoiceStatusFilter } from '../shared/invoices';
import { formatMoney } from '../shared/money';
import { dueTone, invoiceStats, latestProjects, newestJobs, relativeDue, toSort } from '../shared/overview';
import { kindName } from '../shared/projects';
import type { DocumentCard, Job, LibraryState, Mode, Project, Settings } from '../shared/types';
import { deadlineRow, dueSoon } from './deadlines-view';
import { cleanError, h, icon, ICONS, progressInfo, STATUS_TEXT, toast } from './dom';
import { libraryTitle } from './library-switch';

type OverviewView = 'overview' | 'history' | 'projects' | 'home' | 'settings';

interface OverviewHost {
  jobs(): Job[];
  settings(): Settings;
  jobMode(): Mode;
  show(view: OverviewView): void;
  /** Soubory s duplicitou projdou dnešním tokem Překladu, který ji ukáže. */
  addFiles(paths: string[]): void;
  openProject(id: string): void;
  openJob(id: string): void;
  showDeadlines(): void;
  showUnsorted(): void;
  /** Soubory, pohled Faktury s filtrem stavu. */
  showInvoices(status: InvoiceStatusFilter): void;
  /** Otevře chat s knihovnou a odešle otázku. */
  ask(question: string): void;
  /** Stav AI pro řádek v Přehledu: kde běží, jestli je dostupná a popis stavu. */
  ai(): { remote: boolean; online: boolean; state: string } | undefined;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
// Nejvýš tolik termínů na kartě Blíží se.
const DUE_LIMIT = 5;
const isActive = (j: Job) => j.status === 'running' || j.status === 'queued';

let host: OverviewHost;
let libraryState: LibraryState = { library: { folders: [], assign: {} }, cards: {} };
let projects: Project[] = [];
let libraryName = '';

/** Přidá soubory z Přehledu: nejdřív kontrola duplicit, pak rovnou do fronty. Vrátí id nově přidaných úloh. */
export async function addToLibrary(paths: string[], message?: string): Promise<string[]> {
  if (!paths.length) return [];
  try {
    const dups = await window.api.checkDuplicates(paths);
    if (dups.some((d) => d.length)) {
      host.show('home');
      host.addFiles(paths);
      return [];
    }
    const s = host.settings();
    const ids = await window.api.addJobs(paths, { mode: host.jobMode(), sourceLang: s.sourceLang, targetLang: s.targetLang, keepFigures: s.keepFigures, provider: s.provider });
    toast(message ?? (paths.length === 1 ? t('home.queued') : t('home.queuedMany', { count: paths.length })));
    return ids;
  } catch (e) {
    toast(cleanError(e), true);
    return [];
  }
}

const sumsText = (sums: CurrencySum[]) => sums.map((s) => formatMoney(s.total, s.currency, locale())).join(' · ');

const stat = (label: string, value: number, lines: string[], onclick: () => void, warn = false) =>
  h(
    'button',
    { class: `ov-stat${warn ? ' warn' : ''}`, type: 'button', onclick },
    h('span', { class: 'ov-stat-label' }, label),
    h('span', { class: 'ov-stat-value' }, String(value)),
    ...lines.filter(Boolean).map((line) => h('span', { class: 'ov-stat-sub' }, line)),
  );

const card = (title: string, ...body: (Node | false)[]) => h('section', { class: 'ov-card' }, h('h2', {}, title), ...body);
const link = (text: string, onclick: () => void) => h('button', { class: 'ov-link', type: 'button', onclick }, text);

/** Řádek: název a podtext vlevo, štítek vpravo. */
const row = (title: string, sub: string, onclick: () => void, chip?: Node | false) =>
  h('button', { class: 'ov-row', type: 'button', onclick, title }, h('span', { class: 'ov-row-title' }, title), sub && h('span', { class: 'ov-row-sub' }, sub), chip);

function docRow(job: Job, card: DocumentCard | undefined) {
  const info = progressInfo(job);
  let sub = docSubtitle(job, card);
  let chip: HTMLElement | false = card ? h('span', { class: 'chip' }, t(`docType.${card.type}` as MessageKey)) : false;
  if (isActive(job)) {
    sub = info.label;
    chip = h('span', { class: 'chip accent' }, job.status === 'running' ? h('span', { class: 'chat-spin' }) : icon(ICONS.clock), t(STATUS_TEXT[job.status]));
  } else if (job.status === 'error') {
    sub = job.error ?? sub;
    chip = h('span', { class: 'chip err' }, t(STATUS_TEXT.error));
  } else if (job.status !== 'done') {
    chip = h('span', { class: 'chip' }, t(STATUS_TEXT[job.status]));
  }
  return row(docTitle(job, card), sub, () => host.openJob(job.id), chip);
}

function projectRow(p: Project) {
  const sub = `${kindName(p.kind)} · ${t('project.sourceCount', { count: p.sources.length })}`;
  return row(p.name, sub, () => host.openProject(p.id), p.deadline ? h('span', { class: 'chip' }, t('overview.projectDue', { date: day(p.deadline) })) : false);
}

/** Nový uživatel: tři kroky k prvnímu dotazu. */
function welcome(aiReady: boolean) {
  const step = (n: number, done: boolean, text: string, hint?: string, action?: Node, focus = false) =>
    h(
      'li',
      { class: `ov-step${done ? ' done' : ''}${focus ? ' focus' : ''}` },
      h('span', { class: 'ov-step-mark', title: done ? t('overview.welcome.done') : '' }, done ? icon(ICONS.check) : String(n)),
      h('span', { class: 'ov-step-text' }, text, hint && h('small', {}, hint)),
      action,
    );
  const pick = async () => addToLibrary(await window.api.pickFiles());
  return h(
    'section',
    { class: 'ov-welcome' },
    h('h2', {}, t('overview.welcome.title')),
    h('p', {}, t('overview.welcome.text')),
    h(
      'ol',
      { class: 'ov-steps' },
      step(1, aiReady, t('overview.welcome.ai'), undefined, aiReady ? undefined : h('button', { class: 'btn', type: 'button', onclick: () => host.show('settings') }, t('overview.welcome.aiButton'))),
      step(2, false, t('overview.welcome.first'), undefined, h('button', { class: 'btn primary', type: 'button', onclick: () => void pick() }, t('home.pick')), true),
      step(3, false, t('overview.welcome.ask'), t('overview.welcome.askHint')),
    ),
  );
}

/** Překreslí Přehled z poslední načtené knihovny a aktuálních úloh. */
export function renderOverview() {
  const jobs = host.jobs();
  const { library, cards } = libraryState;
  const ai = host.ai();
  $('overview-lib').textContent = libraryName;
  $('overview-note').replaceChildren(...(ai ? [...(ai.remote ? [] : [icon(ICONS.lock)]), t(ai.remote ? 'overview.ask.online' : 'overview.ask.local')] : []));
  $('overview-ask').hidden = !jobs.length;

  if (!jobs.length) {
    $('overview-body').replaceChildren(welcome(Boolean(ai?.online)));
    return;
  }

  const today = isoDay();
  const rows = invoiceRows(jobs, cards, library.paid, today);
  const stats = invoiceStats(rows, today);
  const sort = toSort(
    jobs.filter((j) => !isActive(j)).map((j) => j.id),
    library,
  );

  const sortStat = stat(
    t('overview.stat.sort'),
    sort.total,
    [sort.questions.length ? t('overview.aiAsks', { count: sort.questions.length }) : sort.total ? '' : t('overview.allSorted')],
    host.showUnsorted,
  );
  const stats3 = rows.length
    ? [
        stat(t('overview.stat.open'), stats.open.count, [sumsText(stats.open.sums)], () => host.showInvoices('open')),
        stat(
          t('overview.stat.overdue'),
          stats.overdue.count,
          stats.overdue.count ? [sumsText(stats.overdue.sums), t('overview.oldest', { count: stats.overdue.oldestDays })] : [t('overview.noOverdue')],
          () => host.showInvoices('overdue'),
          stats.overdue.count > 0,
        ),
        sortStat,
      ]
    : [stat(t('overview.stat.docs'), jobs.length, [], () => host.show('history')), sortStat];

  const due = dueSoon({ jobs, cards, paid: library.paid, projects });
  const dueRow = (d: Deadline) => deadlineRow(d, { open: host.openJob, openProject: host.openProject }, { dateText: relativeDue(d.date, today), soon: dueTone(d.date, today) === 'soon' });
  const newest = newestJobs(jobs);

  $('overview-body').replaceChildren(
    h('div', { class: 'ov-stats' }, ...stats3),
    h(
      'div',
      { class: 'ov-cols' },
      card(
        t('dl.soon'),
        due.soon.length ? h('div', { class: 'dl-list' }, ...due.soon.slice(0, DUE_LIMIT).map(dueRow)) : h('p', { class: 'muted small' }, t('dl.empty')),
        due.all.length > 0 && link(t('dl.showAll', { count: due.all.length }), host.showDeadlines),
      ),
      card(t('overview.newest'), h('div', { class: 'dl-list' }, ...newest.map((j) => docRow(j, cards[j.id]))), link(t('overview.allFiles'), () => host.show('history'))),
    ),
    ...(projects.length ? [card(t('nav.projects'), h('div', { class: 'dl-list' }, ...latestProjects(projects).map(projectRow)))] : []),
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
  $('overview-add').addEventListener('click', async () => addToLibrary(await window.api.pickFiles()));
  const input = $<HTMLInputElement>('overview-q');
  const ask = (question: string) => {
    question = question.trim();
    if (!question) return;
    input.value = '';
    host.ask(question);
  };
  $('overview-ask').addEventListener('submit', (e) => {
    e.preventDefault();
    ask(input.value);
  });
  for (const b of document.querySelectorAll<HTMLElement>('.ov-sample')) b.addEventListener('click', () => ask(b.textContent ?? ''));
  window.api.onLibraryChanged(() => void refreshOverview());
  document.addEventListener('libraries-changed', () => void refreshOverview());
  void refreshOverview();
}
