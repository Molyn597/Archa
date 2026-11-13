import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import { aresTarget, compareAres } from '../shared/ares';
import { versionDate } from '../shared/contract-diff';
import { defaultTab, isInfoTab, isTranslated, topTab, topTabs, translationViews, usableView, type Tab, type TopTab, type View } from '../shared/detail-tabs';
import { docTitle } from '../shared/doc-title';
import { findQuoteSegment } from '../shared/risks';
import { day, isoDay } from '../shared/invoices';
import { formatUsd } from '../shared/estimate';
import { fold, TRASH_DAYS } from '../shared/folders';
import { getLang, locale, t, type MessageKey } from '../shared/i18n';
import { languageName } from '../shared/languages';
import { formatMoney, parseMoney } from '../shared/money';
import { PDFJS_OPTIONS } from '../shared/pdf';
import { isOnline } from '../shared/provider';
import { findRegion, moveCrop, normalizeCrop, resizeCrop, type Handle } from '../shared/regions';
import { gaps } from '../shared/bibliography';
import { reference, toHtml, toPlain } from '../shared/citation';
import { authorsText, BIBLIO_FIELDS, CONTRACT_FACTS, DOC_TYPES, FACT_FIELDS, INVOICE_FACTS, parseAuthors } from '../shared/card';
import type { AresEntry, Biblio, CitationStyle, DocFacts, DocLinks, DocType, DocumentCard, DocumentContext, Job, JobDetail, Mode, OwnCompany, RegionTranslation, RelatedDoc, Segment, Stage } from '../shared/types';
import { currentKind, hasOtherLibrary, moveToLibraryModal } from './library-switch';
import { openFill } from './openalex-view';
import { chooseFolder } from './upload-view';
import { openChat, resetChat, setupChat, showChat } from './chat';
import { highlightCount, highlightsHidden, highlightsSection, loadHighlights, paint, resetHighlights, setHidden, setupHighlights } from './highlights';
import { createPages, releasePages, setupPdfZoom } from './pdf-zoom';
import {
  actionMenu,
  cleanError,
  date,
  duration,
  h,
  icon,
  ICONS,
  jobDuration,
  langPair,
  type MenuItem,
  MODES,
  openModal,
  progressBar,
  progressInfo,
  STAGES,
  STATUS_TEXT,
  toast,
  toastAction,
  writeClipboard,
} from './dom';

GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs';

export type { Tab };

const $ = (id: string) => document.getElementById(id)!;
const finalText = (s: Segment) => s.edited ?? s.polished ?? s.translation ?? '';
// Citáty jen pro přeložené PDF se ve Srovnání ani v Překladu nezobrazují.
const visible = (segments: Segment[]) => segments.filter((s) => !s.layoutOnly);
const pickable = (segments: Segment[]) => segments.filter((s) => !s.layoutOnly && !s.figure);
const isPicking = () => current?.job.status === 'picking' || picking;
const GENDER: Record<DocumentContext['authorGender'], MessageKey> = {
  female: 'detail.gender.female',
  male: 'detail.gender.male',
  unknown: 'detail.gender.unknown',
};
// Fáze ze starších úloh (celotextové uhlazení), aby jejich doba měla v Informacích popisek.
const OLD_STAGES: Record<string, MessageKey> = { polish: 'stage.polish', glossary: 'stage.glossary' };

/** Co detail umí otevřít mimo sebe (nastavuje renderer). */
export interface DetailHost {
  open(id: string): void;
  openProject(id: string): void;
  openFolder(id: string): void;
  showFinance(): void;
  /** Porovnání dvou verzí smlouvy. */
  openCompare(id: string, other: string): void;
}
let host: DetailHost;

let current: JobDetail | null = null;
let tab: Tab = 'original';
// Souvislosti dokumentu (načítají se zvlášť, ať dokument naskočí hned).
let links: DocLinks | null = null;
let ownCompany: OwnCompany | undefined;
let citeStyle: CitationStyle = 'iso690';
// Místo pro termíny v Přehledu; vyplní se, jakmile se načtou souvislosti.
let deadlineBox: HTMLElement | null = null;
let riskBox: HTMLElement | null = null;
// Karta otevřeného dokumentu (název a typ v hlavičce, rozhodnutí o výchozí záložce).
let docCard: DocumentCard | null = null;
// Dokument má záložku Překlad; naposledy zvolená volba přepínače uvnitř ní.
let translated = false;
let lastSub: View = 'compare';
let renderToken = 0;
// Výběr odstavců u hotové úlohy (u stavu picking se výběr ukazuje vždy).
let picking = false;
let picked = new Set<number>();
let regions: RegionTranslation[] = [];
// Vrstvy stránek originálu podle čísla stránky, aby šel přidat rámeček bez překreslení.
let regionLayers = new Map<number, HTMLElement[]>();
// Rámečky uložených oblastí (jeden na vrstvu), aby šly smazat nebo přesunout.
let frames = new Map<RegionTranslation, HTMLElement[]>();
// Právě upravovaná oblast na stránce.
let editing: { cancel: () => void } | null = null;
const HIDE_KEY = 'regionsHidden';
let regionsHidden = (() => {
  try {
    return localStorage.getItem(HIDE_KEY) === '1';
  } catch {
    return false;
  }
})();
// Upozornění „Oblasti jsou skryté“ se ukáže jen jednou.
let hiddenTold = false;
// Všechny vykreslené stránky (originál i překlad) podle čísla; na ně se kreslí zvýraznění citace.
let pageWraps = new Map<number, HTMLElement[]>();
// Záložka, jejíž obsah je v těle vykreslený hotový.
let renderedTab: Tab | null = null;
// Citovaný odstavec z chatu; zvýrazní se, jakmile je obsah záložky vykreslený.
let cite: { segment: Segment; scrolled: boolean } | null = null;

export const detailJobId = () => current?.job.id ?? null;
// Pod touto šířkou čtecí oblasti se stránky řadí pod sebe; nad ní zůstávají vedle sebe a zmenší se.
const SIDE_BY_SIDE_MIN = 560;
const PAIR_GAP = 14;

const statusChip = (job: Job) => h('span', { class: `status-chip is-${job.status}` }, h('i'), t(STATUS_TEXT[job.status]));

async function go(view: Tab) {
  clearCite();
  tab = usableView(view, translated, Boolean(current?.job.outputPdf));
  await renderBody();
}

