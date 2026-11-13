import type { Deadline } from '../shared/deadlines';
import { docSubtitle, docTitle } from '../shared/doc-title';
import { t, type MessageKey } from '../shared/i18n';
import { day, invoiceRows, isoDay, type CurrencySum, type InvoiceStatusFilter } from '../shared/invoices';
import { sumsText } from '../shared/notifications';
import { citeGapCount, continueRows, dueTone, relativeAgo, relativeDue, toSort, upcoming, waitRows, warrantyRows, warrantyTone, type WaitInput, type WaitRow } from '../shared/overview';
import { flowRows } from '../shared/finance';
import { kindName, visibleProjects } from '../shared/projects';
import type { DocumentCard, Job, LibraryKind, LibraryState, Mode, OwnCompany, PracticeDue, Project, Settings } from '../shared/types';
import { deadlineRow, dueSoon } from './deadlines-view';
import { cleanError, h, icon, ICONS, progressInfo, STATUS_TEXT, toast } from './dom';
import { scrollToLibrarySettings } from './forms';
import { financeMini, renderFinance, type FinanceCtx } from './finance-view';
import { addUploads } from './upload-view';
import { openPractice } from './practice-view';

type OverviewView = 'overview' | 'history' | 'projects' | 'home' | 'settings' | 'finance';

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
  /** Složka Záruky a účtenky. */
  showWarranty(): void;
  /** Dokumenty s filtrem Chybí údaje (citace). */
  showMissing(): void;
  /** Soubory, pohled Faktury s filtrem stavu. */
  showInvoices(status: InvoiceStatusFilter): void;
  /** Otevře chat s knihovnou a odešle otázku. */
  ask(question: string): void;
  /** Stav AI pro řádek v Přehledu: kde běží, jestli je dostupná a popis stavu. */
  ai(): { remote: boolean; online: boolean; state: string } | undefined;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const isActive = (j: Job) => j.status === 'running' || j.status === 'queued';

let host: OverviewHost;
let libraryState: LibraryState = { library: { folders: [], assign: {} }, cards: {} };
let projects: Project[] = [];
// Moje firma z nastavení aktuální knihovny.
let ownCompany: OwnCompany | undefined;
// Typ knihovny pro obsah Přehledu; převzatá data (general) se chovají jako Práce.
type OverviewKind = Exclude<LibraryKind, 'general'>;
let kind: OverviewKind = 'work';
// Kartičky k zopakování dnes (jen ve Studiu).
let due: PracticeDue = { total: 0, scopes: [] };

/** Přidá soubory z Přehledu: bez zprávy je převezme stránka Nahrát; se zprávou (nástroje) kontrola duplicit a rovnou do fronty. Vrátí id nově přidaných úloh. */
export async function addToLibrary(paths: string[], message?: string): Promise<string[]> {
  if (!paths.length) return [];
  if (!message) {
    void addUploads(paths);
    return [];
  }
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
  } else {
    sub = [relativeAgo(job.finishedAt ?? job.createdAt, Date.now(), isoDay()), sub].filter(Boolean).join(' · ');
  }
  return row(docTitle(job, card), sub, () => host.openJob(job.id), chip);
}

/** Projekt: druh, počet zdrojů a nejbližší termín slovy. */
function projectRow(p: Project) {
  const sub = [kindName(p.kind), t('project.sourceCount', { count: p.sources.length })].join(' · ');
  const tone = p.deadline && dueTone(p.deadline, isoDay()) === 'soon' ? ' accent' : '';
  return row(p.name, sub, () => host.openProject(p.id), p.deadline ? h('span', { class: `chip${tone}` }, relativeDue(p.deadline, isoDay())) : false);
}

/** Řádek bloku Čeká na tebe vede na místo, kde se to řeší. */
function waitRow(r: WaitRow, jobs: Job[]) {
  const sums = (tone: string, list: CurrencySum[]) => h('span', { class: `chip ${tone}` }, sumsText(list));
  switch (r.kind) {
    case 'overdue':
      return row(t('ov.w.overdue', { count: r.count }), t('overview.oldest', { count: r.oldestDays }), () => host.showInvoices('overdue'), sums('err', r.sums));
    case 'soon':
      return row(t('ov.w.soon', { count: r.count }), t('ov.attn.nearest', { date: day(r.nearest) }), () => host.showInvoices('open'), sums('warn', r.sums));
    case 'unpaid':
      return row(t('ov.w.unpaid', { count: r.count }), t('ov.attn.nearest', { date: day(r.nearest) }), () => host.showInvoices('open'), sums('warn', r.sums));
    case 'inbox': {
      const job = jobs.find((j) => j.id === r.first);
      return row(t('ov.w.inbox', { count: r.count }), job ? docTitle(job, libraryState.cards[job.id]) : '', host.showUnsorted);
    }
    case 'practice':
      return row(t('practice.dueToday', { count: r.count }), r.title, () => void openPractice(r.scope));
    case 'cite':
      return row(t('ov.w.cite', { count: r.count }), t('ov.w.citeSub'), host.showMissing);
  }
}

