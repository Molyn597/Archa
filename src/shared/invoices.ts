import { fold } from './folders';
import { locale } from './i18n';
import { parseMoney } from './money';
import type { DocumentCard, Job } from './types';

export type InvoiceStatus = 'paid' | 'overdue' | 'open' | 'unknown';

export interface InvoiceRow {
  jobId: string;
  /** Číslo faktury, jinak název souboru. */
  title: string;
  file: string;
  supplier: string;
  supplierId: string;
  supplierVat: string;
  customer: string;
  customerId: string;
  customerVat: string;
  number: string;
  vs: string;
  subject: string;
  /** RRRR-MM-DD nebo prázdné. */
  issued: string;
  due: string;
  total?: number;
  net?: number;
  vat?: number;
  currency: string;
  status: InvoiceStatus;
  /** Čas označení „zaplaceno“. */
  paidAt?: number;
  /** Údaje přesně z přílohy ISDOC. */
  isdoc: boolean;
}

export type InvoicePeriod = 'all' | 'thisMonth' | 'lastMonth' | 'thisYear' | 'lastYear';
export type InvoiceStatusFilter = 'all' | 'open' | 'overdue' | 'paid';
export interface InvoiceFilter {
  query?: string;
  /** Vystaveno od / do včetně (RRRR-MM-DD). */
  from?: string;
  to?: string;
  status?: InvoiceStatusFilter;
}
export type InvoiceSortKey = 'supplier' | 'customer' | 'number' | 'subject' | 'issued' | 'due' | 'total' | 'status';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Dnešní datum jako RRRR-MM-DD v místním čase. */
export function isoDay(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Datum RRRR-MM-DD v místním formátu; jiný text vrátí beze změny. */
export const day = (iso: string) => {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(locale(), { day: 'numeric', month: 'numeric', year: 'numeric' }) : iso;
};

/** Řádky tabulky faktur z viditelných úloh; pořadí podle úloh. */
export function invoiceRows(jobs: Job[], cards: Record<string, DocumentCard | null | undefined>, paid: Record<string, number> | undefined, today: string): InvoiceRow[] {
  const rows: InvoiceRow[] = [];
  for (const job of jobs) {
    const card = cards[job.id];
    if (!card || card.type !== 'invoice') continue;
    const f = card.facts ?? {};
    const total = f.amount ? parseMoney(f.amount) : undefined;
    const net = f.net ? parseMoney(f.net) : undefined;
    const vat = f.vat ? parseMoney(f.vat) : undefined;
    const due = f.due && DATE.test(f.due) ? f.due : '';
    const paidAt = paid?.[job.id];
    const status: InvoiceStatus = paidAt !== undefined ? 'paid' : !due ? 'unknown' : due < today ? 'overdue' : 'open';
    rows.push({
      jobId: job.id,
      title: f.number || `${job.name}${job.ext}`,
      file: `${job.name}${job.ext}`,
      supplier: f.supplier ?? '',
      supplierId: f.supplierId ?? '',
      supplierVat: f.supplierVat ?? '',
      customer: f.customer ?? '',
      customerId: f.customerId ?? '',
      customerVat: f.customerVat ?? '',
      number: f.number ?? '',
      vs: f.vs ?? '',
      subject: f.subject ?? '',
      issued: f.issued && DATE.test(f.issued) ? f.issued : '',
      due,
      total: total?.value,
      net: net?.value,
      vat: vat?.value,
      currency: total?.currency ?? net?.currency ?? vat?.currency ?? '',
      status,
      ...(paidAt !== undefined && { paidAt }),
      isdoc: card.factsFrom === 'isdoc',
    });
  }
  return rows;
}

/** Hledání v dodavateli, odběrateli, čísle a předmětu (bez diakritiky), období podle data vystavení a stav. */
export function filterInvoices(rows: InvoiceRow[], filter: InvoiceFilter): InvoiceRow[] {
  const q = fold(filter.query ?? '');
  const { from, to } = filter;
  const status = filter.status ?? 'all';
  return rows.filter((r) => {
    if (q && !fold([r.supplier, r.customer, r.number, r.subject].join(' ')).includes(q)) return false;
    if ((from && (!r.issued || r.issued < from)) || (to && (!r.issued || r.issued > to))) return false;
    return status === 'all' || r.status === status;
  });
}

/** Rozsah „vystaveno“ pro rychlý výběr období. */
export function periodRange(period: InvoicePeriod, today: string): { from?: string; to?: string } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const p = (n: number) => String(n).padStart(2, '0');
  // Poslední den měsíce: den 0 následujícího měsíce.
  const last = (y: number, m: number) => `${y}-${p(m)}-${p(new Date(y, m, 0).getDate())}`;
  switch (period) {
    case 'thisMonth':
      return { from: `${year}-${p(month)}-01`, to: last(year, month) };
    case 'lastMonth': {
      const y = month === 1 ? year - 1 : year;
      const m = month === 1 ? 12 : month - 1;
      return { from: `${y}-${p(m)}-01`, to: last(y, m) };
    }
    case 'thisYear':
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    case 'lastYear':
      return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
    default:
      return {};
  }
}

