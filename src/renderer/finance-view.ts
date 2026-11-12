import { docTitle } from '../shared/doc-title';
import { flowRows, hasOwnCompany, monthRange, monthTotals, periodSums, primaryCurrency, timelineItems, topSuppliers, type FlowRow, type MonthTotal, type TimelineItem } from '../shared/finance';
import { locale, t, type MessageKey } from '../shared/i18n';
import { day, invoiceRows, isoDay } from '../shared/invoices';
import { formatMoney } from '../shared/money';
import type { DocumentCard, Job, OwnCompany } from '../shared/types';
import { h, icon, ICONS } from './dom';

export interface FinanceCtx {
  jobs: Job[];
  cards: Record<string, DocumentCard>;
  paid: Record<string, number> | undefined;
  /** Moje firma z nastavení knihovny (bez ní se vlastní firma odhaduje). */
  own: OwnCompany | undefined;
  open(jobId: string): void;
  /** Otevře Nastavení › Knihovna. */
  showSettings(): void;
  /** Otevře seznam faktur. */
  showInvoices(): void;
  /** Otevře stránku Finance. */
  showFinance(): void;
}

const NS = 'http://www.w3.org/2000/svg';

/** SVG element; text jde vždy přes textContent. */
function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number | ((e: Event) => void)> = {}, ...children: (Node | string | false)[]) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'function') el.addEventListener(key.replace(/^on/, ''), value);
    else el.setAttribute(key, String(value));
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

// Velké částky (součty, karta v Přehledu) bez desetinných míst, když jsou celé.
const fmt = (value: number, currency: string, trimWhole = false) => formatMoney(value, currency, locale(), trimWhole);
const monthDate = (m: string) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1);
const monthName = (m: string, style: 'long' | 'short') => monthDate(m).toLocaleDateString(locale(), { month: style });
const cap = (text: string) => text.charAt(0).toLocaleUpperCase(locale()) + text.slice(1);

/** Faktury posledních 6 měsíců se směrem příjem / výdaj a měna, ve které se kreslí grafy. */
function financeData(ctx: Pick<FinanceCtx, 'jobs' | 'cards' | 'paid' | 'own'>, today: string) {
  const all = flowRows(invoiceRows(ctx.jobs, ctx.cards, ctx.paid, today), ctx.own);
  const months = monthRange(today, 5);
  const rows = all.filter((r) => r.issued && months.includes(r.issued.slice(0, 7)));
  return { all, rows, months, currency: primaryCurrency(rows) };
}

/** Nenápadná výzva k vyplnění Moje firma (bez ní se příjmy a výdaje jen odhadují). */
const ownHint = (ctx: FinanceCtx) =>
  h('button', { class: 'ov-link fin-own', type: 'button', title: t('fin.ownHint'), onclick: (e) => { e.stopPropagation(); ctx.showSettings(); } }, t('fin.setOwn'));

