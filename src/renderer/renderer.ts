import { getLang, resolveLang, setLang, t, type MessageKey } from '../shared/i18n';
import { setNameTemplate } from '../shared/doc-title';
import { languageName, LANGUAGES } from '../shared/languages';
import { CHARS_PER_PAGE } from '../shared/cost';
import { estimateFiles, formatUsd, setCurrency, setCzkRate } from '../shared/estimate';
import { isValidPageRange } from '../shared/pages';
import { navFor, type NavId } from '../shared/nav';
import { activeModels, activeRates, isOnline } from '../shared/provider';
import type { Api, DuplicateMatch, FileInfo, Job, LmStatus, Mode, Models, Provider, Settings } from '../shared/types';
import { askLibrary, renderFolderOpt, setupLibraryChat, showLibraryChat, syncChatSettings } from './chat';
import { citeSegment, closeDetail, detailJobId, openDetail, setupDetail, updateDetail, type Tab } from './detail';
import { applySavedSearch, createProject, leaveProject, savedSearches, libraryCards, openFolder, openProject, projectSelected, reloadLibrary, renderLibrary, revealDoc, setupLibrary, libraryView, selectedTitle, showAll, showDeadlines, showInvoices, showMissing, showUnsorted, showWarranty, type LibraryView } from './library';
import { addToLibrary, refreshOverview, renderOverview, setupOverview } from './overview';
import { setupNotifications, updateNotifications } from './notifications';
import { openCompare, setupCompare } from './compare-view';
import { setupPractice } from './practice-view';
import { currentKind, promptLibraryKind, setupLibrarySwitch } from './library-switch';
import { openPalette, type PaletteCommand } from './palette';
import { renderProjectsPage, setupProjectsPage } from './projects-page';
import { refreshVault, setupVaultActivity } from './vault';
import {
  applyI18n,
  date,
  duration,
  chatWarningText,
  cleanError,
  h,
  icon,
  ICONS,
  jobDuration,
  jobTitle,
  langPair,
  MODES,
  progressBar,
  progressInfo,
  rememberOpen,
  statusIcon,
  STATUS_TEXT,
  toast,
  toastAction,
} from './dom';
import { updateRow } from './update';
import { addUploads, renderUpload, setupUpload } from './upload-view';
import { fillHelpDots, renderHelp, scrollToTopic } from './help-view';
import { openLibrarySetup, openWelcome } from './welcome';
import type { HelpTopic } from '../shared/help';
import { renderSettings, setSettingsTab } from './forms';

declare global {
  interface Window {
    api: Api;
  }
}

type View = 'overview' | 'finance' | 'compare' | 'upload' | 'home' | 'history' | 'projects' | 'detail' | 'help' | 'settings';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ROLE_NAMES: Record<keyof Models | 'chat', MessageKey> = { translate: 'role.translate', ocr: 'role.ocr', polish: 'role.polish', chat: 'role.chat' };
// Stránka článku má 8 odstavců; opravu potřebuje zhruba 15 % z nich.
const FIXES_PER_PAGE = 8 * 0.15;
const CONTEXT_SECONDS = 10;

let settings: Settings;
let jobs = new Map<string, Job>();
let view: View = 'overview';
let previousView: View = 'overview';
// Vybrané soubory čekají na tlačítko Přeložit; info se dotáhne kvůli počtu stran a odhadu ceny.
let pending: { path: string; name: string; info?: FileInfo | null; dups?: DuplicateMatch[] }[] = [];
const TYPICAL_PAGES = 15;
let lastStatus: LmStatus | undefined;
let catalog: LmStatus['models'] = [];

// ---------- Navigace ----------

function show(next: View) {
  // Porovnání verzí je podstránka detailu: Zpět z detailu po něm vede tam, odkud se do detailu přišlo.
  if (view !== 'detail' && view !== 'compare') previousView = view;
  view = next;
  document.body.dataset.view = next;
  for (const el of document.querySelectorAll<HTMLElement>('.view')) el.hidden = el.dataset.view !== next;
  syncNav();
  if (next !== 'detail') closeDetail();
  if (next === 'settings') void renderSettings(onSettingsSaved);
  if (next === 'history') {
    reloadLibrary();
    showLibraryChat();
  } else if (next !== 'detail') showLibraryChat(false);
  if (next === 'overview' || next === 'finance') void refreshOverview();
  if (next === 'upload') renderUpload();
  if (next === 'projects') void renderProjectsPage();
  if (next === 'help') renderHelp(showWelcome);
  document.querySelector('.main')?.scrollTo(0, 0);
  $('detail-scroll').scrollTo(0, 0);
}

// Nástroje v paletě ⌘K; další se přidají jedním řádkem (nav = view, který otevřou).
const TOOLS: { nav?: View; run?: () => void; label: MessageKey; icon: string }[] = [
  { nav: 'home', label: 'nav.translate', icon: ICONS.translate },
  { run: () => void pdfToWord(), label: 'nav.pdfToWord', icon: ICONS.file },
];

