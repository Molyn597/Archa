import { checkInvoices, defaultPeriod, periodFileName, periodOptions, selectInvoices, type CheckProblem, type PackageDirection, type PackageInclude, type PackageInvoice, type PeriodOption } from '../shared/accountant';
import { flowRows } from '../shared/finance';
import { locale, t, type MessageKey } from '../shared/i18n';
import { isoDay, type InvoiceRow } from '../shared/invoices';
import type { Job } from '../shared/types';
import { cleanError, h, icon, ICONS, openModal, toast } from './dom';

const MAX_LINES = 5;
const DIRECTIONS: PackageDirection[] = ['all', 'received', 'issued'];
const INCLUDES: (keyof PackageInclude)[] = ['pdf', 'isdoc', 'xlsx', 'csv'];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function periodLabel(o: PeriodOption) {
  if (o.kind === 'month') return cap(new Date(o.year, o.index - 1, 1).toLocaleDateString(locale(), { month: 'long', year: 'numeric' }));
  return o.kind === 'quarter' ? t('inv.pkg.quarter', { quarter: o.index, year: o.year }) : t('inv.pkg.year', { year: o.year });
}

/** Řádky Kontroly: nesouhlasící částky první, pak chybějící údaje; nejvýš MAX_LINES a „a N dalších“. */
function checkLines(rows: PackageInvoice[]) {
  const check = checkInvoices(rows);
  const lines = check.issues.map((i) => {
    const missing = i.problems.filter((p) => p !== 'sum').map((p) => t(`inv.pkg.p.${p}` as MessageKey));
    const parts = [...(i.problems.includes('sum') ? [t('inv.pkg.p.sum')] : []), ...(missing.length ? [t('inv.pkg.missing', { what: missing.join(', ') })] : [])];
    return { warn: true, text: `${i.title}: ${parts.join('; ')}` };
  });
  const head = [{ warn: false, text: t('inv.count', { count: check.count }) + (check.isdoc ? ` · ${t('inv.pkg.isdocCount', { count: check.isdoc })}` : '') }];
  // „Sedí u všech“ jen když šlo ověřit každou fakturu.
  if (check.count && check.sumChecked === check.count && !check.sumMismatch) head.push({ warn: false, text: t('inv.pkg.sumOk') });
  const shown = lines.slice(0, MAX_LINES);
  if (lines.length > MAX_LINES) shown.push({ warn: false, text: t('inv.pkg.more', { count: lines.length - MAX_LINES }) });
  return { check, lines: [...head, ...shown] };
}

export interface PackageCtx {
  rows: InvoiceRow[];
  jobs: Job[];
  /** Zavolá se po uložení (překreslení tabulky se štítkem „předáno“). */
  done(): void;
}

/** Dialog Balíček pro účetní: období, směr, obsah, kontrola; uložení ZIPu volá hlavní proces. */
export async function openPackageModal(ctx: PackageCtx) {
  const today = isoDay();
  const created = new Map(ctx.jobs.map((j) => [j.id, isoDay(new Date(j.createdAt))]));
  const own = (await window.api.getSettings().catch(() => undefined))?.ownCompany;
  const rows: PackageInvoice[] = flowRows(ctx.rows, own).map((r) => ({ ...r, date: r.issued || created.get(r.jobId) || '' }));
  const options = periodOptions(rows, today);
  const state = { period: defaultPeriod(options, today), direction: 'all' as PackageDirection, include: { pdf: true, isdoc: true, xlsx: true, csv: false } as PackageInclude, handOver: false };

  const period = h('select', { onchange: () => ((state.period = period.value), update()) }, ...options.map((o) => h('option', { value: o.key }, periodLabel(o))));
  period.value = state.period;
  const direction = h('select', { onchange: () => ((state.direction = direction.value as PackageDirection), update()) }, ...DIRECTIONS.map((d) => h('option', { value: d }, t(`inv.pkg.dir.${d}` as MessageKey))));
  const field = (label: MessageKey, select: HTMLSelectElement) => h('label', { class: 'pkg-field' }, h('span', { class: 'muted small' }, t(label)), select);

  const option = (text: string, checked: boolean, onChange: (v: boolean) => void, cls = 'pkg-opt') => {
    const box = h('input', { type: 'checkbox', class: 'lib-check' });
    box.checked = checked;
    box.addEventListener('change', () => (onChange(box.checked), update()));
    return h('label', { class: cls }, box, h('span', {}, text));
  };
  const includeCards = {} as Record<keyof PackageInclude, HTMLElement>;
  for (const k of INCLUDES) includeCards[k] = option(t(`inv.pkg.${k}` as MessageKey), state.include[k], (v) => (state.include[k] = v));
  const handOver = option(t('inv.pkg.handOver'), false, (v) => (state.handOver = v), 'pkg-opt pkg-switch');

  const checkBox = h('ul', { class: 'pkg-check' });
  const save = h('button', { class: 'btn primary', type: 'button', onclick: () => void run() }, icon(ICONS.download), t('inv.pkg.save'));
  const selected = () => selectInvoices(rows, options, state.period, state.direction);

  function update() {
    const picked = selected();
    const { check, lines } = checkLines(picked);
    includeCards.isdoc.hidden = !check.isdoc;
    checkBox.replaceChildren(...(check.count ? lines : [{ warn: false, text: t('inv.pkg.none') }]).map((l) => h('li', { class: l.warn ? 'warn' : '' }, l.text)));
    const any = INCLUDES.some((k) => state.include[k] && (k !== 'isdoc' || check.isdoc));
    save.disabled = !check.count || !any;
  }

  let close = () => {};
  async function run() {
    const picked = selected();
    const o = options.find((x) => x.key === state.period)!;
    save.disabled = true;
    try {
      const res = await window.api.packageInvoices({ ids: picked.map((r) => r.jobId), include: state.include, handOver: state.handOver, nameSuffix: periodFileName(o) });
      if (!res) return update();
      close();
      toast(t('inv.pkg.saved', { path: res.path }));
      if (res.skipped) toast(t('inv.pkg.skipped', { count: res.skipped }), true);
      ctx.done();
    } catch (e) {
      toast(cleanError(e), true);
      update();
    }
  }

  close = openModal(
    t('inv.package'),
    [
      h('p', { class: 'merge-hint' }, t('inv.pkg.hint')),
      h('div', { class: 'pkg-grid' }, field('inv.pkg.period', period), field('inv.pkg.direction', direction)),
      h('div', { class: 'pkg-opts' }, ...INCLUDES.map((k) => includeCards[k])),
      h('div', { class: 'pkg-box' }, h('strong', {}, t('inv.pkg.check')), checkBox),
      handOver,
    ],
    [h('button', { class: 'btn', type: 'button', onclick: () => close() }, t('libs.cancel')), save],
  );
  update();
}