/** Záruka: název, konec záruky a při blížícím se konci štítek se zbývajícím časem. */
function warrantyRow(d: Deadline, today: string) {
  const tone = warrantyTone(d.date, today);
  return row(d.title, t('ov.warranty.until', { date: day(d.date) }), () => d.jobId && host.openJob(d.jobId), tone !== 'calm' && h('span', { class: `chip ${tone}` }, relativeDue(d.date, today)));
}

/** Nový uživatel: tři kroky k prvnímu dotazu. */
function welcome(aiReady: boolean) {
  const step = (n: number, done: boolean, text: string, action?: Node, focus = false) =>
    h(
      'li',
      { class: `ov-step${done ? ' done' : ''}${focus ? ' focus' : ''}` },
      h('span', { class: 'ov-step-mark', title: done ? t('overview.welcome.done') : '' }, done ? icon(ICONS.check) : String(n)),
      h('span', { class: 'ov-step-text' }, text),
      action,
    );
  const pick = async () => addToLibrary(await window.api.pickFiles());
  // Práce má text z dřívějška, Studium a Osobní vlastní (bez faktur).
  const first = t((kind === 'work' ? 'overview.welcome.first' : `ov.welcome.first.${kind}`) as MessageKey);
  return h(
    'section',
    { class: 'ov-welcome' },
    h('h2', {}, t('overview.welcome.title')),
    h(
      'ol',
      { class: 'ov-steps' },
      step(1, aiReady, t('overview.welcome.ai'), aiReady ? undefined : h('button', { class: 'btn', type: 'button', onclick: () => host.show('settings') }, t('overview.welcome.aiButton'))),
      step(2, false, first, h('button', { class: 'btn primary', type: 'button', onclick: () => void pick() }, t('home.pick')), true),
      step(3, false, t('overview.welcome.ask')),
    ),
  );
}

const financeCtx = (): FinanceCtx => ({
  jobs: host.jobs(),
  cards: libraryState.cards,
  paid: libraryState.library.paid,
  own: ownCompany,
  open: host.openJob,
  showSettings: () => {
    host.show('settings');
    scrollToLibrarySettings();
  },
  showInvoices: () => host.showInvoices('all'),
  showFinance: () => host.show('finance'),
});

/** Typ knihovny pro oznámení pod zvonkem. */
export const overviewKind = () => kind;

/** Co čeká a co se blíží; společné pro Přehled a oznámení (`library` určuje pořadí řádků Čeká na tebe). */
export function overviewSignals(jobs: Job[]) {
  const { library, cards } = libraryState;
  const today = isoDay();
  const visible = jobs.filter((j) => !isActive(j));
  const sort = toSort(
    visible.map((j) => j.id),
    library,
  );
  const rows = flowRows(invoiceRows(jobs, cards, library.paid, today), ownCompany);
  // K úhradě jsou přijaté faktury (výdaje); vydané čekají na platbu od odběratele.
  const unpaid = rows.filter((r) => r.flow === 'expense' && (r.status === 'open' || r.status === 'overdue'));
  const input: Omit<WaitInput, 'library'> = { unpaid, inbox: [...new Set([...sort.unsorted, ...sort.questions])], practice: due, citeGaps: kind === 'study' ? citeGapCount(visible, cards) : 0 };
  return {
    today,
    cards,
    wait: (library: WaitInput['library']) => waitRows({ ...input, library }, today),
    deadlines: dueSoon({ jobs, cards, paid: library.paid, projects }).all,
  };
}