async function showWarnings() {
  await go('compare');
  $('detail-body').querySelector('.compare-cell.has-warning')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/** Údaje karty, které jsou data (zobrazují se česky, ukládají jako RRRR-MM-DD). */
const DATE_FACTS = new Set<string>(['issued', 'due', 'validFrom', 'validTo']);

/** Popisek údaje; u smlouvy je částka cena a datum vystavení datum podpisu. */
const factLabel = (k: string, type?: string) =>
  t((type === 'contract' && (k === 'amount' || k === 'issued') ? `card.facts.${k}Contract` : `card.facts.${k}`) as MessageKey);

async function relayout(job: Job) {
  try {
    await window.api.relayoutJob(job.id);
    toast(t('detail.relayoutDone'));
    if (current?.job.id === job.id) await openDetail(job.id, tab);
  } catch (e) {
    toast(cleanError(e), true);
  }
}

function retryItems(job: Job): MenuItem[] {
  return [
    t('detail.retry'),
    ...(Object.keys(MODES) as Mode[]).map((mode) => ({
      label: t('mode.suffix', { mode: t(MODES[mode].title) }),
      icon: ICONS.retry,
      run: async () => {
        await window.api.retryJob(job.id, mode);
        toast(t('detail.retryQueued', { name: job.name, mode: t(MODES[mode].title) }));
      },
    })),
  ];
}

const deleteItem = (job: Job): Exclude<MenuItem, string | null> => ({
  label: t('detail.delete'),
  icon: ICONS.trash,
  danger: true,
  run: async () => {
    if (!confirm(t('detail.confirmDelete', { name: job.name, days: TRASH_DAYS }))) return;
    await window.api.deleteJob(job.id);
    toastAction(t('trash.moved', { count: 1 }), t('trash.undo'), () => void window.api.restoreJobs([job.id]).catch((e) => toast(cleanError(e), true)));
  },
});

/** Hlavička vpravo: Zeptat se, Přeložit (jen nepřeložený dokument) a nabídka „⋯“ se zbytkem akcí. */
function actions(job: Job) {
  if (job.status === 'running' || job.status === 'queued') {
    return [h('button', { class: 'btn danger', type: 'button', onclick: () => window.api.cancelJob(job.id) }, icon(ICONS.stop), t('job.cancel'))];
  }
  const tool = (label: string, path: string, run: () => unknown, cls = 'btn') => {
    const button = smallButton(label, run, cls);
    button.prepend(icon(path));
    return button;
  };
  const list: HTMLElement[] = [];
  if (job.status === 'done') {
    list.push(tool(t('detail.tool.ask'), ICONS.chat, openChat, 'btn primary'));
    if (!translated) list.push(tool(t('detail.tool.translate'), ICONS.translate, () => translateTool(job)));
  }
  list.push(actionMenu(() => menuItems(job)));
  return list;
}

/** Nabídka „⋯“: nástroje dokumentu, zobrazení, přesun a správa souboru. */
function menuItems(job: Job): MenuItem[] {
  const items: MenuItem[] = [];
  const isPdf = job.ext.toLowerCase() === '.pdf';
  const done = job.status === 'done';
  if (done) {
    items.push({ label: t('detail.tool.extract'), icon: ICONS.sparkle, run: () => extractTool(job) });
    if (translated) {
      items.push(
        { label: t('info.file.wordTranslation'), icon: ICONS.file, run: () => saveWord(job, 'translation') },
        { label: t('info.file.wordOriginal'), icon: ICONS.file, run: () => saveWord(job, 'original') },
      );
    } else items.push({ label: t('detail.tool.word'), icon: ICONS.file, run: () => saveWord(job, 'original') });
    if (job.outputPdf || isPdf) items.push({ label: t('detail.openPdf'), icon: ICONS.eye, run: () => window.api.openOutput(job.id, job.outputPdf ? 'pdf' : 'input') });
    else items.push({ label: t('info.file.open'), icon: ICONS.eye, run: () => window.api.openOutput(job.id, 'input') });
    if (job.output) items.push({ label: t('detail.openWord'), icon: ICONS.file, run: () => window.api.openOutput(job.id, 'docx') });
  }
  const view: MenuItem[] = [];
  if (highlightCount()) view.push({ label: t(highlightsHidden() ? 'highlight.show' : 'highlight.hide'), icon: highlightsHidden() ? ICONS.eye : ICONS.eyeOff, run: () => setHidden(!highlightsHidden()) });
  if (isPdf && (tab === 'original' || tab === 'side-by-side')) view.push({ label: t(regionsHidden ? 'region.show' : 'region.hide'), icon: regionsHidden ? ICONS.eye : ICONS.eyeOff, run: toggleRegions });
  if (view.length) items.push(null, ...view);
  items.push(null, { label: t('info.file.move'), icon: ICONS.folder, run: () => moveDoc(job) });
  if (hasOtherLibrary() && job.status !== 'picking') items.push({ label: t('libs.move'), icon: ICONS.arrow, run: () => moveToLibraryModal([job.id]) });
  if (done) {
    items.push(
      null,
      { label: t('detail.saveAs'), icon: ICONS.download, run: () => window.api.saveOutputAs(job.id) },
      { label: t('detail.reveal'), icon: ICONS.folder, run: () => window.api.revealOutput(job.id) },
    );
    if (isPdf) items.push({ label: t('detail.relayout'), icon: ICONS.retry, run: () => relayout(job) });
    if (current && pickable(current.segments).some((s) => s.skipped)) {
      items.push({
        label: t('pick.more'),
        icon: ICONS.list,
        run: () => {
          startPicking();
          void go('compare');
        },
      });
    }
  }
  items.push({ label: t('detail.technical'), icon: ICONS.list, run: technicalInfo }, ...retryItems(job), deleteItem(job));
  return items;
}

/** Technické informace (soubor, režim, model, cena…) v okně otevřeném z nabídky „⋯“. */
function technicalInfo() {
  if (!current) return;
  let close = () => {};
  close = openModal(t('detail.technical'), [infoView(current)], [h('button', { class: 'btn', type: 'button', onclick: () => close() }, t('region.close'))]);
}

async function saveWord(job: Job, which: 'original' | 'translation') {
  const file = await window.api.saveWord(job.id, which);
  if (file) toast(t('detail.word.saved', { path: file }));
}

/** Přeloží dokument do výchozího cílového jazyka (nová úloha jako „Přeložit znovu“). */
async function translateTool(job: Job) {
  const target = (await window.api.getSettings()).targetLang;
  if (target === job.sourceLang) return toast(t('detail.translateSame'), true);
  await window.api.retryJob(job.id, job.mode, target);
  toast(t('detail.translateQueued', { lang: languageName(target), name: docTitle(job, docCard) }));
}

/** Vytvoří chybějící kartu; faktura či smlouva bez údajů se vytvoří znovu. Pak ukáže O dokumentu. */
async function extractTool(job: Job) {
  const fresh = await window.api.getCard(job.id).catch(() => null);
  const noFacts = (fresh?.type === 'invoice' || fresh?.type === 'contract') && !Object.keys(fresh.facts ?? {}).length;
  if (!fresh || noFacts) {
    if (fresh?.edited && !confirm(t('card.confirmRecreate'))) return;
    docCard = await window.api.makeCard(job.id);
    if (current?.job.id === job.id) renderHeader();
  }
  if (current?.job.id === job.id) await go('overview');
}

/** Výchozí výběr: u nové úlohy vše, u hotové jen to, co už je přeložené (to je zamčené). */
function startPicking() {
  picking = true;
  const segments = pickable(current!.segments);
  picked = new Set(segments.filter((s) => current!.job.status === 'picking' || s.translation !== undefined).map((s) => s.id));
}

function renderProgress(job: Job) {
  const box = $('detail-progress');
  const running = job.status === 'running' || job.status === 'queued';
  box.hidden = !running;
  if (!running) return;
  const info = progressInfo(job);
  box.replaceChildren(
    h('div', { class: 'row gap' }, h('strong', {}, info.label), h('span', { class: 'muted' }, info.eta)),
    progressBar(info.fraction),
  );
}

/** Výřez tabulky/grafu z originálu; obrázek se doplní po načtení. */
function figureEl(s: Segment) {
  const img = h('img', { class: 'figure-snapshot', alt: '' }) as HTMLImageElement;
  // Velikost jako v tištěném článku (body ≈ CSS px), ne roztažené na celou šířku.
  if (s.snapshot) img.style.width = `${Math.round(s.snapshot.width * 1.4)}px`;
  if (current && s.snapshot) {
    window.api.jobFigure(current.job.id, s.snapshot.file).then(
      (src) => (img.src = src),
      () => img.remove(),
    );
  }
  return img;
}

function compareView(segments: Segment[]) {
  const grid = h(
    'div',
    { class: 'compare' },
    h('div', { class: 'compare-head' }, t('detail.originalLang', { lang: languageName(current!.job.sourceLang) })),
    h('div', { class: 'compare-head' }, t('detail.translationLang', { lang: languageName(current!.job.targetLang) })),
  );
  let page: number | undefined;
  for (const s of segments) {
    if (s.page && s.page !== page && segments.some((x) => x.page && x.page > 1)) {
      page = s.page;
      grid.append(h('div', { class: 'compare-page' }, t('detail.page', { page })));
    }
    const cls = `compare-cell${s.kind === 'heading' ? ' heading' : ''}${s.warning ? ' has-warning' : ''}${s.skipped ? ' skipped' : ''}`;
    const figure = s.snapshot ? h('div', { class: 'compare-figure' }, figureEl(s)) : null;
    if (figure && s.snapshot?.position === 'before') grid.append(figure);
    grid.append(
      h('div', { class: cls, 'data-seg': String(s.id), 'data-side': 'source' }, s.source),
      h('div', { class: cls, 'data-seg': String(s.id), 'data-side': 'target' }, s.skipped ? t('detail.skipped') : finalText(s) || '…', s.warning ? h('span', { class: 'warning-note' }, `⚠ ${s.warning}`) : null),
    );
    if (figure && s.snapshot?.position !== 'before') grid.append(figure);
  }
  return grid;
}

/** Výběrový seznam odstavců: jeden sloupec originálu s checkboxy. */
function pickView(segments: Segment[]) {
  const job = current!.job;
  const items = pickable(segments);
  const locked = (s: Segment) => s.translation !== undefined;
  const free = items.filter((s) => !locked(s));
  const checks = new Map<number, HTMLInputElement>();
  const pageBoxes: { box: HTMLInputElement; ids: number[] }[] = [];
  const info = h('strong');
  const go = h('button', { class: 'btn primary' }, t('pick.translate'));
  const sync = () => {
    const chosen = free.filter((s) => picked.has(s.id));
    info.textContent = t('pick.count', {
      selected: chosen.length,
      total: free.length,
      chars: chosen.reduce((n, s) => n + s.source.length, 0).toLocaleString(locale()),
    });
    go.disabled = !chosen.length;
    for (const { box, ids } of pageBoxes) {
      const on = ids.filter((id) => picked.has(id)).length;
      box.checked = on === ids.length;
      box.indeterminate = on > 0 && on < ids.length;
    }
  };
  const setAll = (ids: number[], on: boolean) => {
    for (const id of ids) {
      if (on) picked.add(id);
      else picked.delete(id);
      checks.get(id)!.checked = on;
    }
    sync();
  };
  const freeIds = free.map((s) => s.id);
  go.onclick = async () => {
    go.disabled = true;
    try {
      const ids = freeIds.filter((id) => picked.has(id));
      await window.api.translateSegments(job.id, ids);
      toast(t('pick.queued', { count: ids.length }));
      picking = false;
      if (current?.job.id === job.id) void renderBody();
    } catch (e) {
      toast(cleanError(e), true);
      sync();
    }
  };
  const bar = h(
    'div',
    { class: 'pick-bar' },
    info,
    h('button', { class: 'btn', onclick: () => setAll(freeIds, true) }, t('pick.selectAll')),
    h('button', { class: 'btn', onclick: () => setAll(freeIds, false) }, t('pick.clear')),
    job.status === 'done' ? h('button', { class: 'btn', onclick: () => { picking = false; void renderBody(); } }, t('pick.back')) : null,
    go,
  );
  const grid = h('div', { class: 'compare pick' }, h('div', { class: 'compare-head' }, t('detail.originalLang', { lang: languageName(job.sourceLang) })));
  const paged = items.some((s) => s.page && s.page > 1);
  let page: number | undefined;
  for (const s of items) {
    if (paged && s.page && s.page !== page) {
      page = s.page;
      const ids = free.filter((x) => x.page === page).map((x) => x.id);
      const box = h('input', { type: 'checkbox', disabled: !ids.length, checked: !ids.length });
      box.onchange = () => setAll(ids, box.checked);
      if (ids.length) pageBoxes.push({ box, ids });
      grid.append(h('label', { class: 'compare-page pick-page' }, box, `${t('detail.page', { page })} · ${t('pick.wholePage')}`));
    }
    const box = h('input', { type: 'checkbox', disabled: locked(s) });
    box.checked = picked.has(s.id);
    box.onchange = () => {
      if (box.checked) picked.add(s.id);
      else picked.delete(s.id);
      sync();
    };
    checks.set(s.id, box);
    grid.append(h('label', { class: `compare-cell pick-cell${s.kind === 'heading' ? ' heading' : ''}${locked(s) ? ' locked' : ''}` }, box, h('span', {}, s.source)));
  }
  sync();
  return h('div', {}, h('p', { class: 'muted pick-hint' }, t('pick.hint')), bar, grid);
}

/** Výsledek překladu oblasti: řádky tabulky jako tabulka, zbytek jako text se zachovanými řádky. */
function regionResult(text: string) {
  const box = h('div', { class: 'region-result' });
  let block: string[] = [];
  let table = false;
  const flush = () => {
    if (block.length) box.append(table ? tableEl(block.join('\n')) : h('div', { class: 'region-text' }, block.join('\n')));
    block = [];
  };
  for (const line of text.split('\n')) {
    const isRow = line.trim().startsWith('|');
    if (isRow !== table) flush();
    table = isRow;
    block.push(line);
  }
  flush();
  return box;
}

/** Zvětšený výřez stránky vykreslený přímo z PDF (ostrý), šířka max. 720 px. */
async function cropCanvas(pdf: PDFDocumentProxy, number: number, crop: RegionTranslation['crop']) {
  const page = await pdf.getPage(number);
  const base = page.getViewport({ scale: 1 });
  const width = Math.min(720, 2.5 * (crop[2] - crop[0]) * base.width);
  const scale = width / ((crop[2] - crop[0]) * base.width);
  const dpr = window.devicePixelRatio;
  const viewport = page.getViewport({ scale: scale * dpr });
  const canvas = h('canvas');
  canvas.width = Math.max(1, Math.round((crop[2] - crop[0]) * viewport.width));
  canvas.height = Math.max(1, Math.round((crop[3] - crop[1]) * viewport.height));
  canvas.style.width = `${canvas.width / dpr}px`;
  const transform = [1, 0, 0, 1, -crop[0] * viewport.width, -crop[1] * viewport.height];
  await page.render({ canvas, viewport, transform }).promise;
  return canvas;
}

function openRegionDialog(pdf: PDFDocumentProxy, number: number, crop: RegionTranslation['crop']) {
  const id = current!.job.id;
  const result = h('div', { class: 'region-out' });
  const wait = h('span', { class: 'muted' }, t('region.wait'));
  const button = h('button', { class: 'btn primary' }, t('region.translate'));
  const image = h('div', { class: 'region-image' });
  const foot = h('div', { class: 'modal-foot' }, wait, button);
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  const overlay: HTMLElement = h(
    'div',
    { class: 'modal-overlay', onmousedown: (e: Event) => e.target === overlay && close() },
    h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'modal-head' }, h('strong', {}, `${t('region.title')} · ${t('detail.page', { page: number })}`), h('button', { class: 'btn', title: t('region.close'), 'aria-label': t('region.close'), onclick: close }, icon(ICONS.x))),
      h('div', { class: 'modal-body' }, image, result),
      foot,
    ),
  );
  // U uložené oblasti nabídne úpravu a smazání.
  const show = (saved: RegionTranslation) => {
    result.replaceChildren(regionResult(saved.text));
    foot.replaceChildren(
      h(
        'button',
        {
          class: 'btn danger',
          onclick: async () => {
            try {
              await window.api.deleteRegion(id, saved.page, saved.crop);
            } catch (e) {
              return toast(cleanError(e), true);
            }
            if (current?.job.id === id) removeRegion(saved);
            close();
          },
        },
        t('region.delete'),
      ),
      h('button', { class: 'btn', onclick: () => (close(), editRegion(pdf, saved)) }, t('region.edit')),
    );
    foot.hidden = false;
  };
  const saved = findRegion(regions, number, crop);
  if (saved) show(saved);
  button.onclick = async () => {
    button.disabled = true;
    button.textContent = t('region.translating');
    result.replaceChildren();
    try {
      const fresh = await window.api.translateRegion(id, number, crop);
      const known = current?.job.id === id ? findRegion(regions, fresh.page, fresh.crop) : undefined;
      if (current?.job.id === id && !known) {
        regions.push(fresh);
        addRegionFrame(pdf, fresh);
        noteHidden();
      }
      show(known ?? fresh);
    } catch (e) {
      result.replaceChildren(h('div', { class: 'error-box' }, cleanError(e)));
      button.disabled = false;
      button.textContent = t('region.translate');
    }
  };
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  void cropCanvas(pdf, number, crop).then((canvas) => image.replaceChildren(canvas), (e) => image.replaceChildren(h('div', { class: 'error-box' }, cleanError(e))));
}