/** Id jediného souboru z „PDF do Wordu“, na jehož dokončení čeká nabídka uložení. */
let wordJobId: string | undefined;

async function pdfToWord() {
  const paths = await window.api.pickFiles();
  const ids = await addToLibrary(paths, t('tool.pdfToWord.queued'));
  wordJobId = ids.length === 1 ? ids[0] : undefined;
}

function offerWord(job: Job) {
  wordJobId = undefined;
  toastAction(t('tool.pdfToWord.ready', { name: job.name }), t('tool.pdfToWord.save'), () => {
    window.api
      .saveWord(job.id, 'original')
      .then((file) => file && toast(t('detail.word.saved', { path: file })))
      .catch((e) => toast(cleanError(e), true));
  });
}

// Pohledy Dokumentů, které mají vlastní položku v menu (zvýrazní se ta), a nadpis stránky pro ostatní.
const VIEW_NAV: Partial<Record<LibraryView, NavId>> = { invoices: 'invoices', deadlines: 'deadlines' };
const VIEW_TITLE: Partial<Record<LibraryView, MessageKey>> = { duplicates: 'dup.title', aiLog: 'aiLog.title', trash: 'trash.title' };
const LIBRARY_NAV: Partial<Record<NavId, () => void>> = { invoices: () => showInvoices('all'), deadlines: showDeadlines };
// Nadpis stránek mimo Dokumenty a Projekty.
const VIEW_LABEL: Partial<Record<View, MessageKey>> = { overview: 'nav.overview', finance: 'fin.title', compare: 'compare.title', upload: 'nav.upload', home: 'nav.translate', detail: 'nav.history', help: 'help.title', settings: 'nav.settings' };

let projectsLabel: MessageKey = 'nav.projects';

/** Zvýraznění v navigaci a nadpis v horní liště: vybraný projekt svítí jako Projekty, Faktury a Termíny jako vlastní položky, Nahrát na svém pohledu; složky a detail nesvítí v menu nic. */
function syncNav() {
  const sub = view === 'history' ? libraryView() : null;
  const inProject = sub === 'project';
  const target = inProject ? 'projects' : sub && VIEW_NAV[sub] ? VIEW_NAV[sub] : view === 'detail' || view === 'history' ? undefined : view;
  document.body.classList.toggle('in-project', inProject);
  const heading = document.querySelector<HTMLElement>('.view[data-view="history"] .view-head h1');
  const title = sub && VIEW_TITLE[sub];
  const label = inProject ? projectsLabel : (title ?? (sub && VIEW_NAV[sub] ? NAV_LABELS.get(VIEW_NAV[sub]!) : undefined) ?? 'nav.history');
  if (heading) heading.textContent = t(label);
  $('topbar-title').textContent = view === 'history' ? (selectedTitle() ?? t(label)) : t(view === 'projects' ? projectsLabel : (VIEW_LABEL[view] ?? 'nav.history'));
  for (const b of document.querySelectorAll<HTMLButtonElement>('.nav-item[data-nav]')) b.classList.toggle('active', b.dataset.nav === target);
}

const NAV_LABELS = new Map<NavId, MessageKey>();
const MENU_IDS: NavId[] = ['overview', 'upload', 'invoices', 'deadlines', 'projects'];

/** Menu podle typu aktuální knihovny: skryje nepatřící položky a nastaví popisky; nadpis stromu složek (Studium: Předměty). */
async function applyNavKind() {
  const libs = await window.api.libraries().catch(() => null);
  const kind = libs?.list.find((l) => l.id === libs.current)?.kind ?? 'general';
  NAV_LABELS.clear();
  for (const e of navFor(kind)) NAV_LABELS.set(e.id, e.label);
  for (const id of MENU_IDS) {
    const b = document.querySelector<HTMLButtonElement>(`.nav-item[data-nav="${id}"]`)!;
    const label = NAV_LABELS.get(id);
    b.hidden = !label;
    if (label) b.querySelector('span')!.textContent = t(label);
  }
  // Pořadí podle navFor; Projekty si s sebou berou svůj strom.
  const heading = $('folders-heading');
  for (const e of navFor(kind)) {
    heading.before(document.querySelector(`.nav-item[data-nav="${e.id}"]`)!);
    if (e.id === 'projects') heading.before($('project-folders'));
  }
  heading.textContent = t(kind === 'study' ? 'nav.subjects' : 'nav.folders');
  projectsLabel = NAV_LABELS.get('projects') ?? 'nav.projects';
  document.querySelector('.view[data-view="projects"] .view-head h1')!.textContent = t(projectsLabel);
  // Otevřený pohled, který tato knihovna nemá (např. Faktury ve Studiu), se vrací na Dokumenty.
  const sub = view === 'history' ? libraryView() : null;
  if (sub && VIEW_NAV[sub] && !NAV_LABELS.has(VIEW_NAV[sub]!)) showAll();
  setNavTitles();
  syncNav();
}

