import { locale, t, type MessageKey } from '../shared/i18n';
import { filterInvoices, invoiceRows, invoiceSums, isoDay, periodRange, sortInvoices, type InvoicePeriod, type InvoiceRow, type InvoiceSortKey, type InvoiceStatusFilter } from '../shared/invoices';
import type { DocumentCard, Job } from '../shared/types';
import { cleanError, h, icon, ICONS, toast } from './dom';

export interface InvoicesCtx {
  jobs: Job[];
  cards: Record<string, DocumentCard>;
  paid: Record<string, number> | undefined;
  /** Text z pole hledání v hlavičce Souborů. */
  query: string;
  open(jobId: string): void;
  /** Překreslí knihovnu (po změně filtru, řazení nebo výběru). */
  redraw(): void;
}

let period: InvoicePeriod = 'all';
let status: InvoiceStatusFilter = 'all';
let sort: { key: InvoiceSortKey; dir: 'asc' | 'desc' } = { key: 'issued', dir: 'desc' };
const chosen = new Set<string>();

/** Počet faktur v knihovně (položka ve stromu je jen když nějaká je). */
export const invoiceCount = (jobs: Job[], cards: Record<string, DocumentCard>) => jobs.filter((j) => cards[j.id]?.type === 'invoice').length;

export const day = (iso: string) => {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(locale(), { day: 'numeric', month: 'numeric', year: 'numeric' }) : iso;
};