function placeBox(el: HTMLElement, crop: RegionTranslation['crop']) {
  el.style.left = `${crop[0] * 100}%`;
  el.style.top = `${crop[1] * 100}%`;
  el.style.width = `${(crop[2] - crop[0]) * 100}%`;
  el.style.height = `${(crop[3] - crop[1]) * 100}%`;
}

function addRegionFrame(pdf: PDFDocumentProxy, region: RegionTranslation) {
  for (const layer of regionLayers.get(region.page) ?? []) {
    const frame = h('button', { class: 'region-frame', title: t('region.saved') });
    frames.set(region, [...(frames.get(region) ?? []), frame]);
    placeBox(frame, region.crop);
    frame.onmousedown = (e) => e.stopPropagation();
    // Jedno kliknutí otevře překlad, dvojklik přejde do úpravy (dialog se proto otevírá s krátkým zpožděním).
    let timer: ReturnType<typeof setTimeout> | undefined;
    frame.onclick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => openRegionDialog(pdf, region.page, region.crop), 220);
    };
    frame.ondblclick = () => {
      clearTimeout(timer);
      editRegion(pdf, region);
    };
    layer.append(frame);
  }
}

const MIN_DRAG = 12;

function removeRegion(region: RegionTranslation) {
  for (const frame of frames.get(region) ?? []) frame.remove();
  frames.delete(region);
  regions = regions.filter((r) => r !== region);
}

/** Skryté oblasti nové překlady neukážou; uživatel se o tom dozví jednou. */
function noteHidden() {
  if (!regionsHidden || hiddenTold) return;
  hiddenTold = true;
  toast(t('region.hiddenToast'));
}

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * Upravitelný výběr na stránce (jako obdélníkový výběr v Photoshopu): úchyty mění velikost, tažení uvnitř ho posune.
 * Bez `region` je to nový výběr s lištou „Přeložit“, jinak úprava uložené oblasti s „Přeložit znovu“.
 */