/** Přepne na nápovědu a případně rovnou na kapitolu. */
export function showHelp(topic?: HelpTopic) {
  show('help');
  if (topic) scrollToTopic(topic);
}

function showWelcome() {
  openWelcome({
    settings: () => settings,
    setProvider,
    save: () => window.api.saveSettings(settings),
    openSettings: () => show('settings'),
  });
}

async function checkUpdates() {
  const r = await window.api.checkUpdate(true).catch(() => null);
  if (!r?.newer || !r.latest) return;
  const bar = $('update-bar');
  bar.replaceChildren(...updateRow(r.latest, () => (bar.hidden = true)));
  bar.hidden = false;
}

async function openJob(id: string, tab?: Tab) {
  if (!(await openDetail(id, tab))) return;
  revealDoc(id);
  void window.api.jobOpened(id).catch(() => undefined);
  show('detail');
}

/** Dokument, ze kterého se otevřelo porovnání verzí (Zpět vede na jeho detail). */
let compareFrom: string | undefined;

async function showCompare(id: string, other: string) {
  if (!(await openCompare(id, other))) return;
  compareFrom = id;
  show('compare');
}

// ---------- LM Studio ----------

function lmState(lm: LmStatus) {
  if (lm.provider === 'openrouter') return lm.online ? t('lm.remoteOk') : lm.hasKey ? t('lm.remoteFail') : t('lm.noKey');
  return lm.online ? t('lm.running') : lm.cli ? t('lm.stopped') : t('lm.notFound');
}

async function refreshStatus() {
  const lm = await window.api.lmStatus();
  // Odpověď z doby před přepnutím poskytovatele.
  if ((lm.provider ?? 'local') !== settings.provider) return;
  lastStatus = lm;
  $('status-dot').className = `status-dot ${lm.online ? 'online' : 'offline'}`;
  const remote = lm.provider === 'openrouter';
  $('lm-title').textContent = remote ? t('lm.titleOnline') : 'LM Studio';
  $('lm-state').textContent = lmState(lm);
  catalog = lm.models;
  const models = activeModels(settings);
  // Řádek stavu dole v panelu: kde se překládá a jakým modelem; podrobnosti v rozbalovacím okně.
  $('status-title').textContent = t(remote ? 'side.online' : 'side.local');
  $('status-model').textContent = modelName(settings.chatModels?.[remote ? 'remote' : 'local'] ?? models.polish);
  $('status-row').title = `${$('lm-title').textContent}: ${$('lm-state').textContent}`;
  renderOverview();
  renderEngine();
  renderCost();
  const chatKey = remote ? settings.chatModels?.remote : settings.chatModels?.local;
  const chatModel = chatKey ?? models.polish;
  const rows: { role: keyof typeof ROLE_NAMES; key: string; missing: boolean; auto?: boolean }[] = [
    { role: 'chat', key: chatModel, auto: !chatKey, missing: chatKey ? lm.models.length > 0 && !lm.models.some((m) => m.key === chatKey) : lm.missing.includes('polish') },
    { role: 'polish', key: models.polish, missing: lm.missing.includes('polish') },
    { role: 'ocr', key: models.ocr, missing: lm.missing.includes('ocr') },
    { role: 'translate', key: models.translate, missing: lm.missing.includes('translate') },
  ];
  $('lm-models').replaceChildren(
    ...rows.map(({ role, key, missing, auto }) => {
      const entry = lm.models.find((m) => m.key === key);
      const name = entry?.name ?? key;
      const warning = role === 'chat' && entry ? chatWarningText(entry) : undefined;
      const label = (missing ? t('lm.missing', { name }) : name) + (auto ? ` ${t('lm.auto')}` : '');
      return h(
        'li',
        {},
        h('span', { class: 'role' }, t(ROLE_NAMES[role])),
        h('span', { class: missing ? 'model missing' : 'model', title: warning ?? name }, warning ? `⚠ ${label}` : label),
      );
    }),
  );
}

const modelName = (id: string) => catalog.find((m) => m.key === id)?.name ?? id.split('/').pop()!;
const prices = () => Object.fromEntries(catalog.map((m) => [m.key, m.price]));

// Online se kvalita nevolí: Nejlepší jen přidá jeden dotaz na kontext dokumentu (cena i čas zanedbatelné).
const jobMode = (): Mode => (isOnline(settings) ? 'quality' : settings.mode);

/** Přepne aktivního poskytovatele (domovská obrazovka i okno stavu v panelu). */
async function setProvider(p: Provider) {
  if (settings.provider === p) return;
  settings.provider = p;
  await window.api.saveSettings(settings);
  lastStatus = undefined;
  syncChatSettings(settings);
  updateNotifications();
  renderAll();
  void refreshStatus();
}

