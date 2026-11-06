import { t, type MessageKey } from '../shared/i18n';
import { HIGHLIGHT_COLORS, locate, sliceTexts, sortHighlights, squeezedOffset } from '../shared/highlights';
import type { Highlight, HighlightColor, JobDetail } from '../shared/types';
import { cleanError, h, icon, ICONS, toast, toastAction } from './dom';

/** Co zvýraznění potřebují od detailu dokumentu. */
export interface HighlightCtx {
  body: HTMLElement;
  current(): JobDetail | null;
  /** Je vykreslené textové zobrazení, ve kterém jde označovat (ne výběr odstavců ani PDF). */
  textView(): boolean;
  /** Vykreslené stránky PDF podle čísla (prázdné u textových zobrazení). */
  pageWraps(): Map<number, HTMLElement[]>;
  /** Přepne na Srovnání a po vykreslení zavolá `paint`. */
  showCompare(): void;
  /** Počet nebo skrytí se změnily (tlačítko v hlavičce). */
  changed(): void;
}

const HIDE_KEY = 'highlightsHidden';
const FLASH_MS = 1600;

let ctx: HighlightCtx | null = null;
let jobId = '';
let list: Highlight[] = [];
let saving: Promise<unknown> = Promise.resolve();
let pop: HTMLElement | null = null;
let focusId = '';
let hidden = (() => {
  try {
    return localStorage.getItem(HIDE_KEY) === '1';
  } catch {
    return false;
  }
})();

export const highlightCount = () => list.length;
export const highlightsHidden = () => hidden;

/** Zvýraznění otevřeného dokumentu (u chyby čtení prázdné, detail se musí otevřít). */
export async function loadHighlights(id: string) {
  jobId = id;
  list = [];
  hidePop();
  list = await window.api.jobHighlights(id).catch(() => []);
}

export function resetHighlights() {
  jobId = '';
  list = [];
  hidePop();
}

function persist(next: Highlight[]) {
  const id = jobId;
  list = next;
  paint();
  ctx?.changed();
  saving = saving.then(() => window.api.saveHighlights(id, next).catch((e) => toast(cleanError(e), true)));
}

export function setHidden(value: boolean) {
  hidden = value;
  try {
    localStorage.setItem(HIDE_KEY, value ? '1' : '0');
  } catch {}
  hidePop();
  ctx?.body.classList.toggle('highlights-hidden', hidden);
  ctx?.changed();
}

const colorName = (c: HighlightColor) => t(`highlight.color.${c}` as MessageKey);

/** Prvky segmentů jedné strany v pořadí dokumentu. */
const sideEls = (side: Highlight['side']) => [...(ctx?.body.querySelectorAll<HTMLElement>(`[data-seg][data-side="${side}"]`) ?? [])];

/** Obalí znaky [start, end) textu prvku do značky (přes hranice vnořených prvků i jiných značek). */
function wrap(el: HTMLElement, start: number, end: number, make: () => HTMLElement) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  let pos = 0;
  for (const node of nodes) {
    const len = node.data.length;
    const [a, b] = [Math.max(start, pos), Math.min(end, pos + len)];
    pos += len;
    if (a >= b) continue;
    let part = node;
    if (a > pos - len) part = part.splitText(a - (pos - len));
    if (b - a < part.data.length) part.splitText(b - a);
    const mark = make();
    part.replaceWith(mark);
    mark.append(part);
  }
}

function unpaint() {
  const body = ctx?.body;
  if (!body) return;
  for (const box of body.querySelectorAll('.hl-box')) box.remove();
  for (const mark of body.querySelectorAll('mark.hl')) mark.replaceWith(...mark.childNodes);
  body.normalize();
}

const markEl = (hl: Highlight) => {
  const attrs: Record<string, string> = { class: `hl hl-${hl.color}${hl.note ? ' has-note' : ''}`, 'data-hl': hl.id };
  if (hl.note) attrs.title = hl.note;
  return h('mark', attrs);
};