function startSelection(pdf: PDFDocumentProxy, number: number, layer: HTMLElement, start: RegionTranslation['crop'], region?: RegionTranslation) {
  editing?.cancel();
  const id = current!.job.id;
  const old = region ? (frames.get(region) ?? []) : [];
  let crop = start;
  let busy = false;
  const box = h('div', { class: 'region-edit' });
  const confirm = h('button', { class: 'btn primary' }, t(region ? 'region.retranslate' : 'region.translate'));
  const cancel = h('button', { class: 'btn' }, t('region.cancel'));
  const bar = h('div', { class: 'region-bar' }, confirm, cancel);
  const place = () => {
    placeBox(box, crop);
    bar.classList.toggle('above', crop[3] > 0.85);
  };
  const end = () => {
    document.removeEventListener('keydown', onKey);
    box.remove();
    for (const frame of old) frame.classList.remove('editing');
    editing = null;
  };
  const onKey = (e: KeyboardEvent) => {
    if (busy || document.querySelector('.modal-overlay')) return;
    if (e.key === 'Escape') end();
    else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) confirm.click();
  };

  // Tažení: `apply` spočítá nový výřez z původního a posunu v poměru ke stránce.
  const drag = (e: MouseEvent, apply: (c: RegionTranslation['crop'], dx: number, dy: number, rect: DOMRect) => RegionTranslation['crop']) => {
    if (e.button !== 0 || busy) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = layer.getBoundingClientRect();
    const from = crop;
    const move = (ev: MouseEvent) => {
      crop = apply(from, (ev.clientX - e.clientX) / rect.width, (ev.clientY - e.clientY) / rect.height, rect);
      place();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  box.onmousedown = (e) => drag(e, (c, dx, dy) => moveCrop(c, dx, dy));
  for (const handleName of HANDLES) {
    const handle = h('div', { class: `region-handle ${handleName}` });
    handle.onmousedown = (e) => drag(e, (c, dx, dy, rect) => resizeCrop(c, handleName, dx, dy, [MIN_DRAG / rect.width, MIN_DRAG / rect.height]));
    box.append(handle);
  }
  bar.onmousedown = (e) => e.stopPropagation();
  cancel.onclick = end;
  confirm.onclick = async () => {
    if (!region) {
      const chosen = crop;
      end();
      openRegionDialog(pdf, number, chosen);
      return;
    }
    busy = true;
    confirm.disabled = cancel.disabled = true;
    confirm.textContent = t('region.translating');
    try {
      const fresh = await window.api.translateRegion(id, region.page, crop, region.crop);
      if (current?.job.id !== id || !box.isConnected) return;
      removeRegion(region);
      regions.push(fresh);
      addRegionFrame(pdf, fresh);
      end();
      noteHidden();
      openRegionDialog(pdf, fresh.page, fresh.crop);
    } catch (e) {
      toast(cleanError(e), true);
      busy = false;
      confirm.disabled = cancel.disabled = false;
      confirm.textContent = t('region.retranslate');
    }
  };
  for (const frame of old) frame.classList.add('editing');
  box.append(bar);
  place();
  layer.append(box);
  document.addEventListener('keydown', onKey);
  editing = { cancel: end };
}

function editRegion(pdf: PDFDocumentProxy, region: RegionTranslation) {
  const layer = frames.get(region)?.[0]?.parentElement;
  if (layer) startSelection(pdf, region.page, layer, region.crop, region);
}

/** Stránka originálu, na které jde tažením myši označit oblast k přiblížení a překladu. */
function selectablePage(pdf: PDFDocumentProxy, number: number, canvas: HTMLCanvasElement) {
  const wrap = h('div', { class: 'pdf-page' }, canvas);
  wrap.style.width = canvas.style.width;
  pageWraps.set(number, [...(pageWraps.get(number) ?? []), wrap]);
  regionLayers.set(number, [...(regionLayers.get(number) ?? []), wrap]);
  for (const region of regions) if (region.page === number) addRegionFrame(pdf, region);
  wrap.onmousedown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    editing?.cancel();
    const box = wrap.getBoundingClientRect();
    const clampX = (x: number) => Math.min(box.width, Math.max(0, x - box.left));
    const clampY = (y: number) => Math.min(box.height, Math.max(0, y - box.top));
    const [x0, y0] = [clampX(e.clientX), clampY(e.clientY)];
    const draft = h('div', { class: 'region-draft' });
    wrap.append(draft);
    const rect = (ev: MouseEvent) => [Math.min(x0, clampX(ev.clientX)), Math.min(y0, clampY(ev.clientY)), Math.max(x0, clampX(ev.clientX)), Math.max(y0, clampY(ev.clientY))];
    const move = (ev: MouseEvent) => {
      const [a, b, c, d] = rect(ev);
      placeBox(draft, [a / box.width, b / box.height, c / box.width, d / box.height]);
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      draft.remove();
      const [a, b, c, d] = rect(ev);
      if (c - a < MIN_DRAG || d - b < MIN_DRAG) return;
      startSelection(pdf, number, wrap, normalizeCrop([a / box.width, b / box.height, c / box.width, d / box.height]));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return wrap;
}

function tableEl(text: string, attrs: Record<string, string> = {}) {
  const table = h('table', attrs);
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|') || /^\|[\s|:-]+\|$/.test(line.trim())) continue;
    const row = h('tr');
    for (const cell of line.trim().replace(/^\||\|$/g, '').split('|')) row.append(h('td', {}, cell.trim()));
    table.append(row);
  }
  return table;
}

function documentView(segments: Segment[], text: (s: Segment) => string, side: 'source' | 'target' = 'target') {
  const doc = h('article', { class: 'doc' });
  for (const s of segments) {
    const body = text(s);
    if (s.snapshot?.position === 'before') doc.append(figureEl(s));
    const mark = { 'data-seg': String(s.id), 'data-side': side };
    if (s.kind === 'heading') doc.append(h('h2', mark, body));
    else if (s.kind === 'list') {
      const ul = h('ul', mark);
      for (const li of body.split('\n').filter((l) => l.trim())) ul.append(h('li', {}, li.replace(/^\s*([-*•–]|\d+[.)])\s+/, '')));
      doc.append(ul);
    } else if (s.kind === 'table') doc.append(tableEl(body, mark));
    else doc.append(h('p', mark, body));
    if (s.snapshot && s.snapshot.position !== 'before') doc.append(figureEl(s));
  }
  return doc;
}

async function originalView(detail: JobDetail, token: number) {
  if (detail.job.ext !== '.pdf') return documentView(visible(detail.segments), (s) => s.source, 'source');
  return pdfView(await window.api.readInput(detail.job.id), token, true);
}

/** Stránka bez výběru oblastí (překlad), ale se stejnou vrstvou pro zvýraznění. */
function plainPage(number: number, canvas: HTMLCanvasElement) {
  const wrap = h('div', { class: 'pdf-page plain' }, canvas);
  wrap.style.width = canvas.style.width;
  pageWraps.set(number, [...(pageWraps.get(number) ?? []), wrap]);
  return wrap;
}

/** Zvýrazní citovaný segment na vykreslených stránkách (PDF) nebo v řádku Srovnání. */
function applyCite() {
  if (!cite) return;
  const { segment } = cite;
  const first: HTMLElement[] = [];
  if (tab === 'compare') {
    for (const el of $('detail-body').querySelectorAll<HTMLElement>(`[data-seg="${segment.id}"]`)) {
      el.classList.add('cite-row');
      first.push(el);
    }
  } else {
    for (const rect of segment.rects ?? []) {
      for (const wrap of pageWraps.get(rect.page) ?? []) {
        const { pw, ph } = (wrap.firstElementChild as HTMLElement).dataset;
        if (!pw || !ph) continue;
        const mark = h('div', { class: 'cite-hl' });
        placeBox(mark, [rect.x / +pw, rect.y / +ph, (rect.x + rect.w) / +pw, (rect.y + rect.h) / +ph]);
        wrap.append(mark);
        first.push(mark);
      }
    }
  }
  if (cite.scrolled || !first.length) return;
  cite.scrolled = true;
  first[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function clearCite() {
  cite = null;
  for (const el of document.querySelectorAll('.cite-hl')) el.remove();
  for (const el of document.querySelectorAll('.cite-row')) el.classList.remove('cite-row');
}

/** Klik na citaci v chatu: přepne na vhodnou záložku (hotová se nepřekresluje) a zvýrazní segment. */
function showCite(segment: Segment) {
  if (!current) return;
  clearCite();
  cite = { segment, scrolled: false };
  const { job } = current;
  const next: Tab = !translated ? 'original' : job.ext.toLowerCase() !== '.pdf' ? 'compare' : job.outputPdf ? 'side-by-side' : 'original';
  if (next === tab) return renderedTab === tab ? applyCite() : undefined;
  tab = next;
  void renderBody();
}

/** Citace z chatu s knihovnou: zvýrazní segment v právě otevřeném dokumentu. */
export function citeSegment(segmentId: number) {
  const segment = current?.segments.find((s) => s.id === segmentId);
  if (segment) showCite(segment);
}

const HINT_KEY = 'regionHintSeen';
/** Nápověda k označování oblastí se ukáže jen poprvé. */
function regionHint() {
  try {
    if (localStorage.getItem(HINT_KEY)) return null;
    localStorage.setItem(HINT_KEY, '1');
  } catch {}
  return h('p', { class: 'region-hint' }, t('region.hint'));
}

async function pdfView(data: Uint8Array | null, token: number, selectable = false) {
  const holder = h('div', { class: 'pdf-pages' }, h('p', { class: 'muted' }, t('detail.loadingPdf')));
  if (!data || token !== renderToken) return holder;
  const pdf = await getDocument({ data, ...PDFJS_OPTIONS }).promise;
  if (token !== renderToken) return holder;
  holder.replaceChildren();
  const hint = selectable ? regionHint() : null;
  if (hint) holder.append(hint);
  const pages = createPages(holder, () => Math.min(900, $('detail-body').clientWidth || 800));
  const canvases = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pages.canvas(pdf, i + 1)));
  if (token !== renderToken) return pages.destroy(), holder;
  canvases.forEach((canvas, i) => holder.append(selectable ? selectablePage(pdf, i + 1, canvas) : plainPage(i + 1, canvas)));
  return holder;
}

