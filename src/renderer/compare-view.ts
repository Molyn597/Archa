import { changeCount, type DiffPart, type DiffRow, type DiffSection } from '../shared/contract-diff';
import { docTitle } from '../shared/doc-title';
import { t } from '../shared/i18n';
import { day, isoDay } from '../shared/invoices';
import type { ChangeSummary, CompareResult, Job } from '../shared/types';
import { actionMenu, cleanError, h, helpTip, icon, toast } from './dom';

export interface CompareHost {
  /** Zpět na detail dokumentu, ze kterého se porovnání otevřelo. */
  back(): void;
}

const BACK = '<path d="M15 6l-6 6 6 6" />';
const SWAP = '<path d="M4 7h16M16 3l4 4-4 4M20 17H4M8 13l-4 4 4 4" />';
const PILL: Record<Exclude<DiffRow['kind'], 'same'>, string> = { chg: 'warn', add: 'ok', del: 'err' };
/** Delší úsek nezměněných odstavců se sbalí. */
const FOLD_MIN = 4;
const EXCERPT = 90;
const FLASH_MS = 1600;

let root: HTMLElement;
let host: CompareHost;
let state: CompareResult | null = null;
// Rozpracované shrnutí AI (dvojice „a|b“), aby se po návratu na stránku ukázalo, že běží.
const running = new Set<string>();

export function setupCompare(el: HTMLElement, compareHost: CompareHost) {
  root = el;
  host = compareHost;
}

/** Načte porovnání a vykreslí ho; chyba = oznámení a false. */
export async function openCompare(aId: string, bId: string, keepOrder = false) {
  try {
    state = await window.api.compareDocs(aId, bId, keepOrder);
  } catch (e) {
    toast(cleanError(e), true);
    return false;
  }
  render();
  return true;
}

const pairKey = (r: CompareResult) => `${r.a.job.id}|${r.b.job.id}`;
const added = (job: Job) => day(isoDay(new Date(job.createdAt)));
const cut = (s: string) => (s.length > EXCERPT ? `${s.slice(0, EXCERPT - 1).trimEnd()}…` : s);
const sectionTitle = (s: DiffSection) => s.title || t('compare.preamble');

function partsEl(parts: DiffPart[]) {
  return h('div', {}, ...parts.map((p) => (p.kind === 'same' ? p.text : h(p.kind, {}, p.text))));
}

function sideEl(row: DiffRow, side: 'a' | 'b') {
  const text = side === 'a' ? row.a : row.b;
  if (text === undefined) return h('div', {}, h('span', { class: 'gap' }, t('compare.missing')));
  if (row.kind === 'same') return h('div', {}, text);
  const parts = side === 'a' ? row.aParts : row.bParts;
  return partsEl(parts ?? [{ text, kind: side === 'a' ? 'del' : 'ins' }]);
}

/** Krátký výňatek změny pro seznam: u změny jen změněná slova (staré → nové). */
function excerpt(row: DiffRow) {
  if (row.kind !== 'chg') return cut(row.a ?? row.b ?? '');
  const pick = (parts: DiffPart[] | undefined, kind: DiffPart['kind']) => (parts ?? []).filter((p) => p.kind === kind).map((p) => p.text.trim()).join(' … ');
  const [before, after] = [pick(row.aParts, 'del'), pick(row.bParts, 'ins')];
  return cut(before && after ? `${before} → ${after}` : before || after || (row.b ?? ''));
}