/** Malá karta Finance pro Přehled: výdaje a příjmy tohoto měsíce a sloupky posledních 6 měsíců. Bez faktur nic. */
export function financeMini(ctx: FinanceCtx): HTMLElement | null {
  const today = isoDay();
  const { all, rows, months, currency } = financeData(ctx, today);
  if (!all.length) return null;
  const data = monthTotals(rows, months, currency);
  const last = data[data.length - 1]!;
  const W = 200;
  const H = 64;
  const bw = 9;
  const gw = W / data.length;
  const max = Math.max(1, ...data.flatMap((d) => [d.expense, d.income]));
  const bar = (x: number, v: number, cls: string) => {
    const bh = Math.max(1.5, ((H - 4) * v) / max);
    return s('rect', { class: cls, x, y: H - bh, width: bw, height: bh, rx: 2 });
  };
  const chart = s('svg', { viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' }, ...data.flatMap((d, i) => [bar(gw * i + gw / 2 - bw - 1, d.expense, 'fin-b-exp'), bar(gw * i + gw / 2 + 1, d.income, 'fin-b-inc')]));
  const num = (key: 'expense' | 'income') =>
    h('div', {}, h('div', { class: 'fin-l' }, h('i', { class: key === 'income' ? 'fin-sw-inc' : 'fin-sw-exp' }), `${t(`fin.${key}` as MessageKey)} · ${monthName(last.month, 'long')}`), h('div', { class: 'fin-v' }, fmt(last[key], currency, true)));
  return h(
    'section',
    { class: 'ov-card fin-mini', role: 'button', tabindex: '0', 'aria-label': t('fin.title'), onclick: ctx.showFinance, onkeydown: (e) => (e as KeyboardEvent).key === 'Enter' && ctx.showFinance() },
    h('h2', {}, `${t('fin.title')} · ${t('fin.last6')}`, h('span', { class: 'fin-open' }, t('fin.open'), icon(ICONS.arrow))),
    h('div', { class: 'fin-mini-row' }, h('div', { class: 'fin-mini-nums' }, num('expense'), num('income')), chart),
    !hasOwnCompany(ctx.own) && ownHint(ctx),
  );
}

// ---------- Stránka Finance ----------

let month: string | undefined;
let selected: string | undefined;
let lastRoot: HTMLElement | undefined;
let lastCtx: FinanceCtx | undefined;

const redraw = () => lastRoot && lastCtx && renderFinance(lastRoot, lastCtx);
const pick = (jobId: string | undefined) => {
  selected = selected === jobId ? undefined : jobId;
  redraw();
};
const pickMonth = (m: string | undefined) => {
  month = month === m ? undefined : m;
  redraw();
};

/** Hezký krok osy: 1, 2 nebo 5 × mocnina deseti. */
function niceStep(v: number) {
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

function monthlyChart(data: MonthTotal[], currency: string) {
  const [W, H, pl, pr, pt, pb] = [560, 210, 50, 8, 18, 26];
  const max = Math.max(1, ...data.flatMap((d) => [d.expense, d.income]));
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const y = (v: number) => pt + (H - pt - pb) * (1 - v / top);
  const gw = (W - pl - pr) / data.length;
  const bw = Math.min(18, gw * 0.28);
  const compact = new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 });
  const bar = (x: number, v: number, cls: string, tip: string) => {
    const top0 = y(v);
    const bh = H - pb - top0;
    return bh > 0.5 ? s('rect', { class: cls, x, y: top0, width: bw, height: bh, rx: Math.min(4, bh) }, s('title', {}, tip)) : false;
  };
  const grid: SVGElement[] = [];
  for (let v = 0; v <= top + step / 2; v += step) grid.push(s('line', { class: 'fin-grid', x1: pl, x2: W - pr, y1: y(v), y2: y(v) }), s('text', { x: pl - 8, y: y(v) + 4, 'text-anchor': 'end' }, v ? compact.format(v) : '0'));
  const groups = data.map((d, i) => {
    const cx = pl + gw * i + gw / 2;
    const label = monthName(d.month, 'short');
    return s(
      'g',
      { class: 'fin-month', role: 'button', tabindex: 0, 'aria-label': cap(monthName(d.month, 'long')), 'aria-pressed': String(month === d.month), onclick: () => pickMonth(d.month), onkeydown: (e) => (e as KeyboardEvent).key === 'Enter' && pickMonth(d.month) },
      s('rect', { class: `fin-mhit${month === d.month ? ' on' : ''}`, x: pl + gw * i + 2, y: pt - 8, width: gw - 4, height: H - pt - pb + 26, rx: 6 }),
      bar(cx - bw - 1, d.expense, 'fin-b-exp', `${label}: ${t('fin.expense')} ${fmt(d.expense, currency)}`),
      bar(cx + 1, d.income, 'fin-b-inc', `${label}: ${t('fin.income')} ${fmt(d.income, currency)}`),
      s('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: month === d.month ? 'on' : '' }, label),
    );
  });
  const legend = h('div', { class: 'fin-legend' }, h('span', {}, h('i', { class: 'fin-sw-exp' }), t('fin.expense')), h('span', {}, h('i', { class: 'fin-sw-inc' }), t('fin.income')));
  return h('div', {}, legend, s('svg', { class: 'fin-chart', viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': t('fin.chartAria') }, ...grid, ...groups));
}

function timelineChart(items: TimelineItem[], months: string[], today: string, ctx: FinanceCtx) {
  const [W, H, pl, pr] = [1000, 280, 104, 18];
  const lanes = { income: 72, expense: 158, contract: 236 } as const;
  const start = Date.parse(`${months[0]}-01T00:00:00Z`);
  const end = Date.parse(`${monthRange(`${months[months.length - 1]}-01`, 0, 1)[1]}-01T00:00:00Z`);
  const x = (date: string) => pl + ((W - pl - pr) * (Date.parse(`${date}T00:00:00Z`) - start)) / (end - start);
  const max = Math.max(1, ...items.map((i) => (i.kind === 'invoice' ? i.amount : 0)));
  const els: SVGElement[] = [];
  months.forEach((m, i) => {
    const x0 = x(`${m}-01`);
    const x1 = i < months.length - 1 ? x(`${months[i + 1]}-01`) : W - pr;
    els.push(s('line', { class: 'fin-mline', x1: x0, x2: x0, y1: 24, y2: H - 8 }), s('text', { x: (x0 + x1) / 2, y: 16, 'text-anchor': 'middle', class: month === m ? 'on' : '' }, monthName(m, 'short')));
  });
  for (const lane of ['income', 'expense', 'contract'] as const) els.push(s('line', { class: 'fin-base', x1: pl, x2: W - pr, y1: lanes[lane], y2: lanes[lane] }), s('text', { class: 'fin-lane', x: 12, y: lanes[lane] + 4 }, t(`fin.lane.${lane}` as MessageKey)));
  if (today.slice(0, 7) >= months[0]! && today.slice(0, 7) <= months[months.length - 1]!) {
    const tx = x(today);
    els.push(s('line', { class: 'fin-today', x1: tx, x2: tx, y1: 24, y2: H - 8 }), s('text', { class: 'fin-tlab', x: tx + 5, y: H - 10 }, t('rel.today')));
  }
  // Blízké body ve stejné dráze se rozhodí nad a pod osu, ať se nepřekrývají.
  const lastX: Record<string, number> = {};
  const flip: Record<string, boolean> = {};
  for (const it of items) {
    const cx = x(it.date);
    let cy: number = lanes[it.lane];
    if (cx - (lastX[it.lane] ?? -99) < 16) {
      flip[it.lane] = !flip[it.lane];
      cy += flip[it.lane] ? -16 : 16;
    } else flip[it.lane] = false;
    lastX[it.lane] = cx;
    const inv = it.kind === 'invoice';
    const r = inv ? 5 + 19 * Math.sqrt(it.amount / max) : 6;
    const cls = inv ? `${it.paid ? 'fin-c' : 'fin-u'}-${it.lane === 'income' ? 'inc' : 'exp'}` : it.end ? 'fin-k fin-ko' : 'fin-k';
    const tip = inv ? `${day(it.date)} · ${it.party} · ${fmt(it.amount, it.currency)} · ${t(it.paid ? 'inv.status.paid' : 'inv.status.open')}` : `${day(it.date)} · ${t(it.end ? 'fin.contractEnd' : 'fin.contractStart')} · ${it.title}`;
    const dim = month && !it.date.startsWith(month) ? ' dim' : '';
    els.push(
      s(
        'g',
        {
          class: `fin-it${dim}${selected === it.jobId ? ' sel' : ''}`,
          role: 'button',
          tabindex: 0,
          'aria-label': tip,
          onclick: () => pick(it.jobId),
          ondblclick: () => ctx.open(it.jobId),
          onkeydown: (e) => (e as KeyboardEvent).key === 'Enter' && pick(it.jobId),
        },
        s('title', {}, tip),
        s('circle', { class: 'fin-hit', cx, cy, r: r + 5 }),
        s('circle', { class: `fin-vis ${cls}`, cx, cy, r }),
      ),
    );
  }
  return s('svg', { class: 'fin-tl', viewBox: `0 0 ${W} ${H}` }, ...els);
}

function suppliersList(rows: FlowRow[], currency: string) {
  const top = topSuppliers(rows, currency);
  if (!top.length) return h('p', { class: 'muted small' }, t('fin.suppliersEmpty'));
  const max = top[0]!.total || 1;
  return h(
    'div',
    { class: 'fin-hbars' },
    ...top.map((sup) =>
      h('div', { class: 'fin-hbar', title: `${sup.name}: ${fmt(sup.total, currency)}` }, h('div', { class: 'fin-hbar-top' }, h('span', {}, sup.name), h('b', {}, fmt(sup.total, currency, true))), h('div', { class: 'fin-hbar-track' }, h('i', { style: `width:${((sup.total / max) * 100).toFixed(1)}%` }))),
    ),
  );
}

/** Pravý náhled vybrané položky: údaje z karty a tlačítko pro otevření dokumentu. */
function previewPanel(jobId: string, all: FlowRow[], ctx: FinanceCtx) {
  const job = ctx.jobs.find((j) => j.id === jobId);
  const card = ctx.cards[jobId];
  if (!job || !card) return null;
  const row = all.find((r) => r.jobId === jobId);
  const f = card.facts ?? {};
  const line = (label: string, value: string | undefined) => value && h('div', { class: 'fin-pl' }, h('span', { class: 'muted' }, label), h('span', {}, value));
  const lines = row
    ? [
        line(t('inv.col.supplier'), row.supplier),
        line(t('inv.col.customer'), row.customer),
        line(t('inv.col.total'), row.total !== undefined ? fmt(row.total, row.currency) : undefined),
        line(t('inv.col.issued'), row.issued && day(row.issued)),
        line(t('inv.col.due'), row.due && day(row.due)),
        line(t('inv.col.status'), t(`inv.status.${row.status}` as MessageKey)),
      ]
    : [line(t('fin.contractStart'), f.validFrom && day(f.validFrom)), line(t('fin.contractEnd'), f.validTo && day(f.validTo)), line(t('card.facts.parties'), f.parties?.join(', '))];
  return h(
    'aside',
    { class: 'ov-card fin-panel' },
    h('div', { class: 'fin-panel-head' }, h('strong', {}, docTitle(job, card)), h('button', { class: 'icon-btn', type: 'button', title: t('region.close'), 'aria-label': t('region.close'), onclick: () => pick(jobId) }, icon(ICONS.x))),
    row && f.subject && h('p', { class: 'muted small' }, f.subject),
    ...lines,
    card.summary && h('p', { class: 'fin-summary' }, card.summary),
    h('button', { class: 'btn primary', type: 'button', onclick: () => ctx.open(jobId) }, t('fin.panelOpen')),
  );
}

/** Stránka Finance: součty, časová osa faktur a smluv, graf po měsících, dodavatelé a seznam položek. */
export function renderFinance(root: HTMLElement, ctx: FinanceCtx) {
  lastRoot = root;
  lastCtx = ctx;
  const today = isoDay();
  const { all, rows, months, currency } = financeData(ctx, today);
  const tlMonths = monthRange(today, 5, 1);
  const main = document.querySelector('.main');
  const scroll = main?.scrollTop ?? 0;

  const items = timelineItems(all, ctx.jobs, ctx.cards, tlMonths);
  if (!items.length) {
    root.replaceChildren(h('div', { class: 'empty' }, h('p', {}, t('fin.empty'))));
    return;
  }
  if (month && !tlMonths.includes(month)) month = undefined;
  if (selected && !items.some((i) => i.jobId === selected)) selected = undefined;

  const sums = periodSums(rows, month);
  const periodText = month ? cap(monthName(month, 'long')) : t('fin.last6');
  const sumCard = (label: string, value: Node | string, tone = '') => h('div', { class: `fin-sum ${tone}` }, h('div', { class: 'fin-l' }, `${label} · ${periodText}`), h('div', { class: 'fin-sum-v' }, value));
  const perCurrency = (pick: (x: (typeof sums)[number]) => number, signed = false) => {
    if (!sums.length) return fmt(0, currency, true);
    return sums.map((x) => `${signed && pick(x) > 0 ? '+' : ''}${fmt(pick(x), x.currency, true)}`).join(' · ');
  };
  const diffTone = sums.length && sums.every((x) => x.income - x.expense >= 0) ? 'ok' : sums.length ? 'bad' : '';

  const listItems = items
    .filter((i) => !month || i.date.startsWith(month))
    .sort((a, b) => b.date.localeCompare(a.date));
  const jobOf = (id: string) => ctx.jobs.find((j) => j.id === id);
  const itemRow = (i: TimelineItem) => {
    const job = jobOf(i.jobId);
    const card = ctx.cards[i.jobId];
    if (!job) return null;
    const row = all.find((r) => r.jobId === i.jobId);
    const amount =
      i.kind === 'invoice'
        ? h('span', { class: `fin-amt ${i.lane === 'income' ? 'inc' : ''}` }, `${i.lane === 'income' ? '+' : '−'}${fmt(i.amount, i.currency)}`)
        : h('span', { class: 'chip' }, t(i.end ? 'fin.contractEnd' : 'fin.contractStart'));
    return h(
      'div',
      { class: `ov-row fin-row${selected === i.jobId ? ' on' : ''}`, role: 'button', tabindex: '0', onclick: () => pick(i.jobId), ondblclick: () => ctx.open(i.jobId), onkeydown: (e) => (e as KeyboardEvent).key === 'Enter' && pick(i.jobId) },
      h('span', { class: 'ov-row-title' }, docTitle(job, card)),
      h('span', { class: 'ov-row-sub' }, [day(i.date), row && t(`inv.status.${row.status}` as MessageKey)].filter(Boolean).join(' · ')),
      amount,
    );
  };
  const byMonth = new Map<string, TimelineItem[]>();
  for (const i of listItems) byMonth.set(i.date.slice(0, 7), [...(byMonth.get(i.date.slice(0, 7)) ?? []), i]);

  const currencies = new Set(rows.map((r) => r.currency));
  const panel = selected ? previewPanel(selected, all, ctx) : null;

  root.replaceChildren(
    h(
      'div',
      { class: 'fin-page' },
      h(
        'div',
        { class: 'fin-head' },
        h('p', { class: 'muted' }, t('fin.sub'), ' ', !hasOwnCompany(ctx.own) && ownHint(ctx)),
        h(
          'div',
          { class: 'fin-acts' },
          month && h('button', { class: 'btn', type: 'button', onclick: () => pickMonth(month) }, icon(ICONS.x), t('fin.clearMonth', { month: cap(monthName(month, 'long')) })),
          h('button', { class: 'btn', type: 'button', onclick: ctx.showInvoices }, icon(ICONS.invoice), t('inv.title')),
        ),
      ),
      h('div', { class: 'fin-sums' }, sumCard(t('fin.income'), perCurrency((x) => x.income)), sumCard(t('fin.expense'), perCurrency((x) => x.expense)), sumCard(t('fin.diff'), perCurrency((x) => x.income - x.expense, true), diffTone)),
      h(
        'div',
        { class: `fin-layout${panel ? ' with-panel' : ''}` },
        h(
          'div',
          { class: 'fin-main' },
          h('section', { class: 'ov-card' }, h('h2', {}, t('fin.timeline')), timelineChart(timelineItems(all, ctx.jobs, ctx.cards, tlMonths, currency), tlMonths, today, ctx)),
          h(
            'div',
            { class: 'fin-grid' },
            h('section', { class: 'ov-card' }, h('h2', {}, `${t('fin.byMonth')} · ${t('fin.byMonthHint')}`), monthlyChart(monthTotals(rows, months, currency), currency)),
            h('section', { class: 'ov-card' }, h('h2', {}, t('fin.suppliers')), suppliersList(rows, currency)),
          ),
          h(
            'section',
            { class: 'ov-card' },
            h('h2', {}, `${month ? cap(monthName(month, 'long')) : t('fin.items')} (${listItems.length})`),
            ...(byMonth.size
              ? [...byMonth].flatMap(([m, list]) => [!month && h('h3', { class: 'fin-month-h' }, cap(monthName(m, 'long'))), h('div', { class: 'dl-list' }, ...list.map(itemRow))])
              : [h('p', { class: 'muted small' }, t('fin.itemsEmpty'))]),
          ),
        ),
        panel,
      ),
      h('p', { class: 'muted small' }, t('fin.note'), currencies.size > 1 && ` ${t('fin.currencyNote', { currency })}`),
    ),
  );
  if (main) main.scrollTop = scroll;
}