/** Stránka originálu a téže stránky překladu vedle sebe; v úzkém okně pod sebou. */
async function sideBySideView(detail: JobDetail, token: number) {
  const holder = h('div', { class: 'pdf-pages pdf-pairs' });
  const [source, output] = await Promise.all([window.api.readInput(detail.job.id), window.api.readOutputPdf(detail.job.id)]);
  if (!source || !output || token !== renderToken) return holder;
  const [left, right] = await Promise.all([getDocument({ data: source, ...PDFJS_OPTIONS }).promise, getDocument({ data: output, ...PDFJS_OPTIONS }).promise]);
  if (token !== renderToken) return holder;
  const hint = regionHint();
  if (hint) holder.append(hint);
  // Základní šířka stránky; podle šířky čtecí oblasti zároveň přepíná řazení pod sebe.
  const pages = createPages(holder, () => {
    const available = $('detail-body').clientWidth || 800;
    const stacked = available < SIDE_BY_SIDE_MIN;
    holder.classList.toggle('stacked', stacked);
    return stacked ? Math.min(900, available) : Math.floor((available - PAIR_GAP) / 2);
  });
  const count = Math.max(left.numPages, right.numPages);
  const cells = await Promise.all(
    Array.from({ length: count }, (_, i) => Promise.all([i < left.numPages ? pages.canvas(left, i + 1) : null, i < right.numPages ? pages.canvas(right, i + 1) : null])),
  );
  if (token !== renderToken) return pages.destroy(), holder;
  cells.forEach(([a, b], i) => {
    holder.append(h('div', { class: 'pdf-pair' }, a ? selectablePage(left, i + 1, a) : pages.spacer(), b ? plainPage(i + 1, b) : pages.spacer()));
  });
  return holder;
}

const stageName = (stage: string) => {
  const key = STAGES[stage as Stage] ?? OLD_STAGES[stage];
  return key ? t(key) : stage;
};

const LITERATURE = new Set<DocType>(['article', 'book', 'chapter', 'thesis', 'report']);

/** Sekce „O dokumentu“: karta se shrnutím, klíčovými slovy a údaji; načítá se zvlášť, ať záložka naskočí hned. */
function cardSection(job: Job) {
  const box = h('section', { class: 'setting-group card' });
  const busyButton = (label: string, work: () => Promise<void>, confirmText?: string) => {
    const button = h('button', { class: 'btn' }, label);
    button.onclick = async () => {
      if (confirmText && !confirm(confirmText)) return;
      button.disabled = true;
      button.textContent = t('card.creating');
      try {
        await work();
      } catch (e) {
        toast(cleanError(e), true);
        button.disabled = false;
        button.textContent = label;
      }
    };
    return button;
  };
  const create = (label: string, confirmText?: string) =>
    busyButton(label, async () => show(await window.api.makeCard(job.id)), confirmText);
  const head = (...buttons: HTMLElement[]) => h('h2', {}, t('card.title'), h('span', { class: 'card-actions' }, ...buttons));
  const line = (label: string, value: string | Node) => h('div', { class: 'card-row' }, h('span', { class: 'muted' }, label), value);

  function show(card: DocumentCard | null) {
    // Hlavička (název, typ) se řídí kartou.
    if (current?.job.id === job.id) {
      docCard = card;
      renderTitle();
      fillRisks();
    }
    if (!card) {
      box.replaceChildren(head(), h('p', { class: 'muted' }, t('card.none')), h('div', {}, create(t('card.create'))));
      return;
    }
    const edit = h('button', { class: 'btn' }, t('card.edit'));
    edit.onclick = () => editForm(card);
    const recreate = create(t('card.recreate'), card.edited ? t('card.confirmRecreate') : undefined);
    const b = card.biblio;
    // U faktury a smlouvy bibliografie nedává smysl, ukazují se jejich údaje.
    const hasFacts = card.type === 'invoice' || card.type === 'contract';
    const facts = [
      b.title && line(t('card.biblio.title'), b.title),
      b.authors.length && line(t('card.authors'), b.authors.map((a) => (a.given ? `${a.family}, ${a.given}` : a.family)).join('; ')),
      ...BIBLIO_FIELDS.filter((k) => k !== 'title' && b[k]).map((k) => line(t(`card.biblio.${k}` as MessageKey), b[k]!)),
    ].filter(Boolean) as HTMLElement[];
    const f = card.facts ?? {};
    const docFacts = [
      ...FACT_FIELDS.filter((k) => f[k]).map((k) => line(factLabel(k, card.type), DATE_FACTS.has(k) ? day(f[k]!) : f[k]!)),
      f.parties?.length && line(t('card.facts.parties'), f.parties.join(', ')),
    ].filter(Boolean) as HTMLElement[];
    box.replaceChildren(
      head(edit, recreate),
      h('p', { class: 'card-summary' }, card.summary),
      h('div', { class: 'chips' }, h('span', { class: 'chip accent' }, t(`docType.${card.type}` as MessageKey)), ...card.keywords.map((k) => h('span', { class: 'chip' }, k)), card.edited && h('span', { class: 'chip' }, t('card.edited'))),
      ...(card.folder ? [line(t('card.folder'), card.folder)] : []),
      ...(facts.length && !hasFacts ? [h('div', { class: 'card-biblio' }, h('h3', {}, t('card.biblio')), ...facts)] : []),
      ...(currentKind() === 'study' && !hasFacts ? [citeRow(card)] : []),
      ...(docFacts.length ? [h('div', { class: 'card-biblio' }, h('h3', {}, t('card.facts')), ...(card.factsFrom === 'isdoc' ? [h('div', { class: 'chips' }, h('span', { class: 'chip accent' }, t('card.facts.isdoc')))] : []), ...docFacts, ...[aresRow(card), fxRow(card)].filter((r) => r !== null))] : []),
    );
  }

  /** Hotová citace s tlačítkem Kopírovat; když chybí údaje, jen upozornění. */
  function citeRow(card: DocumentCard) {
    const missing = gaps(card).filter((g) => g === 'title' || g === 'author' || g === 'year');
    if (missing.length) {
      const names = missing.map((g) => t(g === 'title' ? 'card.biblio.title' : g === 'author' ? 'card.authors' : 'card.biblio.year').toLowerCase());
      const fill = LITERATURE.has(card.type) ? h('button', { class: 'btn sm', type: 'button', onclick: () => void openFill(job.id, card, show).catch((e) => toast(cleanError(e), true)) }, icon(ICONS.globe), t('openalex.fill')) : null;
      const gapRow = line(t('card.cite'), h('div', { class: 'oa-fill-cell' }, h('span', { class: 'muted' }, t('card.cite.missing', { gaps: names.join(', ') })), fill));
      gapRow.classList.add('cite-row');
      return gapRow;
    }
    const parts = reference(card.biblio, card.type, citeStyle, getLang(), new Date().toISOString().slice(0, 10));
    const text = h('div', { class: 'card-cite' });
    text.innerHTML = toHtml(parts);
    const copy = h('button', { class: 'btn sm card-cite-copy', type: 'button' }, icon(ICONS.copy), t('card.cite.copy'));
    copy.onclick = () => void writeClipboard(toPlain(parts), toHtml(parts)).then(() => toast(t('card.cite.copied')), (e) => toast(cleanError(e), true));
    const row = line(t('card.cite'), h('div', {}, text, copy));
    row.classList.add('cite-row');
    return row;
  }

  function editForm(card: DocumentCard) {
    const summary = h('textarea', { rows: '5' });
    summary.value = card.summary;
    const type = h('select', {}, ...DOC_TYPES.map((d) => h('option', { value: d }, t(`docType.${d}` as MessageKey))));
    type.value = card.type;
    const keywords = h('input', { type: 'text' });
    keywords.value = card.keywords.join(', ');
    const folder = h('input', { type: 'text' });
    folder.value = card.folder ?? '';
    const authors = h('textarea', { rows: '3' });
    authors.value = authorsText(card.biblio.authors);
    const inputs = Object.fromEntries(
      BIBLIO_FIELDS.map((k) => {
        const input = h('input', { type: 'text' });
        input.value = card.biblio[k] ?? '';
        return [k, input];
      }),
    );
    const factInputs = Object.fromEntries(
      FACT_FIELDS.map((k) => {
        const input = h('input', { type: 'text' });
        input.value = card.facts?.[k] ?? '';
        return [k, input];
      }),
    );
    const parties = h('textarea', { rows: '2' });
    parties.value = (card.facts?.parties ?? []).join('\n');
    const field = (label: string, control: HTMLElement) => h('label', { class: 'field' }, h('span', {}, label), control);
    // Fakta se nabízejí jen u faktury a smlouvy.
    const factsBox = h(
      'div',
      { class: 'card-facts-edit' },
      ...FACT_FIELDS.map((k) => field(factLabel(k, card.type), factInputs[k])),
      field(`${t('card.facts.parties')} (${t('card.facts.partiesHint')})`, parties),
    );
    // Ukáže se jen pole patřící k zvolenému typu.
    const syncFacts = () => {
      const shown: readonly string[] = type.value === 'invoice' ? INVOICE_FACTS : type.value === 'contract' ? CONTRACT_FACTS : [];
      factsBox.hidden = !shown.length;
      FACT_FIELDS.forEach((k) => ((factInputs[k].parentElement as HTMLElement).hidden = !shown.includes(k)));
    };
    type.onchange = syncFacts;
    syncFacts();
    const save = h('button', { class: 'btn primary' }, t('card.save'));
    const cancel = h('button', { class: 'btn' }, t('card.cancel'));
    cancel.onclick = () => show(card);
    save.onclick = async () => {
      const text = (v: string) => v.trim() || undefined;
      const biblio: Biblio = { authors: parseAuthors(authors.value), title: inputs.title.value.trim() };
      for (const k of BIBLIO_FIELDS) if (k !== 'title') biblio[k] = text(inputs[k].value);
      const hasFacts = type.value === 'invoice' || type.value === 'contract';
      const facts: DocFacts = {};
      const kept: readonly string[] = type.value === 'invoice' ? INVOICE_FACTS : CONTRACT_FACTS;
      for (const k of FACT_FIELDS) if (kept.includes(k)) facts[k] = text(factInputs[k].value);
      facts.parties = [...new Set(parties.value.split('\n').map((p) => p.trim()).filter(Boolean))];
      if (!facts.parties.length) delete facts.parties;
      const factsClean = Object.fromEntries(Object.entries(facts).filter(([, v]) => v !== undefined)) as DocFacts;
      const edited: DocumentCard = {
        ...card,
        facts: hasFacts && Object.keys(factsClean).length ? factsClean : undefined,
        summary: summary.value.trim() || card.summary,
        type: type.value as DocType,
        keywords: [...new Set(keywords.value.split(',').map((k) => k.trim()).filter(Boolean))].slice(0, 10),
        folder: text(folder.value),
        biblio,
        edited: true,
      };
      save.disabled = true;
      try {
        await window.api.saveCard(job.id, edited);
        show(edited);
      } catch (e) {
        toast(cleanError(e), true);
        save.disabled = false;
      }
    };
    box.replaceChildren(
      head(),
      field(t('card.summary'), summary),
      field(t('card.type'), type),
      field(`${t('card.keywords')} (${t('card.keywordsHint')})`, keywords),
      field(t('card.folder'), folder),
      field(`${t('card.authors')} (${t('card.authorsHint')})`, authors),
      ...BIBLIO_FIELDS.map((k) => field(t(`card.biblio.${k}` as MessageKey), inputs[k])),
      factsBox,
      h('div', { class: 'card-actions' }, save, cancel),
    );
  }

  void window.api.getCard(job.id).then(show, () => show(null));
  return box;
}