function render() {
  if (!state) return;
  const { a, b, sections } = state;
  const count = changeCount(sections);
  const [titleA, titleB] = [docTitle(a.job, a.card), docTitle(b.job, b.card)];
  const head = h(
    'header',
    { class: 'cmp-head' },
    h('button', { class: 'icon-btn', type: 'button', title: t('detail.back'), 'aria-label': t('detail.back'), onclick: () => host.back() }, icon(BACK)),
    h('div', { class: 'cmp-ttl' }, h('div', { class: 'cmp-meta' }, h('span', { class: 'chip accent' }, t('compare.title')), count ? h('span', {}, t('compare.count', { count })) : null), h('h1', {}, titleA)),
    actionMenu(() => [{ label: t('compare.swap'), icon: SWAP, run: () => openCompare(b.job.id, a.job.id, true) }]),
  );
  const heads = h('div', { class: 'cmp-heads' }, h('span', {}, t('compare.head', { title: titleA, date: added(a.job) })), h('span', {}, t('compare.head', { title: titleB, date: added(b.job) })));
  if (!count) {
    root.replaceChildren(h('div', { class: 'cmp-page' }, head, h('div', { class: 'cmpdoc' }, heads, h('p', { class: 'empty' }, t('compare.same')))));
    return;
  }

  const rowEls = new Map<DiffRow, HTMLElement>();
  const rowEl = (r: DiffRow) => {
    const el = h('div', { class: `cmp-p ${r.kind === 'same' ? 'same' : `k-${r.kind}`}` }, sideEl(r, 'a'), sideEl(r, 'b'));
    rowEls.set(r, el);
    return el;
  };
  const rowsEls = (rows: DiffRow[]) => {
    const out: HTMLElement[] = [];
    for (let i = 0; i < rows.length; ) {
      let end = i;
      while (end < rows.length && rows[end].kind === 'same') end++;
      if (end - i >= FOLD_MIN) {
        const run = rows.slice(i, end);
        const fold: HTMLElement = h('button', { class: 'cmp-fold', type: 'button', onclick: () => fold.replaceWith(...run.map(rowEl)) }, t('compare.sameRun', { count: run.length }));
        out.push(fold);
        i = end;
      } else out.push(rowEl(rows[i++]));
    }
    return out;
  };
  const doc = h('div', { class: 'cmpdoc' }, heads, ...sections.flatMap((s) => [h('h3', {}, sectionTitle(s)), ...rowsEls(s.rows)]));

  const go = (r: DiffRow) => {
    const el = rowEls.get(r);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), FLASH_MS);
  };
  const changes = sections.flatMap((s) => s.rows.filter((r) => r.kind !== 'same').map((r) => ({ s, r })));
  const list = h(
    'section',
    { class: 'ov-card' },
    h('h2', {}, t('compare.changes'), helpTip(t('compare.changesHint'))),
    h(
      'div',
      { class: 'chglist' },
      ...changes.map(({ s, r }) =>
        h(
          'button',
          { type: 'button', onclick: () => go(r) },
          h('span', { class: `chip ${PILL[r.kind as keyof typeof PILL]}` }, t(`compare.kind.${r.kind as keyof typeof PILL}`)),
          h('strong', {}, sectionTitle(s)),
          h('span', { class: 's' }, excerpt(r)),
        ),
      ),
    ),
  );
  const ai = h('section', { class: 'ov-card cmp-ai' });
  fillAi(ai, state);

  root.replaceChildren(h('div', { class: 'cmp-page' }, head, h('div', { class: 'cmpgrid' }, doc, h('div', { class: 'side-col' }, list, ai))));
}

/** Karta Shrnutí AI: uložené shrnutí hned, nové jen na klik (model se jinak nespouští). */
function fillAi(box: HTMLElement, r: CompareResult) {
  const key = pairKey(r);
  const busy = running.has(key);
  const run = async (force: boolean) => {
    running.add(key);
    fillAi(box, r);
    let summary: ChangeSummary | undefined;
    try {
      summary = await window.api.summarizeChanges(r.a.job.id, r.b.job.id, force);
    } catch (e) {
      toast(cleanError(e), true);
    } finally {
      running.delete(key);
    }
    if (summary) r.summary = summary;
    // Mezitím se mohlo otevřít jiné porovnání nebo prohodit strany.
    if (state === r) fillAi(box, r);
  };
  const s = r.summary;
  const button = h('button', { class: 'btn primary', type: 'button', disabled: busy, onclick: () => void run(!!s) }, busy ? h('span', { class: 'chat-spin' }) : null, t(busy ? 'compare.summarizing' : s ? 'compare.again' : 'compare.summarize'));
  box.replaceChildren(
    h('h2', {}, t('compare.ai'), helpTip(t('compare.aiNote'))),
    ...(s && !busy
      ? [
          ...(s.summary ? [h('p', {}, s.summary)] : []),
          ...s.changes.map((c) =>
            h(
              'div',
              { class: 'cmp-sum' },
              h('strong', {}, c.title),
              c.before || c.after ? h('span', {}, [c.before, c.after].filter(Boolean).join(' → ')) : null,
              c.impact ? h('span', { class: 'muted' }, c.impact) : null,
            ),
          ),
        ]
      : []),
    h('div', { class: 'cmp-ai-foot' }, button),
  );
}