const providerSegments = () =>
  (['local', 'openrouter'] as Provider[]).map((p) =>
    h(
      'button',
      {
        class: settings.provider === p ? 'segment active' : 'segment',
        type: 'button',
        role: 'radio',
        'aria-checked': String(settings.provider === p),
        onclick: () => void setProvider(p),
      },
      t(`home.provider.${p}`),
    ),
  );

/** Kde a čím se bude překládat; hlášky (chybí klíč, LM Studio) jako text u řádku modelu. */
function renderEngine() {
  const online = isOnline(settings);
  for (const id of ['provider-switch', 'lm-switch']) $(id).replaceChildren(...providerSegments());
  $('provider-note').textContent = t(`home.provider.${settings.provider}Desc`);

  const models = activeModels(settings);
  const all = [...new Set(Object.values(models))].map(modelName).join(' + ');
  let note = '';
  let warn = '';
  if (!lastStatus) note = t('lm.checking');
  else if (online) {
    const typical = estimateFiles({ files: [{ kind: 'pdf', pages: TYPICAL_PAGES }], mode: 'quality', models, prices: prices(), factors: settings.remoteCostFactors });
    if (typical.free) note = t('settings.remote.free');
    else if (typical.usd !== undefined) note = t('settings.remote.estimate', { amount: formatUsd(typical.usd), pages: TYPICAL_PAGES });
    if (!lastStatus.hasKey) warn = t('home.keyMissingHint');
  } else {
    note = `LM Studio · ${lastStatus.online ? t('lm.running') : lastStatus.cli ? t('home.lmReady') : t('lm.notFound')}`;
    if (!lastStatus.online && !lastStatus.cli) warn = t('lm.notFound');
  }
  const engine = $('engine');
  engine.title = `${t('home.changeModel')} · ${all}`;
  engine.onclick = () => show('settings');
  engine.replaceChildren(
    h('span', { class: 'model-pick-name' }, modelName(models.translate)),
    h('span', { class: 'model-pick-note' }, note),
    icon(ICONS.chevron),
  );
  $('engine-warn').textContent = warn;
  $('engine-warn').hidden = !warn;
  renderStart();
}

function renderStart() {
  const noKey = isOnline(settings) && lastStatus?.hasKey === false;
  const button = $<HTMLButtonElement>('start');
  button.disabled = !pending.length || noKey;
  button.textContent = pending.length > 1 ? t('home.startMany', { count: pending.length }) : t('home.start');
  $('start-hint').textContent = noKey ? '' : pending.length ? '' : t('home.startHint');
}

function renderAll() {
  renderModes();
  renderEngine();
  renderCost();
}

// ---------- Domů ----------

function secondsPerPage(mode: Mode) {
  const r = activeRates(settings);
  const k = CHARS_PER_PAGE / 1000;
  // Rychlý režim a online čtou digitální stránky z textové vrstvy, OCR jen u skenů (jako pipeline).
  const ocr = mode === 'fast' || isOnline(settings) ? 0 : r.ocrPerPage;
  return k * r.translatePerKChar + ocr + (mode === 'fast' ? 0 : FIXES_PER_PAGE * r.fixPerSegment) + (mode === 'quality' ? CONTEXT_SECONDS : 0);
}

const QUALITY: Record<Mode, MessageKey> = { fast: 'quality.fast', balanced: 'quality.balanced', quality: 'quality.quality' };

function renderModes() {
  $('quality-row').hidden = isOnline(settings);
  $('modes').replaceChildren(
    ...(Object.keys(MODES) as Mode[]).map((mode) =>
      h(
        'button',
        {
          class: settings.mode === mode ? 'segment active' : 'segment',
          type: 'button',
          title: t(MODES[mode].desc),
          role: 'radio',
          'aria-checked': String(settings.mode === mode),
          onclick: async () => {
            settings.mode = mode;
            renderModes();
            renderCost();
            await window.api.saveSettings(settings);
          },
        },
        t(QUALITY[mode]),
      ),
    ),
  );
  $('mode-desc').textContent = t('home.timePerPage', { time: duration(secondsPerPage(settings.mode)) });
}

/** Odhad v patičce karty: bez souborů pro typický článek, jinak pro vybrané soubory (s rozsahem stránek); online i cena. */
function renderCost() {
  const el = $('cost-estimate');
  const mode = jobMode();
  const files = pending.map((p) => p.info).filter((i): i is FileInfo => Boolean(i));
  const pageRange = $<HTMLInputElement>('page-range').value;
  const est = estimateFiles({
    files: files.length ? files : [{ kind: 'pdf', pages: TYPICAL_PAGES }],
    pageRange: files.length && isValidPageRange(pageRange) ? pageRange : '',
    mode,
    models: activeModels(settings),
    prices: prices(),
    factors: settings.remoteCostFactors,
  });
  el.title = isOnline(settings) ? t('home.costActual') : '';
  if (!est.pages) {
    el.textContent = t('home.costDocxOnly');
    return;
  }
  const vars = { time: duration(est.pages * secondsPerPage(mode)), pages: t('cost.pages', { count: est.pages }) };
  const text = !isOnline(settings)
    ? t('home.estLocal', vars)
    : est.free || est.usd === 0
      ? t('home.estFree', vars)
      : est.usd !== undefined
        ? t('home.estOnline', { ...vars, amount: formatUsd(est.usd) })
        : t('home.estLocal', vars);
  el.textContent = est.unknownDocx ? `${text} · ${t('home.costDocx')}` : text;
}