const sourceText = () => current?.segments.map((s) => s.source).join('\n') ?? '';

/** Řádek ověření dodavatele v ARES: síť jen na klik, po ověření výsledek a datum (uložený výsledek se ukáže hned). */
function aresRow(card: DocumentCard) {
  const target = aresTarget(card.facts, ownCompany);
  if (!target) return null;
  const text = h('span', { class: 'check-text', hidden: true });
  const button = h('button', { class: 'btn', type: 'button' }, t('ares.check'));
  const row = h('div', { class: 'check-row' }, text, button);
  const paint = (entry?: AresEntry) => {
    if (!entry) return;
    const verdict = compareAres(entry.record, target.name, sourceText());
    row.className = `check-row ${verdict.kind === 'ok' ? 'ok' : 'warn'}`;
    text.hidden = false;
    text.replaceChildren(
      t(`ares.${verdict.kind}` as MessageKey, { city: verdict.kind === 'address' ? verdict.city : '', name: verdict.kind === 'name' ? verdict.name : '' }),
      ' ',
      h('span', { class: 'muted' }, `(${t('ares.checked', { date: day(entry.date) })})`),
    );
    button.textContent = t('ares.recheck');
  };
  button.onclick = async () => {
    button.disabled = true;
    button.textContent = t('ares.checking');
    try {
      paint(await window.api.aresLookup(target.ico, true));
    } catch (e) {
      toast(cleanError(e), true);
    } finally {
      button.disabled = false;
      if (button.textContent === t('ares.checking')) button.textContent = t('ares.check');
    }
  };
  void window.api.aresLookup(target.ico, false).then(paint, () => undefined);
  return row;
}

/** Faktura v cizí měně: kurz ČNB ke dni vystavení a částka v Kč (stahuje se jen datum, řádek se ukáže, až kurz přijde). */
function fxRow(card: DocumentCard) {
  const f = card.facts;
  const money = card.type === 'invoice' && f?.amount ? parseMoney(f.amount) : undefined;
  if (!money?.currency || money.currency === 'CZK' || !f?.issued || !/^\d{4}-\d{2}-\d{2}$/.test(f.issued)) return null;
  const issued = f.issued;
  const row = h('div', { class: 'check-row', hidden: true });
  void window.api.fxRate(money.currency, issued).then(
    (rate) => {
      if (!rate) return;
      const total = formatMoney(Math.round(money.value * rate * 100) / 100, 'CZK', locale(), true);
      row.append(h('span', { class: 'check-text' }, t('fx.cnb', { date: day(issued), rate: rate.toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 3 }), total })));
      row.hidden = false;
    },
    () => undefined,
  );
  return row;
}

const linkCount = () => (links ? links.suggestions.length + links.linked.length + links.projects.length : 0);

/** Souvislosti se načítají zvlášť (čtou se vektory knihovny); počet v záložce a termíny se doplní po načtení. */
async function loadLinks() {
  const id = current?.job.id;
  if (!id) return;
  const loaded = await window.api.docLinks(id).catch(() => null);
  if (!loaded || current?.job.id !== id) return;
  links = loaded;
  syncTabs();
  fillDeadlines();
  // Přehled se nepřekresluje, ať nezmizí rozepsaná úprava karty.
  if (tab === 'links' || tab === 'file') void renderBody();
}

function fillDeadlines() {
  if (!deadlineBox || !links) return;
  deadlineBox.hidden = !links.deadlines.length;
  deadlineBox.replaceChildren(
    h('h2', {}, t('info.deadlines')),
    h(
      'div',
      { class: 'dl-mini' },
      ...links.deadlines.map((d) => h('div', { class: d.overdue ? 'overdue' : '' }, h('span', {}, [t(`dl.kind.${d.kind}` as MessageKey), d.detail].filter(Boolean).join(' · ')), h('strong', {}, day(d.date)))),
    ),
  );
}

/** Přehled: u smlouvy rizika, pak karta (shrnutí, údaje, ARES, kurz ČNB), termíny a zvýraznění. */
function overviewView(detail: JobDetail) {
  deadlineBox = h('section', { class: 'setting-group', hidden: true });
  fillDeadlines();
  riskBox = h('section', { class: 'setting-group risks', hidden: true });
  fillRisks();
  const highlights = highlightsSection();
  const nodes: HTMLElement[] = [riskBox, cardSection(detail.job), deadlineBox, ...(highlights ? [highlights] : [])];
  if (detail.job.error) nodes.unshift(h('div', { class: 'error-box' }, detail.job.error));
  return nodes;
}

const SEVERITY_ICON = { high: ICONS.alert, medium: ICONS.alert, low: ICONS.eye } as const;

/** Rizika smlouvy z karty; u jiného typu dokumentu se sekce skryje. Citace vede na místo v textu. */
function fillRisks() {
  if (!riskBox) return;
  const contract = docCard?.type === 'contract';
  riskBox.hidden = !contract;
  if (!contract || !current) return;
  const { job, segments } = current;
  const risks = docCard?.risks;
  const recheck = (label: string) => {
    const button: HTMLButtonElement = smallButton(label, async () => {
      button.textContent = t('risks.checking');
      try {
        docCard = await window.api.checkRisks(job.id);
      } finally {
        button.textContent = label;
      }
      if (current?.job.id !== job.id) return;
      fillRisks();
      renderTitle();
    });
    return button;
  };
  const goTo = (quote: string) => {
    const segment = findQuoteSegment(segments, quote);
    if (segment) showCite(segment);
    else toast(t('risks.notFound'), true);
  };
  if (!risks) {
    riskBox.replaceChildren(h('h2', {}, t('risks.title')), h('div', { class: 'risk-foot' }, h('span', { class: 'muted' }, t('risks.unchecked')), recheck(t('risks.check'))));
    return;
  }
  riskBox.replaceChildren(
    h('h2', {}, t('risks.title')),
    ...(risks.length ? risks.map((r) =>
      h(
        'div',
        { class: `risk ${r.severity}` },
        h('span', { class: 'risk-icon', title: t(`risks.severity.${r.severity}` as MessageKey) }, icon(SEVERITY_ICON[r.severity])),
        h(
          'div',
          { class: 'risk-body' },
          h('strong', {}, r.title),
          h('span', {}, r.why),
          r.tip ? h('span', { class: 'muted' }, r.tip) : null,
          h('button', { class: 'risk-quote', type: 'button', onclick: () => goTo(r.quote) }, `„${r.quote}“`),
        ),
      ),
    ) : [h('p', { class: 'muted' }, t('risks.none'))]),
    h('div', { class: 'risk-foot' }, h('span', { class: 'muted small' }, t('risks.note')), recheck(t('risks.recheck'))),
  );
}

const smallButton = (label: string, run: () => unknown, cls = 'btn') => {
  const button = h('button', { class: cls, type: 'button' }, label);
  button.onclick = async () => {
    button.disabled = true;
    try {
      await run();
    } catch (e) {
      toast(cleanError(e), true);
    } finally {
      button.disabled = false;
    }
  };
  return button;
};