function paintText(hl: Highlight) {
  const els = sideEls(hl.side);
  const ids = els.map((el) => Number(el.dataset.seg));
  const [a, b] = [ids.indexOf(hl.from), ids.indexOf(hl.to)];
  if (a < 0 || b < a) return;
  const span = els.slice(a, b + 1);
  const found = locate(span.map((el) => el.textContent ?? ''), hl.quote, hl.hint);
  if (!found) return;
  const [[si, so], [ei, eo]] = [found.start, found.end];
  for (let i = si; i <= ei; i++) wrap(span[i], i === si ? so : 0, i === ei ? eo : Infinity, () => markEl(hl));
}

/** V PDF jen rámeček přes plochy segmentů (text stránky se označit nedá). */
function paintPdf(hl: Highlight, wraps: Map<number, HTMLElement[]>) {
  const segments = ctx?.current()?.segments ?? [];
  const ids = segments.map((s) => s.id);
  const [a, b] = [ids.indexOf(hl.from), ids.indexOf(hl.to)];
  if (a < 0 || b < a) return;
  for (const s of segments.slice(a, b + 1)) {
    for (const rect of s.rects ?? []) {
      for (const page of wraps.get(rect.page) ?? []) {
        const { pw, ph } = (page.firstElementChild as HTMLElement).dataset;
        if (!pw || !ph) continue;
        const box = h('div', { class: `hl-box hl-${hl.color}`, 'data-hl': hl.id });
        box.style.left = `${(rect.x / +pw) * 100}%`;
        box.style.top = `${(rect.y / +ph) * 100}%`;
        box.style.width = `${(rect.w / +pw) * 100}%`;
        box.style.height = `${(rect.h / +ph) * 100}%`;
        page.append(box);
      }
    }
  }
}

/** Překreslí zvýraznění v právě vykresleném zobrazení; po skoku z přehledu najede na vybrané. */
export function paint() {
  if (!ctx) return;
  unpaint();
  ctx.body.classList.toggle('highlights-hidden', hidden);
  const wraps = ctx.pageWraps();
  if (ctx.textView()) for (const hl of list) paintText(hl);
  else if (wraps.size) for (const hl of list) paintPdf(hl, wraps);
  if (!focusId) return;
  const target = ctx.body.querySelector<HTMLElement>(`[data-hl="${focusId}"]`);
  if (!target) return;
  focusId = '';
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const marks = ctx.body.querySelectorAll<HTMLElement>(`[data-hl="${target.dataset.hl}"]`);
  for (const m of marks) m.classList.add('hl-flash');
  setTimeout(() => marks.forEach((m) => m.classList.remove('hl-flash')), FLASH_MS);
}

/** Výběr textu v jednom zobrazení a na jedné straně → nové zvýraznění (bez barvy a času). */
function readSelection(): Omit<Highlight, 'id' | 'color' | 'createdAt' | 'updatedAt'> | null {
  const sel = window.getSelection();
  const detail = ctx?.current();
  if (!ctx || !detail || !ctx.textView() || !sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const cell = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-seg][data-side]') ?? null;
  const [fromEl, toEl] = [cell(range.startContainer), cell(range.endContainer)];
  if (!fromEl || !toEl || !ctx.body.contains(fromEl) || fromEl.dataset.side !== toEl.dataset.side) return null;
  const side = fromEl.dataset.side as Highlight['side'];
  const els = sideEls(side);
  const [a, b] = [els.indexOf(fromEl), els.indexOf(toEl)];
  if (a < 0 || b < a) return null;
  const offset = (el: HTMLElement, node: Node, at: number) => {
    const r = document.createRange();
    r.setStart(el, 0);
    r.setEnd(node, at);
    return r.toString().length;
  };
  const span = els.slice(a, b + 1);
  const texts = span.map((el) => el.textContent ?? '');
  const start = offset(fromEl, range.startContainer, range.startOffset);
  const end = offset(toEl, range.endContainer, range.endOffset);
  const quote = sliceTexts(texts, [0, start], [span.length - 1, end]).trim();
  if (!quote) return null;
  const from = Number(fromEl.dataset.seg);
  return { side, from, to: Number(toEl.dataset.seg), quote, hint: squeezedOffset(texts[0], start), page: detail.segments.find((s) => s.id === from)?.page };
}