export interface CurrencySum {
  currency: string;
  total: number;
  net: number;
  vat: number;
}

/** Součty po měnách (různé měny se nikdy nesčítají); řádky bez částky se přeskočí. */
export function invoiceSums(rows: InvoiceRow[]): CurrencySum[] {
  const sums = new Map<string, CurrencySum>();
  for (const r of rows) {
    if (r.total === undefined && r.net === undefined && r.vat === undefined) continue;
    const s = sums.get(r.currency) ?? { currency: r.currency, total: 0, net: 0, vat: 0 };
    s.total += r.total ?? 0;
    s.net += r.net ?? 0;
    s.vat += r.vat ?? 0;
    sums.set(r.currency, s);
  }
  // Zaokrouhlení proti chybám plovoucí čárky.
  return [...sums.values()].map((s) => ({ ...s, total: round2(s.total), net: round2(s.net), vat: round2(s.vat) })).sort((a, b) => a.currency.localeCompare(b.currency));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const STATUS_ORDER: Record<InvoiceStatus, number> = { overdue: 0, open: 1, unknown: 2, paid: 3 };

/** Řazení podle sloupce; prázdné hodnoty jsou vždy na konci. */
export function sortInvoices(rows: InvoiceRow[], key: InvoiceSortKey, dir: 'asc' | 'desc'): InvoiceRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  const value = (r: InvoiceRow): string | number | undefined => {
    if (key === 'total') return r.total;
    if (key === 'status') return STATUS_ORDER[r.status];
    return r[key] || undefined;
  };
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1;
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'cs');
    return c * sign;
  });
}

// ---------- Export ----------

/** Buňka exportu: text, číslo, datum (RRRR-MM-DD) nebo prázdná. */
export type Cell = string | number | { date: string } | null;

export type ExportKey = 'supplier' | 'supplierId' | 'supplierVat' | 'customer' | 'customerId' | 'customerVat' | 'number' | 'vs' | 'subject' | 'issued' | 'due' | 'net' | 'vat' | 'total' | 'currency' | 'status' | 'paidAt' | 'file';

export const EXPORT_KEYS: ExportKey[] = ['supplier', 'supplierId', 'supplierVat', 'customer', 'customerId', 'customerVat', 'number', 'vs', 'subject', 'issued', 'due', 'net', 'vat', 'total', 'currency', 'status', 'paidAt', 'file'];
/** Sloupce, které jsou čísla (pro šířku a formát). */
export const NUMBER_KEYS: ExportKey[] = ['net', 'vat', 'total'];

/** Tabulka k exportu: hlavičky (podle jazyka) a řádky s typovanými buňkami. */
export function exportTable(rows: InvoiceRow[], label: (key: ExportKey) => string, statusText: (s: InvoiceStatus) => string): { headers: string[]; rows: Cell[][] } {
  const cell = (r: InvoiceRow, key: ExportKey): Cell => {
    switch (key) {
      case 'issued':
      case 'due':
        return r[key] ? { date: r[key] } : null;
      case 'net':
      case 'vat':
      case 'total':
        return r[key] ?? null;
      case 'status':
        return statusText(r.status);
      case 'paidAt':
        return r.paidAt !== undefined ? { date: isoDay(new Date(r.paidAt)) } : null;
      default:
        return r[key] || null;
    }
  };
  return { headers: EXPORT_KEYS.map(label), rows: rows.map((r) => EXPORT_KEYS.map((k) => cell(r, k))) };
}

/** Datum RRRR-MM-DD jako d.m.rrrr (tak ho česká lokalizace Excelu přečte jako datum). */
export const czDate = (iso: string) => iso.replace(/^(\d{4})-0?(\d{1,2})-0?(\d{1,2})$/, '$3.$2.$1');

/** CSV pro Excel: UTF-8 s BOM, oddělovač `;`, desetinná čárka, uvozovky podle RFC 4180. */
export function toCsv(headers: string[], rows: Cell[][]): string {
  const text = (c: Cell): string => {
    if (c === null) return '';
    if (typeof c === 'number') return String(c).replace('.', ',');
    if (typeof c === 'object') return czDate(c.date);
    // Text začínající znakem vzorce by Excel spustil jako vzorec.
    return /^[=+\-@\t\r]/.test(c) ? `'${c}` : c;
  };
  const quote = (s: string) => (/[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [headers, ...rows.map((r) => r.map(text))].map((r) => r.map((s) => quote(String(s))).join(';'));
  return `﻿${lines.join('\r\n')}\r\n`;
}
