import { getLang, resolveLang, setLang, t, type MessageKey } from '../shared/i18n';
import { languageName, LANGUAGES } from '../shared/languages';
import { CHARS_PER_PAGE } from '../shared/cost';
import { estimateFiles, formatUsd, setCurrency, setCzkRate } from '../shared/estimate';
import { isValidPageRange } from '../shared/pages';
import { activeModels, activeRates, isOnline } from '../shared/provider';
import type { Api, DuplicateMatch, FileInfo, Job, LmStatus, Mode, Models, Provider, Settings } from '../shared/types';
import { openChat, renderFolderOpt, setupLibraryChat, showLibraryChat, syncChatSettings } from './chat';
import { citeSegment, closeDetail, detailJobId, openDetail, setupDetail, updateDetail, type Tab } from './detail';
import { reloadLibrary, renderLibrary, setupLibrary } from './library';
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
  statusIcon,
  STATUS_TEXT,
  toast,
} from './dom';
import { updateCard } from './update';
import { fillHelpDots, renderHelp, scrollToTopic } from './help-view';
import { openWelcome } from './welcome';
import type { HelpTopic } from '../shared/help';
import { renderSettings, setSettingsTab } from './forms';

declare global {
  interface Window {
    api: Api;
  }
}

type View = 'home' | 'history' | 'detail' | 'help' | 'settings';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ROLE_NAMES: Record<keyof Models | 'chat', MessageKey> = { translate: 'role.translate', ocr: 'role.ocr', polish: 'role.polish', chat: 'role.chat' };
// Stránka článku má 8 odstavců; opravu potřebuje zhruba 15 % z nich.
const FIXES_PER_PAGE = 8 * 0.15;
const CONTEXT_SECONDS = 10;

let settings: Settings;
let jobs = new Map<string, Job>();
let view: View = 'home';
let previousView: View = 'home';
// Vybrané soubory čekají na tlačítko Přeložit; info se dotáhne kvůli počtu stran a odhadu ceny.
let pending: { path: string; name: string; info?: FileInfo | null; dups?: DuplicateMatch[] }[] = [];
const TYPICAL_PAGES = 15;
let lastStatus: LmStatus | undefined;
let catalog: LmStatus['models'] = [];

// ---------- Navigace ----------

function show(next: View) {
  if (view !== 'detail') previousView = view;
  view = next;
  document.body.dataset.view = next;
  setTreePopover(false);
  for (const el of document.querySelectorAll<HTMLElement>('.view')) el.hidden = el.dataset.view !== next;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.nav-item[data-nav]')) {
    b.classList.toggle('active', b.dataset.nav === next || (next === 'detail' && b.dataset.nav === 'history'));
  }
  if (next !== 'detail') closeDetail();
  if (next === 'settings') void renderSettings(onSettingsSaved);
  if (next === 'history') {
    reloadLibrary();
    showLibraryChat();
  }
  if (next === 'help') renderHelp(showWelcome);
  document.querySelector('.main')?.scrollTo(0, 0);
  $('detail-scroll').scrollTo(0, 0);
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
  bar.replaceChildren(updateCard(r.latest, () => (bar.hidden = true)));
  bar.hidden = false;
}

async function openJob(id: string, tab?: Tab, withChat = false) {
  if (!(await openDetail(id, tab))) return;
  show('detail');
  if (withChat) openChat();
}

// ---------- LM Studio ----------