/** Překreslí Přehled z poslední načtené knihovny a aktuálních úloh. */
export function renderOverview() {
  const jobs = host.jobs();
  const { cards } = libraryState;
  const ai = host.ai();
  $('overview-note').replaceChildren(...(ai ? [...(ai.remote ? [] : [icon(ICONS.lock)]), t(ai.remote ? 'overview.ask.online' : 'overview.ask.local')] : []));
  $('overview-ask').hidden = !jobs.length;
  fillSamples();

  renderHello(jobs.length > 0);

  if (!jobs.length) {
    $('overview-body').replaceChildren(welcome(Boolean(ai?.online)));
    return;
  }

  const signals = overviewSignals(jobs);
  const { today } = signals;
  const waiting = signals.wait(kind);
  const next = upcoming(signals.deadlines, today);
  const dueRow = (d: Deadline) => deadlineRow(d, { open: host.openJob, openProject: host.openProject }, { dateText: relativeDue(d.date, today), soon: dueTone(d.date, today) === 'soon' });
  const cont = continueRows(kind, projects, jobs);
  const contRows = [...cont.projects.map(projectRow), ...cont.jobs.map((j) => docRow(j, cards[j.id]))];
  const guarantees = kind === 'personal' ? warrantyRows(signals.deadlines, today) : [];
  const fin = kind === 'work' ? financeMini(financeCtx()) : null;

  const left = [
    waiting.length > 0 && card(t('ov.waiting'), h('div', { class: 'dl-list' }, ...waiting.map((r) => waitRow(r, jobs)))),
    next.length > 0 && card(t('dl.soon'), h('div', { class: 'dl-list' }, ...next.map(dueRow)), link(t('ov.all'), host.showDeadlines)),
    guarantees.length > 0 && card(t('ov.warranty'), h('div', { class: 'dl-list' }, ...guarantees.map((d) => warrantyRow(d, today))), link(t('ov.warranty.folder'), host.showWarranty)),
  ].filter(Boolean);
  const right = [
    contRows.length > 0 && card(t('ov.continue'), h('div', { class: 'dl-list' }, ...contRows), link(t('ov.all'), () => host.show(cont.projects.length ? 'projects' : 'history'))),
    fin,
  ].filter(Boolean);
  const stack = (children: unknown[]) => h('div', { class: 'ov-stack' }, ...(children as Node[]));
  $('overview-body').replaceChildren(h('div', { class: `ov-cols${left.length && right.length ? '' : ' one'}` }, ...[left, right].filter((c) => c.length).map(stack)));
}

/** Pozdrav jedním řádkem podle denní doby. */
function renderHello(hasDocs: boolean) {
  const hour = new Date().getHours();
  const hello = $('overview-hello');
  hello.hidden = !hasDocs;
  hello.replaceChildren(h('strong', {}, t(hour < 12 ? 'ov.hello.morning' : hour < 18 ? 'ov.hello.afternoon' : 'ov.hello.evening')));
}

const SAMPLES: Record<OverviewKind, MessageKey[]> = {
  work: ['overview.sample.1', 'overview.sample.2'],
  study: ['ov.sample.study.1', 'ov.sample.study.2'],
  personal: ['ov.sample.personal.1', 'ov.sample.personal.2'],
};

/** Ukázkové otázky podle typu knihovny. */
function fillSamples() {
  $('overview-samples').replaceChildren(...SAMPLES[kind].map((key) => h('button', { class: 'ov-sample', type: 'button', onclick: () => host.ask(t(key)) }, t(key))));
}

/** Znovu načte knihovnu, projekty a typ knihovny a překreslí. */
export async function refreshOverview() {
  try {
    let libs;
    let own;
    [libraryState, projects, libs, own] = await Promise.all([window.api.libraryState(), window.api.listProjects(), window.api.libraries(), window.api.getSettings()]);
    ownCompany = own.ownCompany;
    const cur = libs.list.find((l) => l.id === libs.current);
    kind = !cur || cur.kind === 'general' ? 'work' : cur.kind;
    projects = visibleProjects(projects, kind);
    due = kind === 'study' ? await window.api.practiceDue() : { total: 0, scopes: [] };
  } catch (e) {
    toast(cleanError(e), true);
  }
  renderOverview();
  document.dispatchEvent(new Event('overview-refreshed'));
  if (document.body.dataset.view === 'finance') renderFinance($('finance-root'), financeCtx());
}

export function setupOverview(overviewHost: OverviewHost) {
  host = overviewHost;
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
  window.api.onLibraryChanged(() => void refreshOverview());
  document.addEventListener('libraries-changed', () => void refreshOverview());
  document.addEventListener('practice-changed', () => void refreshOverview());
  void refreshOverview();
}