const MORE_KEY = 'moreOptionsOpen';

function setupMoreOptions() {
  const details = $<HTMLDetailsElement>('more-options');
  const input = $<HTMLInputElement>('page-range');
  // Výchozí zavřené; pamatuje se, jestli ho uživatel naposledy nechal otevřené.
  rememberOpen(details, MORE_KEY);
  details.addEventListener('toggle', () => {
    if (details.open) return;
    // Skrytý rozsah nesmí potichu platit dál.
    input.value = '';
    input.classList.remove('invalid');
    renderCost();
  });
}

/** Podrobnosti o stavu LM Studia / OpenRouteru v okénku nad řádkem stavu. */
function setupStatus() {
  const row = $('status-row');
  const pop = $('lm-pop');
  let open = false;
  const setOpen = (value: boolean) => {
    open = value;
    pop.hidden = !open;
    row.setAttribute('aria-expanded', String(open));
  };
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!open);
    if (open) void refreshStatus();
  });
  pop.addEventListener('click', (e) => e.stopPropagation());
  $('lm-change').addEventListener('click', () => {
    setOpen(false);
    setSettingsTab(settings.provider);
    show('settings');
  });
  document.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && setOpen(false));
}

function fillLanguages() {
  const source = $<HTMLSelectElement>('source-lang');
  const target = $<HTMLSelectElement>('target-lang');
  source.replaceChildren(h('option', { value: 'auto' }, t('lang.auto')));
  for (const l of LANGUAGES) {
    source.append(h('option', { value: l.code }, languageName(l.code)));
    target.append(h('option', { value: l.code }, languageName(l.code)));
  }
  source.value = settings.sourceLang;
  target.value = settings.targetLang;
  const keep = $<HTMLInputElement>('keep-figures');
  keep.checked = settings.keepFigures;
  keep.addEventListener('change', async () => {
    settings.keepFigures = keep.checked;
    await window.api.saveSettings(settings);
  });
  const save = async () => {
    settings.sourceLang = source.value;
    settings.targetLang = target.value;
    await window.api.saveSettings(settings);
  };
  source.addEventListener('change', save);
  target.addEventListener('change', save);
}

async function addFiles(paths: string[]) {
  const fresh = [...new Set(paths)].filter((p) => !pending.some((x) => x.path === p));
  if (!fresh.length) return;
  const added: typeof pending = fresh.map((path) => ({ path, name: path.split(/[\\/]/).pop()! }));
  pending.push(...added);
  renderPending();
  const [infos, dups] = await Promise.all([window.api.fileInfo(fresh).catch(() => []), window.api.checkDuplicates(fresh).catch(() => [])]);
  added.forEach((p, i) => {
    p.info = infos[i] ?? null;
    p.dups = dups[i] ?? [];
  });
  renderPending();
}

function fileMeta(info: FileInfo | null | undefined) {
  if (info === undefined) return '…';
  if (!info) return t('home.fileUnreadable');
  if (info.kind === 'pdf') return t('cost.pages', { count: info.pages });
  if (info.kind === 'text') return t('home.fileChars', { chars: info.chars.toLocaleString(getLang()) });
  return 'Word';
}

/** Upozornění, že soubor už v knihovně (nebo v koši) je; překlad to nebrání. */
function dupNotice(p: (typeof pending)[number]) {
  const match = p.dups?.[0];
  if (!match) return null;
  const drop = () => {
    pending = pending.filter((x) => x !== p);
    renderPending();
  };
  const link = (label: string, onclick: () => void) => h('button', { class: 'btn', type: 'button', onclick }, label);
  return h(
    'div',
    { class: 'pending-dup' },
    h('span', { class: `chip ${match.trashed ? 'warn' : 'accent'}`, title: match.name }, t(match.trashed ? 'home.dupTrash' : 'home.dupLibrary')),
    match.trashed
      ? link(t('home.dupRestore'), () =>
          void window.api.restoreJobs([match.id]).then(
            () => {
              drop();
              toast(t('home.dupRestored'));
            },
            (e) => toast(cleanError(e), true),
          ),
        )
      : link(t('home.dupOpen'), () => {
          drop();
          void openJob(match.id);
        }),
    link(t('home.dupAnyway'), () => {
      p.dups = [];
      renderPending();
    }),
  );
}