/** Souvislosti: potvrzené a navržené související dokumenty, projekty (zakázky, práce) a Finance u faktury. */
function linksView(): HTMLElement[] {
  if (!links) return [h('p', { class: 'muted' }, t('detail.loading'))];
  const { suggestions, linked, projects } = links;
  const id = current!.job.id;
  const setLink = async (other: string, yes: boolean) => {
    await window.api.linkDocs(id, other, yes);
    await loadLinks();
  };
  const open = (title: string, run: () => void) => h('button', { class: 'link rel-title', type: 'button', title, onclick: run }, title);
  const reason = (d: RelatedDoc) => (d.reason?.kind === 'party' ? t('info.related.party', { party: d.reason.party }) : t('info.related.similar'));
  const out: HTMLElement[] = [];
  if (linked.length || suggestions.length) {
    out.push(
      h(
        'section',
        { class: 'setting-group' },
        h('h2', {}, t('info.related')),
        ...linked.map((d) => h('div', { class: 'rel-item' }, open(d.title, () => host.open(d.id)), h('span', { class: 'muted small' }, t('info.related.linked')), h('div', { class: 'rel-actions' }, smallButton(t('info.related.unlink'), () => setLink(d.id, false))))),
        ...suggestions.map((d) =>
          h(
            'div',
            { class: 'rel-item' },
            open(d.title, () => host.open(d.id)),
            h('span', { class: 'muted small' }, reason(d)),
            h('div', { class: 'rel-actions' }, smallButton(t('info.related.confirm'), () => setLink(d.id, true), 'btn primary'), smallButton(t('info.related.reject'), () => setLink(d.id, false))),
          ),
        ),
        suggestions.length ? h('p', { class: 'muted small' }, t('info.related.hint')) : null,
      ),
    );
  }
  if (projects.length) {
    out.push(h('section', { class: 'setting-group' }, h('h2', {}, t(currentKind() === 'study' ? 'info.projects.study' : 'info.projects.work')), ...projects.map((p) => h('div', { class: 'rel-item' }, open(p.name, () => host.openProject(p.id))))));
  }
  const kind = currentKind();
  if (docCard?.type === 'invoice' && (kind === 'work' || kind === 'general')) {
    out.push(h('section', { class: 'setting-group' }, h('div', { class: 'rel-item' }, h('span', {}, t('info.finance')), h('div', { class: 'rel-actions' }, smallButton(t('info.finance.open'), () => host.showFinance())))));
  }
  if (docCard?.type === 'contract') {
    const versions = linked.filter((d) => d.type === 'contract');
    out.push(
      h(
        'section',
        { class: 'setting-group' },
        h('h2', {}, t('versions.title')),
        ...versions.map((d) => h('div', { class: 'rel-item' }, open(d.title, () => host.open(d.id)), h('div', { class: 'rel-actions' }, smallButton(t('versions.compare'), () => host.openCompare(id, d.id), 'btn primary')))),
        versions.length ? null : h('p', { class: 'muted small' }, t('versions.none')),
        h('div', { class: 'rel-actions' }, smallButton(t('versions.compareOther'), () => pickVersion(id))),
      ),
    );
  }
  return out.length ? out : [h('p', { class: 'muted' }, t('info.empty'))];
}

/** Výběr jiné smlouvy z knihovny k porovnání (s filtrem; Enter vybere první). */
async function pickVersion(id: string) {
  const [jobs, { cards }] = await Promise.all([window.api.listJobs(), window.api.libraryState()]);
  const items = jobs
    .filter((j) => j.id !== id && cards[j.id]?.type === 'contract')
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((j) => {
      const title = docTitle(j, cards[j.id]);
      return { id: j.id, title, date: day(versionDate(j.createdAt, cards[j.id])), key: fold([title, ...(cards[j.id].facts?.parties ?? [])].join(' ')) };
    });
  const input = h('input', { class: 'palette-input', type: 'search', autocomplete: 'off', placeholder: t('versions.filter'), 'aria-label': t('versions.filter') });
  const list = h('div', { class: 'palette-list' });
  let shown = items;
  const pick = (other: string) => {
    close();
    host.openCompare(id, other);
  };
  const draw = () => {
    const query = fold(input.value.trim());
    shown = items.filter((i) => !query || i.key.includes(query));
    list.replaceChildren(
      ...(shown.length
        ? shown.map((i) => h('button', { class: 'palette-item', type: 'button', onclick: () => pick(i.id) }, icon(ICONS.file), h('span', {}, i.title), h('small', { class: 'muted' }, i.date)))
        : [h('div', { class: 'palette-label' }, t(items.length ? 'versions.noMatch' : 'versions.pickEmpty'))]),
    );
  };
  input.addEventListener('input', draw);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && shown[0] && pick(shown[0].id));
  const close = openModal(t('versions.pick'), [input, list], []);
  draw();
  input.focus();
}

