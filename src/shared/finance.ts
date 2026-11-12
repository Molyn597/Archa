import { fold } from './folders';
import type { InvoiceRow } from './invoices';
import type { DocumentCard, Job, OwnCompany } from './types';

/** Příjem = vydaná faktura (vlastní firma je dodavatel), výdaj = přijatá faktura. */
export type Flow = 'income' | 'expense';
export interface FlowRow extends InvoiceRow {
  flow: Flow;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const p2 = (n: number) => String(n).padStart(2, '0');

/** Klíč strany faktury: DIČ, jinak IČO, jinak jméno bez diakritiky. */
const partyKey = (name: string, vat: string, id: string) => fold(vat) || fold(id) || fold(name);

/**
 * Vlastní firma: strana, která se na fakturách knihovny opakuje nejčastěji (jako dodavatel i odběratel dohromady).
 * Aplikace vlastní firmu nezná, takže se odhaduje; s jedinou fakturou nebo bez opakování se nepozná.
 */
export function ownParty(rows: InvoiceRow[]): string {
  const counts = new Map<string, number>();
  const add = (key: string) => key && counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const r of rows) {
    add(partyKey(r.supplier, r.supplierVat, r.supplierId));
    add(partyKey(r.customer, r.customerVat, r.customerId));
  }
  let best = '';
  let max = 1;
  for (const [key, n] of counts) if (n > max) [best, max] = [key, n];
  return best;
}

/** IČO a DIČ jen z písmen a číslic („CZ 123-45“ = „cz12345“). */
export const code = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Název bez diakritiky, velikosti písmen a právní formy na konci (s.r.o., spol. s r.o., a.s., v.o.s., k.s., z.s., o.p.s.). */
export const bareName = (name: string) => {
  const words = fold(name).replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  return words.replace(/ (spol s r o|s r o|sro|a s|v o s|k s|z s|o p s)$/, '') || words;
};

/** Vyplněná moje firma (aspoň jedna z hodnot). */
export const hasOwnCompany = (own?: OwnCompany): own is OwnCompany => !!own && !!(own.name.trim() || code(own.id) || code(own.vat));

/** Strana faktury je moje firma: shoda IČO nebo DIČ, jinak shoda názvu. */
export function isOwn(own: OwnCompany, name: string, vat: string, id: string) {
  const [oi, ov] = [code(own.id), code(own.vat)];
  if ((oi && oi === code(id)) || (ov && ov === code(vat))) return true;
  const on = bareName(own.name);
  return !!on && on === bareName(name);
}

/** Faktury s určeným směrem: vydané (příjem), jinak přijaté (výdaj). Bez vyplněné firmy se vlastní firma odhaduje. */
export function flowRows(rows: InvoiceRow[], own?: OwnCompany): FlowRow[] {
  const guess = hasOwnCompany(own) ? '' : ownParty(rows);
  const mine = (r: InvoiceRow) => (hasOwnCompany(own) ? isOwn(own, r.supplier, r.supplierVat, r.supplierId) : !!guess && guess === partyKey(r.supplier, r.supplierVat, r.supplierId));
  return rows.map((r) => ({ ...r, flow: mine(r) ? 'income' : 'expense' }));
}

/** Měsíce RRRR-MM od `back` měsíců před dnešním do `forward` měsíců po něm. */
export function monthRange(today: string, back: number, forward = 0): string[] {
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  return Array.from({ length: back + forward + 1 }, (_, i) => {
    const d = new Date(y, m - 1 - back + i, 1);
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
  });
}

/** Měna s nejvíce fakturami s částkou (grafy se kreslí v jedné měně, různé měny se nesčítají). */
export function primaryCurrency(rows: InvoiceRow[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) if (r.total !== undefined) counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Faktury s částkou daného měsíce (podle data vystavení) a měny; bez měsíce nebo měny všechny. */
const inPeriod = (rows: FlowRow[], currency: string | undefined, month?: string) => rows.filter((r) => r.total !== undefined && (currency === undefined || r.currency === currency) && r.issued && (!month || r.issued.startsWith(month)));

export interface MonthTotal {
  month: string;
  income: number;
  expense: number;
}

/** Příjmy a výdaje po měsících v jedné měně. */
export function monthTotals(rows: FlowRow[], months: string[], currency: string): MonthTotal[] {
  return months.map((month) => {
    const sum = (flow: Flow) => round2(inPeriod(rows, currency, month).filter((r) => r.flow === flow).reduce((a, r) => a + (r.total ?? 0), 0));
    return { month, income: sum('income'), expense: sum('expense') };
  });
}

export interface PeriodSum {
  currency: string;
  income: number;
  expense: number;
}

/** Součty příjmů a výdajů za měsíc (nebo celé období) po měnách. */
export function periodSums(rows: FlowRow[], month?: string): PeriodSum[] {
  const sums = new Map<string, PeriodSum>();
  for (const r of rows) {
    if (r.total === undefined || !r.issued || (month && !r.issued.startsWith(month))) continue;
    const s = sums.get(r.currency) ?? { currency: r.currency, income: 0, expense: 0 };
    s[r.flow] = round2(s[r.flow] + r.total);
    sums.set(r.currency, s);
  }
  return [...sums.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/** Dodavatelé s nejvyššími výdaji v dané měně (stejné jméno bez ohledu na diakritiku a velikost je jeden). */
export function topSuppliers(rows: FlowRow[], currency: string, limit = 4): { name: string; total: number }[] {
  const by = new Map<string, { name: string; total: number }>();
  for (const r of inPeriod(rows, currency).filter((x) => x.flow === 'expense' && x.supplier)) {
    const key = partyKey(r.supplier, r.supplierVat, r.supplierId);
    const s = by.get(key) ?? { name: r.supplier, total: 0 };
    s.total = round2(s.total + (r.total ?? 0));
    by.set(key, s);
  }
  return [...by.values()].sort((a, b) => b.total - a.total).slice(0, limit);
}

export type TimelineItem =
  | { kind: 'invoice'; jobId: string; date: string; lane: Flow; amount: number; currency: string; paid: boolean; title: string; party: string }
  | { kind: 'contract'; jobId: string; date: string; lane: 'contract'; end: boolean; title: string };

/** Body časové osy: faktury podle data vystavení (v jedné měně, když je zadaná) a začátky a konce smluv v rozsahu měsíců. */
export function timelineItems(rows: FlowRow[], jobs: Job[], cards: Record<string, DocumentCard | null | undefined>, months: string[], currency?: string): TimelineItem[] {
  const inRange = (date: string) => DATE.test(date) && date.slice(0, 7) >= months[0]! && date.slice(0, 7) <= months[months.length - 1]!;
  const items: TimelineItem[] = [];
  for (const r of inPeriod(rows, currency)) {
    if (!inRange(r.issued)) continue;
    items.push({ kind: 'invoice', jobId: r.jobId, date: r.issued, lane: r.flow, amount: r.total ?? 0, currency: r.currency, paid: r.status === 'paid', title: r.title, party: r.flow === 'income' ? r.customer : r.supplier });
  }
  for (const job of jobs) {
    const card = cards[job.id];
    if (card?.type !== 'contract') continue;
    const title = card.facts?.subject?.trim() || `${job.name}${job.ext}`;
    for (const [date, end] of [[card.facts?.validFrom, false], [card.facts?.validTo, true]] as const) if (date && inRange(date)) items.push({ kind: 'contract', jobId: job.id, date, lane: 'contract', end, title });
  }
  return items.sort((a, b) => a.date.localeCompare(b.date));
}