function renderPending() {
  $('pending').hidden = !pending.length;
  // S vybranými soubory se plocha zmenší na řádek „Přidat další soubory“.
  $('dropzone').classList.toggle('compact', pending.length > 0);
  $('pending-list').replaceChildren(
    ...pending.map((p) =>
      h(
        'div',
        { class: 'pending-row' },
        icon(ICONS.file),
        h('span', { class: 'pending-name', title: p.path }, p.name),
        h('span', { class: 'muted small' }, fileMeta(p.info)),
        h(
          'button',
          {
            class: 'circle-btn small',
            title: t('home.pendingRemove'),
            onclick: () => {
              pending = pending.filter((x) => x !== p);
              renderPending();
            },
          },
          icon(ICONS.x),
        ),
        dupNotice(p),
      ),
    ),
  );
  renderCost();
  renderStart();
}

async function startPending() {
  if (!pending.length) return;
  const pageRange = $<HTMLInputElement>('page-range').value;
  if (!isValidPageRange(pageRange)) {
    toast(t('home.badRange'), true);
    return;
  }
  const paths = pending.map((p) => p.path);
  try {
    await window.api.addJobs(paths, {
      mode: jobMode(),
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      pageRange,
      pickParagraphs: $<HTMLInputElement>('pick-paragraphs').checked,
      keepFigures: $<HTMLInputElement>('keep-figures').checked,
      provider: settings.provider,
    });
    pending = [];
    renderPending();
    toast(paths.length === 1 ? t('home.queued') : t('home.queuedMany', { count: paths.length }));
  } catch (e) {
    toast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
  }
}

function setupDrop() {
  const zone = $('dropzone');
  const zones = [zone, $('upload-drop')];
  zone.addEventListener('click', async () => addFiles(await window.api.pickFiles()));
  let depth = 0;
  // Jen soubory z disku; přetahování dokumentů v knihovně nesmí přepnout na úvod.
  const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes('Files'));
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    for (const z of zones) z.classList.add('over');
    if (view !== 'home' && view !== 'upload') show('upload');
  });
  document.addEventListener('dragleave', () => {
    if (--depth <= 0) for (const z of zones) z.classList.remove('over');
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    for (const z of zones) z.classList.remove('over');
    const files = [...(e.dataTransfer?.files ?? [])];
    const paths = files.map((f) => window.api.pathForFile(f)).filter(Boolean);
    void (view === 'home' ? addFiles(paths) : addUploads(paths));
  });
}

function jobCard(job: Job) {
  const info = progressInfo(job);
  return h(
    'div',
    { class: 'job-card' },
    h(
      'div',
      {},
      h('div', { class: 'job-card-name' }, `${job.name}${job.ext}`),
      h('div', { class: 'job-card-stage' }, [info.label, info.eta, t(MODES[job.mode].title)].filter(Boolean).join(' · ')),
    ),
    h(
      'div',
      { class: 'row gap' },
      h('button', { class: 'btn', onclick: () => openJob(job.id) }, t('job.open')),
      h('button', { class: 'btn danger', onclick: () => window.api.cancelJob(job.id) }, icon(ICONS.stop), t('job.cancel')),
    ),
    progressBar(info.fraction),
  );
}

/** Řádek „Nedávné dokumenty“: tečka stavu, název a stránky s datem. */
function recentRow(job: Job) {
  return h(
    'button',
    { class: 'recent-row', type: 'button', onclick: () => openJob(job.id), title: `${job.name}${job.ext}` },
    h('span', { class: `dot dot-${job.status}`, title: t(STATUS_TEXT[job.status]) }),
    h('span', { class: 'recent-name' }, jobTitle(job)),
    h('span', { class: 'recent-meta' }, [job.pages ? t('cost.pages', { count: job.pages }) : '', date(job.createdAt)].filter(Boolean).join(' · ')),
  );
}