async function refreshStatus() {
  const lm = await window.api.lmStatus();
  // Odpověď z doby před přepnutím poskytovatele.
  if ((lm.provider ?? 'local') !== settings.provider) return;
  lastStatus = lm;
  $('status-dot').className = `status-dot ${lm.online ? 'online' : 'offline'}`;
  const remote = lm.provider === 'openrouter';
  $('lm-title').textContent = remote ? t('lm.titleOnline') : 'LM Studio';
  $('lm-state').textContent = remote
    ? lm.online
      ? t('lm.remoteOk')
      : lm.hasKey
        ? t('lm.remoteFail')
        : t('lm.noKey')
    : lm.online
      ? t('lm.running')
      : lm.cli
        ? t('lm.stopped')
        : t('lm.notFound');
  catalog = lm.models;
  const models = activeModels(settings);
  // Řádek stavu dole v panelu: kde se překládá a jakým modelem; podrobnosti v rozbalovacím okně.
  $('status-title').textContent = t(remote ? 'side.online' : 'side.local');
  $('status-model').textContent = modelName(models.translate);
  $('status-row').title = `${$('lm-title').textContent}: ${$('lm-state').textContent}`;
  renderEngine();
  renderCost();
  const chatKey = remote ? settings.chatModels?.remote : settings.chatModels?.local;
  const chatModel = chatKey ?? models.polish;
  const rows: { role: keyof typeof ROLE_NAMES; key: string; missing: boolean; auto?: boolean }[] = [
    { role: 'translate', key: models.translate, missing: lm.missing.includes('translate') },
    { role: 'ocr', key: models.ocr, missing: lm.missing.includes('ocr') },
    { role: 'polish', key: models.polish, missing: lm.missing.includes('polish') },
    { role: 'chat', key: chatModel, auto: !chatKey, missing: chatKey ? lm.models.length > 0 && !lm.models.some((m) => m.key === chatKey) : lm.missing.includes('polish') },
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

function setupPagesToggle() {
  const row = $('pages-row');
  const toggle = $('pages-toggle');
  const input = $<HTMLInputElement>('page-range');
  toggle.addEventListener('click', () => {
    row.hidden = !row.hidden;
    toggle.setAttribute('aria-expanded', String(!row.hidden));
    if (row.hidden) {
      // Skrytý rozsah nesmí potichu platit dál.
      input.value = '';
      input.classList.remove('invalid');
      renderCost();
    } else input.focus();
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
  zone.addEventListener('click', async () => addFiles(await window.api.pickFiles()));
  let depth = 0;
  // Jen soubory z disku; přetahování dokumentů v knihovně nesmí přepnout na úvod.
  const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes('Files'));
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    zone.classList.add('over');
    if (view !== 'home') show('home');
  });
  document.addEventListener('dragleave', () => {
    if (--depth <= 0) zone.classList.remove('over');
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    zone.classList.remove('over');
    const files = [...(e.dataTransfer?.files ?? [])];
    void addFiles(files.map((f) => window.api.pathForFile(f)).filter(Boolean));
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
}

const applyTheme = () => (document.documentElement.dataset.theme = settings.theme);

function onSettingsSaved(next: Settings) {
  settings = next;
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

function setTreePopover(on: boolean) {
  document.body.classList.toggle('tree-pop', on && document.body.classList.contains('nav-collapsed'));
}

function setNavCollapsed(collapsed: boolean) {
  document.body.classList.toggle('nav-collapsed', collapsed);
  if (!collapsed) setTreePopover(false);
  const toggle = $('nav-toggle');
  const label = t(collapsed ? 'nav.expand' : 'nav.collapse');
  toggle.title = label;
  toggle.setAttribute('aria-label', label);
  toggle.classList.toggle('active', !collapsed);
  // V liště jsou jen ikony; popisek ukáže tooltip.
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
  // Plovoucí strom v liště: zavře klik mimo, Escape nebo výběr složky.
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (!document.body.classList.contains('tree-pop')) return;
    if (target.closest('.nav-item[data-nav="history"]')) return;
    if (!target.closest('#library-folders') || target.closest('.folder-main')) setTreePopover(false);
  }, true); // zachytávání: obslužné funkce složek stromu překreslují a ztratily by cestu k #library-folders
  document.addEventListener('keydown', (e) => e.key === 'Escape' && setTreePopover(false));
}

// ---------- Start ----------

async function init() {
  document.body.classList.add(`platform-${window.api.platform}`);
  settings = await window.api.getSettings();
  setCzkRate(settings.usdCzk?.rate);
  setCurrency(settings.currency);
  setLang(resolveLang(settings.uiLang, navigator.language));
  document.documentElement.lang = getLang();
  applyI18n();
  applyTheme();
  jobs = new Map((await window.api.listJobs()).map((j) => [j.id, j]));
  await refreshVault();

  for (const b of document.querySelectorAll<HTMLButtonElement>('.nav-item[data-nav]')) {
    b.addEventListener('click', () => {
      // V liště ikona Knihovny (už otevřené) vysune strom složek jako plovoucí panel.
      if (b.dataset.nav === 'history' && view === 'history' && document.body.classList.contains('nav-collapsed')) {
        return setTreePopover(!document.body.classList.contains('tree-pop'));
      }
      show(b.dataset.nav as View);
    });
  }
  setupNavToggle();
  setupStatus();
  setupPagesToggle();
  setupDetail(() => show(previousView), () => show('settings'));
  setupDrop();
  fillLanguages();
  renderAll();
  renderHome();
  setupLibrary({
    jobs: sorted,
    open: (id, tab, withChat) => void openJob(id, tab, withChat),
    modelName,
    showHome: () => show('home'),
    showLibrary: () => view !== 'history' && show('history'),
    folderChanged: renderFolderOpt,
  });
  setupLibraryChat({
    title: (id) => jobs.get(id)?.name ?? '',
    cite: async (ref) => {
      if (detailJobId() !== ref.jobId) await openJob(ref.jobId);
      if (detailJobId() === ref.jobId) citeSegment(ref.segment);
    },
  });
  fillHelpDots(showHelp);
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
    renderHome();
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
    renderHome();
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
  });
  setupVaultActivity();
  window.api.onOpenJob((id) => void openJob(id));

  if (!settings.onboarded) showWelcome();
  void checkUpdates();
  await refreshStatus();
  setInterval(() => void refreshStatus(), 20000);
  window.addEventListener('focus', () => void refreshStatus());
}

void init();
