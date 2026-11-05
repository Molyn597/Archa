import { t } from '../shared/i18n';
import type { Job, Segment } from '../shared/types';
import { copyWithCitation, citationEnabled } from './citation-copy';
import { h, icon, ICONS } from './dom';

/** Plovoucí tlačítko „Kopírovat s citací“ u konce výběru textu v těle detailu (prvky s data-seg a data-side). */
export function setupSelectionCite(body: HTMLElement, current: () => { job: Job; segments: Segment[] } | null) {
  let pop: HTMLButtonElement | null = null;
  let picked: { quote: string; pages: number[]; translated: boolean } | null = null;

  const hide = () => {
    pop?.remove();
    pop = null;
  };

  const cell = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-seg]') ?? null;

  /** Výběr uvnitř těla: citovaný text, strany jeho segmentů a strana (originál/překlad). */
  function readSelection() {
    const sel = window.getSelection();
    const ctx = current();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !ctx) return null;
    const range = sel.getRangeAt(0);
    const [from, to] = [cell(range.startContainer), cell(range.endContainer)];
    if (!from || !to || !body.contains(from) || !body.contains(to) || !from.dataset.side) return null;
    const ids = ctx.segments.map((s) => s.id);
    const [a, b] = [ids.indexOf(Number(from.dataset.seg)), ids.indexOf(Number(to.dataset.seg))];
    if (a < 0 || b < 0) return null;
    const pages = ctx.segments.slice(Math.min(a, b), Math.max(a, b) + 1).flatMap((s) => (s.page ? [s.page] : []));
    const quote = sel.toString().replace(/\s+/g, ' ').trim();
    return quote ? { quote, pages, translated: from.dataset.side === 'target', range } : null;
  }

  function update() {
    hide();
    const found = citationEnabled() ? readSelection() : null;
    if (!found) return;
    picked = found;
    const rects = found.range.getClientRects();
    const end = rects[rects.length - 1] ?? found.range.getBoundingClientRect();
    pop = h('button', { class: 'cite-pop', onclick: copy }, icon(ICONS.copy), t('citation.copy'));
    // Mousedown nesmí zrušit výběr, jinak by nebylo co kopírovat.
    pop.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.append(pop);
    const { width, height } = pop.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(end.right - width, window.innerWidth - width - 8))}px`;
    pop.style.top = `${Math.min(end.bottom + 6, window.innerHeight - height - 8)}px`;
  }

  function copy() {
    const ctx = current();
    if (!picked || !ctx) return;
    const { quote, pages, translated } = picked;
    hide();
    void copyWithCitation(ctx.job.id, ctx.job, { quote, pdfPages: pages, translated });
  }

  body.addEventListener('mouseup', () => setTimeout(update));
  body.addEventListener('keyup', (e) => e.shiftKey && update());
  document.addEventListener('selectionchange', () => window.getSelection()?.isCollapsed && hide());
  document.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
}