const sorted = () => [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
const isActive = (j: Job) => j.status === 'running' || j.status === 'queued';

function renderHome() {
  const active = sorted()
    .filter(isActive)
    .sort((a, b) => (a.status === 'running' ? -1 : b.status === 'running' ? 1 : a.createdAt - b.createdAt));
  $('active-title').hidden = !active.length;
  $('active-jobs').replaceChildren(...active.map(jobCard));
  const recent = sorted()
    .filter((j) => !isActive(j))
    .slice(0, 3);
  $('recent-title').hidden = !recent.length;
  $('recent-jobs').replaceChildren(...recent.map(recentRow));
  const badge = $('active-badge');
  badge.hidden = !active.length;
  badge.textContent = String(active.length);
  renderOverview();
}

const applyTheme = () => (document.documentElement.dataset.theme = settings.theme);

const applyNameTemplate = () => setNameTemplate(settings.renameByTemplate ? settings.nameTemplate : undefined);

function onSettingsSaved(next: Settings) {
  settings = next;
  applyNameTemplate();
  setCurrency(settings.currency);
  applyTheme();
  syncChatSettings(settings);
  renderAll();
  void refreshStatus();
}

// ---------- Levý panel: plný / lišta ----------

const NAV_KEY = 'navCollapsed';
// Při otevřeném chatu a užším okně se levý panel sám složí na lištu.
const AUTO_RAIL_WIDTH = 1500;

let navUser = false; // volba uživatele (uložená)
let navOverride: boolean | null = null; // ruční přepnutí, platí do změny stavu chatu / okna
let chatOpen = false;
let lastAuto = false;

const autoRail = () => chatOpen && window.innerWidth < AUTO_RAIL_WIDTH;

function setNavCollapsed(collapsed: boolean) {
  document.body.classList.toggle('nav-collapsed', collapsed);
  const toggle = $('nav-toggle');
  const label = t(collapsed ? 'nav.expand' : 'nav.collapse');
  toggle.title = label;
  toggle.setAttribute('aria-label', label);
  toggle.classList.toggle('active', !collapsed);
  setNavTitles();
}

/** V liště jsou jen ikony; popisek ukáže tooltip. */
function setNavTitles() {
  const collapsed = document.body.classList.contains('nav-collapsed');
  for (const b of document.querySelectorAll<HTMLElement>('.nav-item[data-nav]')) b.title = collapsed ? (b.querySelector('span')?.textContent ?? '') : '';
}

function applyNav() {
  const auto = autoRail();
  if (auto !== lastAuto) navOverride = null;
  lastAuto = auto;
  setNavCollapsed(navOverride ?? (navUser || auto));
}

function setupNavToggle() {
  try {
    navUser = localStorage.getItem(NAV_KEY) === '1';
  } catch {}
  applyNav();
  $('nav-toggle').addEventListener('click', () => {
    const next = !document.body.classList.contains('nav-collapsed');
    navOverride = next;
    // Ruční přepnutí při automatickém složení se neukládá.
    if (!autoRail()) {
      navUser = next;
      try {
        localStorage.setItem(NAV_KEY, next ? '1' : '0');
      } catch {}
    }
    setNavCollapsed(next);
  });
  document.addEventListener('chat-open-changed', (e) => {
    chatOpen = (e as CustomEvent<boolean>).detail;
    navOverride = null;
    applyNav();
  });
  window.addEventListener('resize', applyNav);
}

/** Klik na položku menu. Projekty při druhém kliknutí sbalí svůj strom;  */
function onNavClick(nav: View | NavId) {
  const body = document.body;
  if (nav === 'projects' && view === 'projects') return body.classList.toggle('tree-closed');
  body.classList.remove('tree-closed');
  const open = LIBRARY_NAV[nav as NavId];
  (open ?? (() => show(nav as View)))();
}

// ---------- Horní lišta a paleta ----------

const PALETTE_KEY = navigator.platform.startsWith('Mac') ? '⌘K' : 'Ctrl K';

function paletteCommands(): PaletteCommand[] {
  return [
    { label: t('nav.upload'), icon: ICONS.upload, run: () => show('upload') },
    ...(currentKind() === 'work' || currentKind() === 'general' ? [{ label: t('fin.title'), icon: ICONS.invoice, run: () => show('finance') }] : []),
    ...savedSearches().map((s) => ({ label: t('saved.palette', { name: s.name }), icon: ICONS.search, run: () => applySavedSearch(s) })),
    ...TOOLS.map((tool) => ({ label: t(tool.label), icon: tool.icon, run: () => (tool.nav ? show(tool.nav) : tool.run?.()) })),
    { label: t('nav.settings'), icon: ICONS.sliders, run: () => show('settings') },
    { label: t('nav.help'), icon: ICONS.help, run: () => showHelp() },
  ];
}

function setupTopbar() {
  $('topbar-kbd').textContent = PALETTE_KEY;
  const palette = () => openPalette({ jobs: sorted, cards: libraryCards, commands: paletteCommands, open: (id) => void openJob(id) });
  $('topbar-search').addEventListener('click', palette);
  $('topbar-upload').addEventListener('click', () => show('upload'));
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      palette();
    }
  });
}

// ---------- Start ----------