function hidePop() {
  pop?.remove();
  pop = null;
}

function place(el: HTMLElement, anchor: DOMRect) {
  document.body.append(el);
  const { width, height } = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))}px`;
  const below = anchor.bottom + 6;
  el.style.top = `${below + height > window.innerHeight - 8 ? Math.max(8, anchor.top - height - 6) : below}px`;
}

const keep = (el: HTMLElement) => (el.addEventListener('mousedown', (e) => e.target instanceof HTMLTextAreaElement || e.preventDefault()), el);

function swatches(active: HighlightColor | undefined, pick: (c: HighlightColor) => void) {
  return HIGHLIGHT_COLORS.map((c) =>
    h('button', { type: 'button', class: `hl-swatch hl-${c}${c === active ? ' active' : ''}`, title: colorName(c), 'aria-label': colorName(c), onclick: () => pick(c) }),
  );
}

function noteEditor(hl: Highlight, anchor: DOMRect) {
  hidePop();
  const area = h('textarea', { class: 'hl-note-input', rows: '4', placeholder: t('highlight.notePlaceholder') }) as HTMLTextAreaElement;
  area.value = hl.note ?? '';
  const save = () => {
    hidePop();
    const note = area.value.trim() || undefined;
    if (note === hl.note) return;
    persist(list.map((x) => (x.id === hl.id ? { ...x, note, updatedAt: Date.now() } : x)));
  };
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
    if (e.key === 'Escape') hidePop();
  });
  pop = keep(
    h(
      'div',
      { class: 'hl-pop hl-pop-note', role: 'dialog', 'aria-label': t('highlight.note') },
      area,
      h('div', { class: 'hl-pop-actions' }, h('button', { class: 'btn', type: 'button', onclick: hidePop }, t('highlight.cancel')), h('button', { class: 'btn primary', type: 'button', onclick: save }, t('highlight.save'))),
    ),
  );
  place(pop, anchor);
  area.focus();
}

function create(color: HighlightColor, withNote: boolean) {
  const found = readSelection();
  if (!found) return hidePop();
  const anchor = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
  const now = Date.now();
  const hl: Highlight = { id: crypto.randomUUID(), color, createdAt: now, updatedAt: now, ...found };
  window.getSelection()?.removeAllRanges();
  hidePop();
  if (hidden) setHidden(false);
  persist(sortHighlights([...list, hl], ctx?.current()?.segments.map((s) => s.id) ?? []));
  if (withNote) noteEditor(hl, anchor);
}

function selectionPop() {
  hidePop();
  if (!readSelection()) return;
  const range = window.getSelection()!.getRangeAt(0);
  const rects = range.getClientRects();
  pop = keep(
    h(
      'div',
      { class: 'hl-pop', role: 'toolbar', 'aria-label': t('highlight.toolbar') },
      ...swatches(undefined, (c) => create(c, false)),
      h('button', { type: 'button', class: 'btn hl-pop-btn', title: t('highlight.addNote'), onclick: () => create('yellow', true) }, icon(ICONS.chat), t('highlight.note')),
    ),
  );
  place(pop, rects[rects.length - 1] ?? range.getBoundingClientRect());
}

function remove(id: string) {
  const before = list;
  persist(list.filter((x) => x.id !== id));
  toastAction(t('highlight.deleted'), t('highlight.undo'), () => persist(before));
}

/** Klik na zvýraznění v textu: barva, poznámka, smazání. */
function editPop(hl: Highlight, anchor: DOMRect) {
  hidePop();
  const recolor = (color: HighlightColor) => {
    hidePop();
    if (color !== hl.color) persist(list.map((x) => (x.id === hl.id ? { ...x, color, updatedAt: Date.now() } : x)));
  };
  pop = keep(
    h(
      'div',
      { class: 'hl-pop', role: 'toolbar', 'aria-label': t('highlight.toolbar') },
      ...swatches(hl.color, recolor),
      h('button', { type: 'button', class: 'btn hl-pop-btn', onclick: () => noteEditor(hl, anchor) }, icon(ICONS.chat), t(hl.note ? 'highlight.editNote' : 'highlight.note')),
      h('button', { type: 'button', class: 'btn hl-pop-btn', title: t('highlight.delete'), 'aria-label': t('highlight.delete'), onclick: () => (hidePop(), remove(hl.id)) }, icon(ICONS.trash)),
    ),
  );
  if (hl.note) pop.prepend(h('p', { class: 'hl-pop-text' }, hl.note));
  place(pop, anchor);
}

/** Přehled v záložce Informace: skok na místo, smazání jednoho i všech, skrytí. */
export function highlightsSection() {
  const box = h('div', { class: 'setting-group hl-overview' });
  const detail = ctx?.current();
  if (!detail) return box;
  const head = h('div', { class: 'hl-overview-head' }, h('h2', {}, t('highlight.overview', { count: list.length })));
  box.append(head);
  if (!list.length) {
    box.append(h('p', { class: 'muted' }, t('highlight.empty')));
    return box;
  }
  head.append(
    h('button', { class: 'btn', type: 'button', onclick: () => setHidden(!hidden) }, icon(hidden ? ICONS.eyeOff : ICONS.eye), t(hidden ? 'highlight.show' : 'highlight.hide')),
    h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => {
        const before = list;
        persist([]);
        toastAction(t('highlight.deletedAll', { count: before.length }), t('highlight.undo'), () => persist(before));
      },
    }, icon(ICONS.trash), t('highlight.deleteAll')),
  );
  const ul = h('ul', { class: 'hl-list' });
  for (const hl of list) {
    const where = [hl.page ? t('detail.page', { page: hl.page }) : '', t(hl.side === 'source' ? 'highlight.source' : 'highlight.target')].filter(Boolean).join(' · ');
    const open = h(
      'button',
      { type: 'button', class: 'hl-item', title: t('highlight.jump'), onclick: () => ((focusId = hl.id), ctx?.showCompare()) },
      h('span', { class: `hl-dot hl-${hl.color}`, 'aria-label': colorName(hl.color) }),
      h('span', { class: 'hl-item-text' }, h('q', {}, hl.quote), hl.note ? h('span', { class: 'hl-item-note' }, hl.note) : null, h('small', { class: 'muted' }, where)),
    );
    const del = h('button', { type: 'button', class: 'btn icon-only', title: t('highlight.delete'), 'aria-label': t('highlight.delete'), onclick: () => remove(hl.id) }, icon(ICONS.trash));
    ul.append(h('li', {}, open, del));
  }
  box.append(ul);
  return box;
}

export function setupHighlights(c: HighlightCtx) {
  ctx = c;
  c.body.addEventListener('mouseup', () =>
    setTimeout(() => {
      if (window.getSelection()?.isCollapsed === false) selectionPop();
    }),
  );
  c.body.addEventListener('click', (e) => {
    if (hidden || window.getSelection()?.isCollapsed === false) return;
    const mark = (e.target as Element).closest<HTMLElement>('mark.hl');
    const hl = mark && list.find((x) => x.id === mark.dataset.hl);
    if (hl) editPop(hl, mark.getBoundingClientRect());
  });
  c.body.addEventListener('keyup', (e) => e.shiftKey && selectionPop());
  document.addEventListener('mousedown', (e) => pop && !pop.contains(e.target as Node) && hidePop());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && pop && !pop.classList.contains('hl-pop-note') && hidePop());
  document.addEventListener('scroll', (e) => pop && !pop.contains(e.target as Node) && hidePop(), true);
  window.addEventListener('resize', hidePop);
}
