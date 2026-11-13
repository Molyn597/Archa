import { monthRange, type FlowRow } from './finance';
import { safeFileName } from './name-template';

/** Faktura v balíčku: řádek se směrem a datem pro období (datum vystavení, jinak datum dokumentu). */
export type PackageInvoice = FlowRow & { date: string };
export type PackageDirection = 'all' | 'received' | 'issued';
export type PeriodKind = 'month' | 'quarter' | 'year';

/** Období: `key` je `m:2026-10`, `q:2026-3` nebo `y:2026`. */
export interface PeriodOption {
  key: string;
  kind: PeriodKind;
  year: number;
  /** Měsíc nebo čtvrtletí (1–12 / 1–4); u roku 0. */
  index: number;
  from: string;
  to: string;
}

const p2 = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => `${y}-${p2(m)}-${p2(new Date(y, m, 0).getDate())}`;

const month = (y: number, m: number): PeriodOption => ({ key: `m:${y}-${p2(m)}`, kind: 'month', year: y, index: m, from: `${y}-${p2(m)}-01`, to: lastDay(y, m) });
const quarter = (y: number, q: number): PeriodOption => ({ key: `q:${y}-${q}`, kind: 'quarter', year: y, index: q, from: `${y}-${p2(q * 3 - 2)}-01`, to: lastDay(y, q * 3) });
const year = (y: number): PeriodOption => ({ key: `y:${y}`, kind: 'year', year: y, index: 0, from: `${y}-01-01`, to: `${y}-12-31` });

const inside = (o: PeriodOption, date: string) => !!date && date >= o.from && date <= o.to;

/** Měsíce z posledních 12, které mají faktury (nejnovější první), poslední 4 čtvrtletí a celý letošní a loňský rok. */
export function periodOptions(rows: PackageInvoice[], today: string): PeriodOption[] {
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const months = monthRange(today, 11)
    .reverse()
    .map((k) => month(Number(k.slice(0, 4)), Number(k.slice(5, 7))))
    .filter((o) => rows.some((r) => inside(o, r.date)));
  const q = Math.ceil(m / 3);
  const quarters = Array.from({ length: 4 }, (_, i) => {
    const n = q - i;
    return n > 0 ? quarter(y, n) : quarter(y - 1, n + 4);
  });
  return [...months, ...quarters, year(y), year(y - 1)];
}

/** Předchozí měsíc, pokud má faktury, jinak tento; jinak první nabídnuté období. */
export function defaultPeriod(options: PeriodOption[], today: string): string {
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const prev = m === 1 ? month(y - 1, 12) : month(y, m - 1);
  return [prev.key, month(y, m).key].find((k) => options.some((o) => o.key === k)) ?? options[0].key;
}

/** Faktury vybraného období a směru, od nejstarší. */
export function selectInvoices(rows: PackageInvoice[], options: PeriodOption[], key: string, direction: PackageDirection): PackageInvoice[] {
  const period = options.find((o) => o.key === key);
  return rows
    .filter((r) => period && inside(period, r.date) && (direction === 'all' || (direction === 'issued') === (r.flow === 'income')))
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title, 'cs'));
}

export type CheckProblem = 'sum' | 'number' | 'supplierId' | 'issued' | 'total';
export interface CheckIssue {
  jobId: string;
  title: string;
  problems: CheckProblem[];
}
export interface PackageCheck {
  count: number;
  isdoc: number;
  /** Faktury, u kterých základ + DPH nedává celkem (tolerance 0,01). */
  sumMismatch: number;
  /** Faktury, u kterých jde součet ověřit (mají základ, DPH i celkem). */
  sumChecked: number;
  /** Faktury s nesouhlasící částkou nebo chybějícím údajem, nejdřív nesouhlasící částka. */
  issues: CheckIssue[];
}

/** Kontrola před předáním: součet základ + DPH = celkem a údaje, které účetní potřebuje (číslo, IČO dodavatele, datum vystavení, celkem). */
export function checkInvoices(rows: PackageInvoice[]): PackageCheck {
  const issues: CheckIssue[] = [];
  for (const r of rows) {
    const problems: CheckProblem[] = [];
    // 0,0105: ať nerozhodne chyba plovoucí čárky u přesné odchylky 0,01.
    if (r.net !== undefined && r.vat !== undefined && r.total !== undefined && Math.abs(r.net + r.vat - r.total) > 0.0105) problems.push('sum');
    if (!r.number) problems.push('number');
    if (!r.supplierId) problems.push('supplierId');
    if (!r.issued) problems.push('issued');
    if (r.total === undefined) problems.push('total');
    if (problems.length) issues.push({ jobId: r.jobId, title: r.title, problems });
  }
  issues.sort((a, b) => Number(b.problems.includes('sum')) - Number(a.problems.includes('sum')));
  return { count: rows.length, isdoc: rows.filter((r) => r.isdoc).length, sumMismatch: issues.filter((i) => i.problems.includes('sum')).length, sumChecked: rows.filter((r) => r.net !== undefined && r.vat !== undefined && r.total !== undefined).length, issues };
}

/** Základ názvu souboru bez přípony: z šablony, jinak z původního názvu, jinak „faktura“. */
export const packageBase = (templateName: string, original: string) => safeFileName(templateName) || safeFileName(original) || 'faktura';

/** Jedinečné základy názvů (bez ohledu na velikost písmen): opakovaný název dostane „ (2)“, „ (3)“…; pořadí jako vstup. */
export function uniqueBases(items: { id: string; base: string }[]): Map<string, string> {
  const used = new Set<string>();
  const result = new Map<string, string>();
  for (const { id, base } of items) {
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
    used.add(name.toLowerCase());
    result.set(id, name);
  }
  return result;
}

export interface PackageInclude {
  pdf: boolean;
  isdoc: boolean;
  xlsx: boolean;
  csv: boolean;
}
export interface PackageEntry {
  /** Cesta v ZIPu. */
  path: string;
  kind: 'original' | 'isdoc' | 'xlsx' | 'csv';
  /** Dokument, ze kterého soubor pochází (přehledy ho nemají). */
  jobId?: string;
}

/** Seznam souborů ZIPu: `PDF/` (originály, i obrázky s vlastní příponou), `ISDOC/`, `Prehled.xlsx`, `Prehled.csv`. */
export function packageEntries(items: { jobId: string; base: string; ext: string; isdoc: boolean }[], include: PackageInclude): PackageEntry[] {
  const out: PackageEntry[] = [];
  for (const i of items) if (include.pdf) out.push({ path: `PDF/${i.base}${i.ext}`, kind: 'original', jobId: i.jobId });
  for (const i of items) if (include.isdoc && i.isdoc) out.push({ path: `ISDOC/${i.base}.isdoc`, kind: 'isdoc', jobId: i.jobId });
  if (include.xlsx) out.push({ path: 'Prehled.xlsx', kind: 'xlsx' });
  if (include.csv) out.push({ path: 'Prehled.csv', kind: 'csv' });
  return out;
}

/** Část názvu souboru z období: 2026-10, 2026-Q3, 2026. */
export function periodFileName(o: PeriodOption): string {
  return o.kind === 'month' ? `${o.year}-${p2(o.index)}` : o.kind === 'quarter' ? `${o.year}-Q${o.index}` : String(o.year);
}