async function init() {
  document.body.classList.add(`platform-${window.api.platform}`);
  settings = await window.api.getSettings();
  applyNameTemplate();
  setCzkRate(settings.usdCzk?.rate);
  setCurrency(settings.currency);
  setLang(resolveLang(settings.uiLang, navigator.language));
  document.documentElement.lang = getLang();
  applyI18n();
  applyTheme();
  jobs = new Map((await window.api.listJobs()).map((j) => [j.id, j]));
  await refreshVault();

  for (const b of document.querySelectorAll<HTMLButtonElement>('.nav-item[data-nav]')) b.addEventListener('click', () => onNavClick(b.dataset.nav as View | NavId));
  setupNavToggle();
  setupTopbar();
  setupStatus();
  setupMoreOptions();
  setupDetail(() => show(previousView), () => show('settings'), { open: (id) => void openJob(id), openProject, openFolder, showFinance: () => show('finance'), openCompare: (id, other) => void showCompare(id, other) });
  setupCompare($('compare-root'), { back: () => (compareFrom ? void openJob(compareFrom) : show(previousView)) });
  setupPractice((id) => void openJob(id));
  setupDrop();
  fillLanguages();
  renderAll();
  setupLibrary({
    jobs: sorted,
    open: (id, tab) => void openJob(id, tab),
    showUpload: () => show('upload'),
    showLibrary: () => view !== 'history' && show('history'),
    folderChanged: renderFolderOpt,
    selectionChanged: syncNav,
    showSettings: () => show('settings'),
  });
  setupUpload({ jobs: sorted, settings: () => settings, show: () => show('upload'), openJob, showAll });
  setupOverview({
    jobs: sorted,
    settings: () => settings,
    jobMode,
    show,
    addFiles: (paths) => void addFiles(paths),
    openProject,
    openJob: (id) => void openJob(id),
    showDeadlines,
    showUnsorted,
    showWarranty,
    showMissing,
    showInvoices,
    ask: (question) => void askLibrary(question),
    ai: () => (lastStatus ? { remote: lastStatus.provider === 'openrouter', online: lastStatus.online, state: lmState(lastStatus) } : undefined),
  });
  setupNotifications({ jobs: sorted, settings: () => settings, openJob: (id) => void openJob(id), openProject, showUnsorted, showAll, showInvoices, showDeadlines });
  setupProjectsPage({ open: openProject, create: () => createProject() });
  void setupLibrarySwitch();
  void applyNavKind();
  document.addEventListener('libraries-changed', () => void applyNavKind());
  renderHome();
  setupLibraryChat({
    title: (id) => jobs.get(id)?.name ?? t('libraryChat.goneTitle'),
    cite: async (ref) => {
      if (detailJobId() !== ref.jobId) await openJob(ref.jobId);
      // Odpověď mohla citovat dokument, který se mezitím přesunul do jiné knihovny.
      if (detailJobId() === ref.jobId) citeSegment(ref.segment);
      else toast(t('libraryChat.gone'), true);
    },
  });
  fillHelpDots(showHelp);
  showLibraryChat(false);
  const pageRange = $<HTMLInputElement>('page-range');
  pageRange.addEventListener('input', () => {
    pageRange.classList.toggle('invalid', !isValidPageRange(pageRange.value));
    renderCost();
  });
  $('start').addEventListener('click', () => void startPending());
  $('pending-clear').addEventListener('click', () => {
    pending = [];
    renderPending();
  });
  // Dnešní kurz ČNB se dotáhne na pozadí; do té doby platí poslední uložený.
  void window.api.usdCzk().catch(() => undefined).then((rate) => {
    setCzkRate(rate);
    renderCost();
  });
  $('lm-refresh').addEventListener('click', () => void refreshStatus());

  window.api.onJobUpdate((job) => {
    const wasActive = jobs.get(job.id) && isActive(jobs.get(job.id)!);
    jobs.set(job.id, job);
    updateNotifications();
    if (job.id === wordJobId) {
      if (job.status === 'done') offerWord(job);
      else if (job.status === 'error' || job.status === 'cancelled') wordJobId = undefined;
    }
    renderHome();
    renderUpload();
    if (view === 'history') renderLibrary();
    if (detailJobId() === job.id) void updateDetail(job);
    // Po doběhnutí se zpřesní odhad času v kartách režimů.
    if (wasActive && !isActive(job)) {
      void window.api.getSettings().then((s) => {
        settings = s;
        renderModes();
      });
    }
  });
  window.api.onJobRemoved((id) => {
    jobs.delete(id);
    updateNotifications();
    renderHome();
    renderUpload();
    if (view === 'history') reloadLibrary();
    if (detailJobId() === id) show(previousView === 'detail' ? 'history' : previousView);
  });
  // Zamčení/odemčení trezoru mění, které úlohy a dokumenty knihovny jsou vidět.
  window.api.onVaultChanged(async () => {
    await refreshVault();
    jobs = new Map((await window.api.listJobs()).map((j) => [j.id, j]));
    // Zamčením zmizel otevřený dokument ze seznamu: rozšifrovaný obsah nesmí zůstat na obrazovce.
    const open = detailJobId();
    if (view === 'detail' && open && !jobs.has(open)) show('history');
    renderHome();
    await reloadLibrary();
    void refreshOverview();
  });
  setupVaultActivity();
  window.api.onOpenJob((id) => void openJob(id));

  if (!settings.onboarded) showWelcome();
  else if (!(await window.api.libraries()).setupDone) openLibrarySetup();
  else if (!sessionStorage.getItem('kind-prompted') && (await promptLibraryKind())) sessionStorage.setItem('kind-prompted', '1');
  void checkUpdates();
  await refreshStatus();
  setInterval(() => void refreshStatus(), 20000);
  window.addEventListener('focus', () => void refreshStatus());
}

void init();