function money(value: number | undefined, currency: string) {
  if (value === undefined) return '–';
  try {
    return new Intl.NumberFormat(locale(), currency ? { style: 'currency', currency } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  } catch {
    // Neznámý kód měny.
    return `${new Intl.NumberFormat(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} ${currency}`;
  }
}

const STATUS_CHIP = { paid: 'chip ok', overdue: 'chip err', open: 'chip', unknown: 'chip' } as const;

const fail = (e: unknown) => toast(cleanError(e), true);

/** Tabulka všech faktur knihovny s filtry, součty, označením zaplaceno a exportem. */
export function renderInvoices(root: HTMLElement, ctx: InvoicesCtx) {
  const today = isoDay();
  const all = invoiceRows(ctx.jobs, ctx.cards, ctx.paid, today);
  const range = periodRange(period, today);
  const rows = sortInvoices(filterInvoices(all, { query: ctx.query, ...range, status }), sort.key, sort.dir);
  for (const id of chosen) if (!rows.some((r) => r.jobId === id)) chosen.delete(id);

  const select = <T extends string>(value: T, options: [T, MessageKey][], onChange: (v: T) => void) => {
    const el = h('select', { onchange: () => onChange(el.value as T) }, ...options.map(([v, key]) => h('option', { value: v }, t(key))));
    el.value = value;
    return el;
  };
  const ids = rows.map((r) => r.jobId);
  const exportTo = (format: 'xlsx' | 'csv') =>
    void window.api
      .exportInvoices(ids, format)
      .then((file) => file && toast(t('inv.exported', { path: file })))
      .catch(fail);
  const setPaid = (jobIds: string[], paid: boolean) => void window.api.setInvoicesPaid(jobIds, paid).catch(fail);

  const toolbar = h(
    'div',
    { class: 'inv-toolbar' },
    select(period, [['all', 'inv.period.all'], ['thisMonth', 'inv.period.thisMonth'], ['lastMonth', 'inv.period.lastMonth'], ['thisYear', 'inv.period.thisYear'], ['lastYear', 'inv.period.lastYear']], (v) => ((period = v), ctx.redraw())),
    select(status, [['all', 'inv.filter.allStatus'], ['open', 'inv.filter.open'], ['overdue', 'inv.filter.overdue'], ['paid', 'inv.filter.paid']], (v) => ((status = v), ctx.redraw())),
    h('span', { class: 'inv-count' }, t('inv.count', { count: rows.length })),
    h('button', { class: 'btn', type: 'button', disabled: !rows.length, onclick: () => exportTo('xlsx') }, icon(ICONS.download), t('inv.exportXlsx')),
    h('button', { class: 'btn', type: 'button', disabled: !rows.length, onclick: () => exportTo('csv') }, icon(ICONS.download), t('inv.exportCsv')),
  );

  const bar = h(
    'div',
    { class: 'lib-bar', hidden: !chosen.size },
    h('span', { class: 'lib-bar-all' }, t('library.selected', { count: chosen.size })),
    h('button', { class: 'btn', type: 'button', onclick: () => setPaid([...chosen], true) }, icon(ICONS.check), t('inv.markPaid')),
    h('button', { class: 'btn', type: 'button', onclick: () => setPaid([...chosen], false) }, t('inv.markUnpaid')),
    h('button', { class: 'btn', type: 'button', onclick: () => (chosen.clear(), ctx.redraw()) }, t('library.clearSelection')),
  );

  const sortable = (key: InvoiceSortKey, label: MessageKey, cls = '') => {
    const active = sort.key === key;
    return h(
      'th',
      { class: cls, 'aria-sort': active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none' },
      h(
        'button',
        {
          type: 'button',
          class: 'inv-sort',
          onclick: () => {
            sort = { key, dir: active && sort.dir === 'asc' ? 'desc' : active ? 'asc' : key === 'issued' || key === 'due' || key === 'total' ? 'desc' : 'asc' };
            ctx.redraw();
          },
        },
        t(label),
        active ? h('span', { class: 'inv-arrow', 'aria-hidden': 'true' }, sort.dir === 'asc' ? '↑' : '↓') : null,
      ),
    );
  };
  const allBox = h('input', { type: 'checkbox', class: 'lib-check', title: t('inv.selectAll'), 'aria-label': t('inv.selectAll') });
  allBox.checked = rows.length > 0 && chosen.size === rows.length;
  allBox.indeterminate = chosen.size > 0 && chosen.size < rows.length;
  allBox.addEventListener('click', () => {
    if (allBox.checked) for (const r of rows) chosen.add(r.jobId);
    else chosen.clear();
    ctx.redraw();
  });
  const head = h(
    'tr',
    {},
    h('th', { class: 'inv-check' }, allBox),
    sortable('supplier', 'inv.col.supplier'),
    sortable('customer', 'inv.col.customer'),
    sortable('number', 'inv.col.number'),
    sortable('subject', 'inv.col.subject'),
    sortable('issued', 'inv.col.issued'),
    sortable('due', 'inv.col.due'),
    sortable('total', 'inv.col.total', 'inv-num'),
    sortable('status', 'inv.col.status'),
  );

  const line = (r: InvoiceRow) => {
    const check = h('input', { type: 'checkbox', class: 'lib-check', title: t('inv.selectRow'), 'aria-label': t('inv.selectRow') });
    check.checked = chosen.has(r.jobId);
    check.addEventListener('click', (e) => {
      e.stopPropagation();
      if (check.checked) chosen.add(r.jobId);
      else chosen.delete(r.jobId);
      ctx.redraw();
    });
    const paid = h('input', { type: 'checkbox', class: 'lib-check', title: t('inv.paidToggle'), 'aria-label': t('inv.paidToggle') });
    paid.checked = r.status === 'paid';
    paid.addEventListener('click', (e) => {
      e.stopPropagation();
      setPaid([r.jobId], paid.checked);
    });
    const tr = h(
      'tr',
      { class: `inv-row${chosen.has(r.jobId) ? ' chosen' : ''}`, tabindex: '0', title: r.file, onclick: () => ctx.open(r.jobId), onkeydown: (e) => (e as KeyboardEvent).key === 'Enter' && ctx.open(r.jobId) },
      h('td', { class: 'inv-check' }, check),
      h('td', { class: 'inv-party' }, r.supplier || '–'),
      h('td', { class: 'inv-party' }, r.customer || '–'),
      h('td', { class: 'inv-nowrap' }, r.number || '–'),
      h('td', { class: 'inv-subject' }, h('span', { title: r.subject }, r.subject || '–')),
      h('td', { class: 'inv-date' }, r.issued ? day(r.issued) : '–'),
      h('td', { class: 'inv-date' }, r.due ? day(r.due) : '–'),
      h('td', { class: 'inv-num', title: r.isdoc ? t('inv.isdoc') : '' }, money(r.total, r.currency)),
      // Zaškrtnutí ve sloupci Stav = zaplaceno (samostatný sloupec se do běžné šířky okna nevešel).
      h('td', { class: 'inv-nowrap' }, h('span', { class: 'inv-state' }, paid, h('span', { class: STATUS_CHIP[r.status] }, t(`inv.status.${r.status}` as MessageKey)))),
    );
    return tr;
  };

  const sums = invoiceSums(rows);
  const footer = h(
    'div',
    { class: 'inv-sums' },
    ...sums.map((s) =>
      h(
        'div',
        { class: 'inv-sum' },
        h('strong', {}, `${t('inv.sumLabel')}${s.currency ? ` ${s.currency}` : ''}`),
        h('span', {}, `${t('inv.col.total')}: ${money(s.total, s.currency)}`),
        h('span', {}, `${t('inv.col.net')}: ${money(s.net, s.currency)}`),
        h('span', {}, `${t('inv.col.vat')}: ${money(s.vat, s.currency)}`),
      ),
    ),
  );

  root.replaceChildren(
    h(
      'div',
      { class: 'inv-view' },
      toolbar,
      bar,
      !all.length || !rows.length
        ? h('div', { class: 'empty' }, h('p', {}, t(all.length ? 'inv.noMatch' : 'inv.empty')))
        : h('div', { class: 'inv-scroll' }, h('table', { class: 'inv-table' }, h('thead', {}, head), h('tbody', {}, ...rows.map(line)))),
      rows.length ? footer : null,
    ),
  );
}