const fileSize = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} kB` : `${(bytes / 1024 / 1024).toLocaleString(locale(), { maximumFractionDigits: 1 })} MB`);

async function moveDoc(job: Job) {
  const { library } = await window.api.libraryState();
  chooseFolder((folder) => void window.api.moveToFolder([job.id], folder).then(loadLinks, (e) => toast(cleanError(e), true)), library.folders);
}

/** Soubor: údaje o souboru a jeho akce (existující funkce z hlavičky a nástrojů). */
function fileView(detail: JobDetail): HTMLElement[] {
  const { job } = detail;
  const row = (label: string, value: string | Node) => h('div', { class: 'card-row' }, h('span', { class: 'muted' }, label), value);
  const size = h('span', {}, '…');
  void window.api.jobFileSize(job.id).then((n) => size.replaceChildren(n === undefined ? '–' : fileSize(n)), () => size.replaceChildren('–'));
  const folder = !links
    ? '…'
    : links.folder
      ? h('button', { class: 'link', type: 'button', title: t('info.file.openFolder'), onclick: () => host.openFolder(links!.folder!.id) }, links.folder.path)
      : t('info.file.noFolder');
  const word = job.status === 'done' && job.output ? (translated ? [smallButton(t('info.file.wordTranslation'), () => saveWord(job, 'translation')), smallButton(t('info.file.wordOriginal'), () => saveWord(job, 'original'))] : [smallButton(t('detail.tool.word'), () => saveWord(job, 'original'))]) : [];
  return [
    h(
      'section',
      { class: 'setting-group' },
      h(
        'div',
        { class: 'card-biblio' },
        row(t('info.file.name'), `${job.name}${job.ext}`),
        row(t('info.file.type'), job.ext.slice(1).toUpperCase()),
        row(t('info.file.size'), size),
        ...(job.pages ? [row(t('info.file.pages'), String(job.pages))] : []),
        ...(job.sourceLang === 'auto' ? [] : [row(t('info.file.language'), languageName(job.sourceLang))]),
        row(t('info.file.added'), date(job.createdAt)),
        row(t('info.file.folder'), folder),
        row(t('info.file.translation'), translated ? t('info.file.translated', { lang: languageName(job.targetLang) }) : t('info.file.notTranslated')),
      ),
    ),
    h(
      'div',
      { class: 'file-actions' },
      smallButton(t('info.file.open'), () => window.api.openOutput(job.id, 'input')),
      ...(job.output ? [smallButton(t('detail.saveAs'), () => window.api.saveOutputAs(job.id))] : []),
      ...word,
      smallButton(t('info.file.move'), () => moveDoc(job)),
      smallButton(t('detail.delete'), () => deleteItem(job).run(), 'btn danger'),
    ),
  ];
}

function infoView(detail: JobDetail) {
  const { job, segments } = detail;
  const dl = h('dl', { class: 'info' });
  const row = (k: string, v: string) => dl.append(h('dt', {}, k), h('dd', {}, v));
  row(t('detail.info.file'), `${job.name}${job.ext}`);
  row(t('detail.info.status'), t(STATUS_TEXT[job.status]));
  row(t('detail.info.mode'), `${t(MODES[job.mode].title)} – ${t(MODES[job.mode].desc)}`);
  row(t('detail.info.languages'), langPair(job));
  row(t('detail.info.created'), date(job.createdAt));
  if (jobDuration(job)) row(t('detail.info.duration'), jobDuration(job));
  // Čím se překládalo (staré úlohy model neznají).
  if (job.models) {
    const names = [...new Set(Object.values(job.models))].map((id) => id.split('/').pop()).join(' + ');
    row(t('detail.info.models'), isOnline(job) ? `${t('job.online')} · ${names}` : names);
  }
  if (job.cost) {
    const actual = formatUsd(job.cost);
    row(t('detail.info.cost'), job.costEstimate ? t('detail.info.costWithEstimate', { amount: actual, estimate: formatUsd(job.costEstimate) }) : actual);
  } else if (isOnline(job) && job.costEstimate) row(t('detail.info.costEstimate'), `≈ ${formatUsd(job.costEstimate)}`);
  if (job.pages) row(t('detail.info.pages'), job.pageRange ? t('detail.info.pagesSelection', { pages: job.pages, range: job.pageRange }) : String(job.pages));
  if (job.chars) row(t('detail.info.chars'), job.chars.toLocaleString(locale()));
  row(t('detail.info.paragraphs'), String(visible(segments).length));
  if (job.output) row(t('detail.info.output'), job.outputPdf ? `${job.output}, ${job.outputPdf}` : job.output);
  if (job.context) {
    const c = job.context;
    row(
      t('detail.info.context'),
      t('detail.info.contextText', {
        topic: c.topic || t('detail.info.noTopic'),
        author: c.author || t('detail.info.noAuthor'),
        gender: t(GENDER[c.authorGender]),
      }),
    );
  }
  if (job.notes?.length) row(t('detail.info.notes'), job.notes.join(' '));
  const timings = Object.entries(job.timings ?? {}).filter(([, s]) => s >= 1);
  if (timings.length) {
    row(
      t('detail.info.stages'),
      timings.map(([stage, s]) => `${stageName(stage)}: ${duration(s)}`).join(' · '),
    );
  }
  const box = h('div', { class: 'info-view' }, dl);
  const warned = segments.filter((s) => s.warning);
  if (warned.length) {
    const list = h('ul');
    for (const s of warned) list.append(h('li', {}, s.page ? t('detail.info.warningPage', { page: s.page, text: s.warning! }) : s.warning!));
    box.append(h('div', { class: 'setting-group' }, h('h2', {}, t('detail.info.warnings')), list));
  }
  return box;
}

async function renderBody() {
  if (!current) return;
  const token = ++renderToken;
  renderedTab = null;
  releasePages();
  const body = $('detail-body');
  editing?.cancel();
  body.classList.toggle('regions-hidden', regionsHidden);
  syncTabs();
  const { job, segments } = current;
  deadlineBox = null;
  riskBox = null;
  if (isInfoTab(tab)) {
    body.replaceChildren(h('div', { class: 'info-view detail-pane' }, ...(tab === 'overview' ? overviewView(current) : tab === 'links' ? linksView() : fileView(current))));
    renderedTab = tab;
    $('detail-scroll').scrollTo(0, 0);
    return;
  }
  if (tab === 'original' || tab === 'translated-pdf' || tab === 'side-by-side') {
    body.replaceChildren(h('p', { class: 'muted' }, t('detail.loading')));
    regionLayers = new Map();
    frames = new Map();
    pageWraps = new Map();
    regions = job.ext.toLowerCase() === '.pdf' && tab !== 'translated-pdf' ? await window.api.jobRegions(job.id).catch(() => []) : [];
    try {
      const view =
        tab === 'original'
          ? await originalView(current, token)
          : tab === 'side-by-side'
            ? await sideBySideView(current, token)
            : await pdfView(await window.api.readOutputPdf(job.id), token);
      if (token === renderToken) {
        body.replaceChildren(view);
        renderedTab = tab;
        applyCite();
        paint();
      }
    } catch (e) {
      const what = tab === 'original' ? 'detail.tab.document' : tab === 'side-by-side' ? 'detail.view.sideBySide' : 'detail.translatedPdf';
      if (token === renderToken) body.replaceChildren(h('div', { class: 'error-box' }, t('detail.cannotShow', { what: t(what), error: (e as Error).message })));
    }
    return;
  }
  if (!segments.length) {
    const text =
      job.status === 'done' ? t('detail.noText') : job.status === 'error' ? (job.error ?? t('status.error')) : t('detail.pending');
    return body.replaceChildren(h('p', { class: job.status === 'error' ? 'error-box' : 'empty' }, text));
  }
  if (tab === 'compare' && isPicking()) {
    if (job.status === 'picking' && !picking) startPicking();
    body.replaceChildren(pickView(segments));
    renderedTab = tab;
    return;
  }
  body.replaceChildren(tab === 'compare' ? compareView(visible(segments)) : documentView(visible(segments).filter((s) => !s.skipped), finalText));
  renderedTab = tab;
  applyCite();
  paint();
}

const VIEW_LABELS: Partial<Record<View, MessageKey>> = {
  translation: 'detail.view.text',
  compare: 'detail.tab.compare',
  'translated-pdf': 'detail.view.pdf',
  'side-by-side': 'detail.view.sideBySide',
};

const TAB_LABELS: Record<TopTab, MessageKey> = {
  original: 'detail.tab.document',
  translation: 'detail.tab.translation',
  overview: 'info.tab.overview',
  links: 'info.tab.links',
  file: 'info.tab.file',
};

/** Řada záložek; v záložce Překlad vpravo přepínač pohledů a odkaz na místa ke kontrole. */
function syncTabs() {
  if (!current) return;
  const { job } = current;
  const top = topTab(tab);
  $('detail-tabs').replaceChildren(
    ...topTabs(translated).map((k) =>
      h(
        'button',
        { class: `tab${k === top ? ' active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(k === top), onclick: () => void go(k === 'translation' ? lastSub : k) },
        t(TAB_LABELS[k]),
        k === 'links' && linkCount() ? h('span', { class: 'tab-count' }, String(linkCount())) : null,
      ),
    ),
  );
  const end = $('detail-tab-end');
  end.hidden = top !== 'translation';
  if (end.hidden) return end.replaceChildren();
  lastSub = tab as View;
  const choices = translationViews(Boolean(job.outputPdf)).map((view) =>
    h('button', { class: `segment${view === tab ? ' active' : ''}`, type: 'button', onclick: () => void go(view) }, t(VIEW_LABELS[view]!)),
  );
  end.replaceChildren(
    ...(job.warnings ? [h('button', { class: 'chip warn review-chip', type: 'button', onclick: () => void showWarnings() }, t('detail.toReview', { count: job.warnings }))] : []),
    h('div', { class: 'segmented', role: 'group', 'aria-label': t('detail.tab.translation') }, ...choices),
  );
}

/** Odznak v hlavičce: přepne na Přehled a ukáže sekci rizik. */
async function showRisks() {
  await go('overview');
  riskBox?.scrollIntoView({ block: 'start' });
}

function renderTitle() {
  if (!current) return;
  const { job } = current;
  $('detail-name').textContent = docTitle(job, docCard);
  $('detail-name').title = `${job.name}${job.ext}`;
  const warnings = docCard?.risks?.filter((r) => r.severity !== 'low').length ?? 0;
  const pill = h('button', { class: 'chip warn risk-pill', type: 'button', onclick: () => void showRisks() }, icon(ICONS.alert), t('risks.pill', { count: warnings }));
  $('detail-type').replaceChildren(...(docCard ? [h('span', { class: 'chip accent' }, t(`docType.${docCard.type}` as MessageKey))] : []), ...(warnings ? [pill] : []));
}

function renderHeader() {
  if (!current) return;
  const { job } = current;
  translated = isTranslated(job, current.segments);
  tab = usableView(tab, translated, Boolean(job.outputPdf));
  renderTitle();
  // Hotový dokument stavový štítek nepotřebuje, ukazuje se jen průběh a chyba.
  $('detail-status').replaceChildren(...(job.status === 'done' ? [] : [statusChip(job)]));
  $('detail-actions').replaceChildren(...actions(job));
  syncTabs();
  renderProgress(job);
}

export async function openDetail(id: string, initialTab?: Tab) {
  const detail = await window.api.getJob(id);
  if (!detail) return false;
  current = detail;
  docCard = await window.api.getCard(id).catch(() => null);
  clearCite();
  await loadHighlights(id);
  showChat(detail.job);
  tab = initialTab ?? defaultTab(docCard?.type, isTranslated(detail.job, detail.segments));
  picking = false;
  links = null;
  const settings = await window.api.getSettings().catch(() => undefined);
  ownCompany = settings?.ownCompany;
  citeStyle = settings?.citation.style ?? 'iso690';
  renderHeader();
  void loadLinks();
  await renderBody();
  return true;
}

/** Živá aktualizace: hlavička hned, obsah až po dokončení (segmenty se ukládají na konci). */
export async function updateDetail(job: Job) {
  if (!current || current.job.id !== job.id) return;
  const changed = current.job.status !== job.status;
  const finished = changed && !['running', 'queued'].includes(job.status);
  current.job = job;
  if (changed && (job.status === 'queued' || job.status === 'running')) {
    picking = false;
    renderHeader();
    return renderBody();
  }
  renderHeader();
  if (finished) {
    picking = false;
    const detail = await window.api.getJob(job.id);
    if (detail) current = detail;
    docCard = (await window.api.getCard(job.id).catch(() => null)) ?? docCard;
    renderHeader();
    void loadLinks();
    await renderBody();
  }
}

/** Textové zobrazení, ve kterém jde označovat (PDF a výběr odstavců ne). */
const textView = () =>
  !isPicking() && (renderedTab === 'compare' || renderedTab === 'translation' || (renderedTab === 'original' && current?.job.ext.toLowerCase() !== '.pdf'));

function toggleRegions() {
  regionsHidden = !regionsHidden;
  try {
    localStorage.setItem(HIDE_KEY, regionsHidden ? '1' : '0');
  } catch {}
  editing?.cancel();
  $('detail-body').classList.toggle('regions-hidden', regionsHidden);
}

export function setupDetail(onBack: () => void, openSettings: () => void, detailHost: DetailHost) {
  host = detailHost;
  setupChat({ segments: () => current?.segments ?? [], cite: showCite, openSettings });
  setupPdfZoom();
  setupHighlights({
    body: $('detail-body'),
    current: () => current,
    textView,
    pageWraps: () => pageWraps,
    showCompare: () => void go('compare'),
    changed: () => {
      if (tab === 'overview') void renderBody();
    },
  });
  $('detail-back').addEventListener('click', onBack);
  document.addEventListener('click', () => {
    for (const m of document.querySelectorAll<HTMLElement>('.menu')) m.hidden = true;
  });
}

export function closeDetail() {
  editing?.cancel();
  current = null;
  renderToken++;
  releasePages();
  clearCite();
  resetHighlights();
  resetChat();
  links = null;
  deadlineBox = null;
}
