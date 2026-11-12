import type { Deadline } from '../shared/deadlines';
import { docSubtitle, docTitle } from '../shared/doc-title';
import { locale, t, type MessageKey } from '../shared/i18n';
import { day, invoiceRows, invoiceSums, isoDay, type CurrencySum, type InvoiceStatusFilter } from '../shared/invoices';
import { formatMoney } from '../shared/money';
import { daysBetween, dueTone, invoiceStats, latestProjects, newestJobs, relativeDue, toSort } from '../shared/overview';
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
// Karta Blíží se ukazuje termíny do tolika dní.
const DUE_DAYS = 45;
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

const sumsText = (sums: CurrencySum[]) => sums.map((s) => formatMoney(s.total, s.currency, locale(), true)).join(' · ');

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
  // Práce má texty z dřívějška, Studium a Osobní vlastní (bez faktur).
  const text = (name: 'text' | 'first' | 'askHint') => t((kind === 'work' ? `overview.welcome.${name}` : `ov.welcome.${name}.${kind}`) as MessageKey);
  return h(
    'section',
    { class: 'ov-welcome' },
    h('h2', {}, t('overview.welcome.title')),
    h('p', {}, text('text')),
    h(
      'ol',
      { class: 'ov-steps' },
      step(1, aiReady, t('overview.welcome.ai'), undefined, aiReady ? undefined : h('button', { class: 'btn', type: 'button', onclick: () => host.show('settings') }, t('overview.welcome.aiButton'))),
      step(2, false, text('first'), undefined, h('button', { class: 'btn primary', type: 'button', onclick: () => void pick() }, t('home.pick')), true),
      step(3, false, t('overview.welcome.ask'), text('askHint')),
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

/** Překreslí Přehled z poslední načtené knihovny a aktuálních úloh. */
export function renderOverview() {
  const jobs = host.jobs();
  const { library, cards } = libraryState;
  const ai = host.ai();
  $('overview-note').replaceChildren(...(ai ? [...(ai.remote ? [] : [icon(ICONS.lock)]), t(ai.remote ? 'overview.ask.online' : 'overview.ask.local')] : []));
  $('overview-ask').hidden = !jobs.length;
  fillSamples();

  const today = isoDay();
  const visible = jobs.filter((j) => !isActive(j));
  const sort = toSort(
    visible.map((j) => j.id),
    library,
  );
  // Odkladiště = nezařazené dokumenty a dokumenty s otevřeným dotazem AI.
  const inbox = new Set([...sort.unsorted, ...sort.questions]).size;
  renderHello(jobs.length > 0, inbox);

  if (!jobs.length) {
    $('overview-body').replaceChildren(welcome(Boolean(ai?.online)));
    return;
  }

  const rows = flowRows(invoiceRows(jobs, cards, library.paid, today), ownCompany);
  // K úhradě jsou přijaté faktury (výdaje); vydané čekají na platbu od odběratele.
  const unpaid = rows.filter((r) => r.flow === 'expense' && (r.status === 'open' || r.status === 'overdue'));
  const overdue = unpaid.filter((r) => r.status === 'overdue');
  const soon = unpaid.filter((r) => r.status === 'open' && daysBetween(today, r.due) <= 7);

  const due = dueSoon({ jobs, cards, paid: library.paid, projects });
  const upcoming = due.all.filter((d) => !d.overdue && daysBetween(today, d.date) <= DUE_DAYS);
  const dueRow = (d: Deadline) => deadlineRow(d, { open: host.openJob, openProject: host.openProject }, { dateText: relativeDue(d.date, today), soon: dueTone(d.date, today) === 'soon' });
  const dueCard = card(
    t('dl.soon'),
    h('div', { class: 'dl-list' }, ...upcoming.slice(0, DUE_LIMIT).map(dueRow)),
    link(t('dl.showAll', { count: due.all.length }), host.showDeadlines),
  );
  const newest = (title: string) => card(title, h('div', { class: 'dl-list' }, ...newestJobs(jobs).map((j) => docRow(j, cards[j.id]))), link(t('overview.allFiles'), () => host.show('history')));
  const inboxCard = inbox > 0 && attn('acc', ICONS.file, t('ov.attn.review'), String(inbox), t('ov.attn.inInbox', { count: inbox }), t('ov.attn.openInbox'), host.showUnsorted);
  const cols = (...children: (Node | false)[]) => h('div', { class: `ov-cols${children.filter(Boolean).length < 2 ? ' one' : ''}` }, ...children);
  const body: (Node | false)[] = [];

  if (kind === 'work') {
    const cards3 = [
      overdue.length > 0 &&
        attn('danger', ICONS.alert, t('ov.attn.overdue'), sumsText(invoiceSums(overdue)), `${t('ov.attn.invoices', { count: overdue.length })} · ${t('overview.oldest', { count: invoiceStats(rows, today).overdue.oldestDays })}`, t('ov.attn.show'), () => host.showInvoices('overdue')),
      soon.length > 0 && attn('warn', ICONS.clock, t('ov.attn.soon'), sumsText(invoiceSums(soon)), `${t('ov.attn.invoices', { count: soon.length })} · ${t('ov.attn.nearest', { date: day(soon.map((r) => r.due).sort()[0]!) })}`, t('ov.attn.show'), () => host.showInvoices('open')),
      inboxCard,
    ].filter((c): c is HTMLDivElement => Boolean(c));
    const fin = financeMini(financeCtx());
    body.push(
      cards3.length ? h('div', { class: 'ov-attn-grid' }, ...cards3) : h('div', { class: 'ov-calm' }, icon(ICONS.check), h('div', {}, h('b', {}, t('ov.attn.ok')), ' ', h('span', { class: 'muted' }, t('ov.attn.okWork')))),
      cols(upcoming.length > 0 && dueCard, (fin || projects.length > 0) && h('div', { class: 'ov-stack' }, fin, projects.length > 0 && card(t('nav.jobs'), h('div', { class: 'dl-list' }, ...latestProjects(projects).map(projectRow)), link(t('ov.all'), () => host.show('projects')))) ),
    );
  } else if (kind === 'study') {
    const works = [...projects].sort((a, b) => (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999'));
    body.push(
      inboxCard && h('div', { class: 'ov-attn-grid' }, inboxCard),
      practiceCallout(),
      h('h2', { class: 'ov-sect' }, t('ov.study.title')),
      works.length ? h('div', { class: 'ov-work-grid' }, ...works.map(workCard)) : card(t('ov.study.title'), h('p', { class: 'muted small' }, t('ov.study.none')), link(t('nav.myWork'), () => host.show('projects'))),
      cols(upcoming.length > 0 && dueCard, newest(t('ov.newestSources'))),
    );
  } else {
    const ending = upcoming.filter((d) => d.kind !== 'invoiceDue');
    const personal = [
      unpaid.length > 0 &&
        attn('warn', ICONS.invoice, t('ov.attn.unpaid'), sumsText(invoiceSums(unpaid)), `${t('ov.attn.invoices', { count: unpaid.length })} · ${t('ov.attn.nearest', { date: day(unpaid.map((r) => r.due).filter(Boolean).sort()[0] ?? '') })}`, t('ov.attn.show'), () => host.showInvoices('open')),
      ending.length > 0 && attn('danger', ICONS.clock, t('ov.attn.ending'), String(ending.length), `${ending[0]!.title} · ${relativeDue(ending[0]!.date, today)}`, t('dl.title'), host.showDeadlines),
      inboxCard,
    ].filter((c): c is HTMLDivElement => Boolean(c));
    body.push(
      personal.length ? h('div', { class: 'ov-attn-grid' }, ...personal) : h('div', { class: 'ov-calm' }, icon(ICONS.check), h('div', {}, h('b', {}, t('ov.attn.ok')), ' ', h('span', { class: 'muted' }, t('ov.attn.okOther')))),
      cols(upcoming.length > 0 && dueCard, newest(t('overview.newest'))),
    );
  }
  $('overview-body').replaceChildren(...body.filter((b): b is Node => Boolean(b)));
}

/** Pozdrav jedním řádkem: denní doba a šedá věta o Odkladišti, jinak nabídka otázky. */
function renderHello(hasDocs: boolean, inbox: number) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'ov.hello.morning' : hour < 18 ? 'ov.hello.afternoon' : 'ov.hello.evening';
  const hello = $('overview-hello');
  hello.hidden = !hasDocs;
  hello.replaceChildren(h('strong', {}, t(greeting)), ' ', h('span', { class: 'muted' }, inbox ? t('ov.hello.pending', { count: inbox }) : t('ov.hello.ask')));
}

const SAMPLES: Record<OverviewKind, MessageKey[]> = {
  work: ['overview.sample.1', 'overview.sample.2', 'overview.sample.3'],
  study: ['ov.sample.study.1', 'ov.sample.study.2'],
  personal: ['ov.sample.personal.1', 'ov.sample.personal.2'],
};

/** Ukázkové otázky podle typu knihovny. */
function fillSamples() {
  $('overview-samples').replaceChildren(...SAMPLES[kind].map((key) => h('button', { class: 'ov-sample', type: 'button', onclick: () => host.ask(t(key)) }, t(key))));
}

/** Karta pozornosti: štítek, velké číslo nebo částka, podtext a tlačítko. */
function attn(tone: 'danger' | 'warn' | 'acc', iconPath: string, label: string, big: string, meta: string, action: string, onclick: () => void) {
  return h(
    'div',
    { class: `ov-attn ${tone}` },
    h('div', { class: 'ov-attn-lab' }, icon(iconPath), label),
    h('div', { class: 'ov-attn-big' }, big),
    h('div', { class: 'ov-attn-meta' }, meta),
    h('button', { class: 'btn', type: 'button', onclick }, action),
  );
}

/** K zopakování dnes: počet kartiček a Opakovat otevře rozsah, kde jich je nejvíc; bez kartiček nic. */
function practiceCallout() {
  const top = due.scopes[0];
  if (!due.total || !top) return false;
  return h(
    'div',
    { class: 'ov-practice' },
    icon(ICONS.sparkle),
    h('div', {}, h('b', {}, t('practice.dueToday', { count: due.total })), ' · ', t('practice.dueNote', { name: top.title })),
    h('button', { class: 'btn sm', type: 'button', onclick: () => void openPractice(top.scope) }, t('practice.repeat')),
  );
}

/** Rozpracovaná práce: druh, název, termín, počet kapitol osnovy a zdrojů. */
function workCard(p: Project) {
  const chapters = p.outline.split('\n').filter((l) => l.trim() && !/^\s/.test(l)).length;
  const meta = [chapters ? t('ov.study.chapters', { count: chapters }) : '', t('project.sourceCount', { count: p.sources.length })].filter(Boolean).join(' · ');
  return h(
    'div',
    { class: 'ov-work' },
    h('div', { class: 'ov-work-top' }, h('span', { class: 'chip' }, kindName(p.kind)), p.deadline && h('span', { class: `chip${dueTone(p.deadline, isoDay()) === 'soon' ? ' accent' : ''}` }, `${t('overview.projectDue', { date: day(p.deadline) })} · ${relativeDue(p.deadline, isoDay())}`)),
    h('strong', {}, p.name),
    h('span', { class: 'muted small' }, meta),
    h('button', { class: 'btn', type: 'button', onclick: () => host.openProject(p.id) }, t('ov.study.continue')),
  );
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
