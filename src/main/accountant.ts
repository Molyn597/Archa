import { strToU8, zipSync, type Zippable } from 'fflate';
import { t, type MessageKey } from '../shared/i18n';
import { packageBase, packageEntries, uniqueBases, type PackageInclude } from '../shared/accountant';
import { exportTable, invoiceRows, toCsv, type InvoiceRow } from '../shared/invoices';
import { applyTemplate } from '../shared/name-template';
import type { DocumentCard, Job } from '../shared/types';
import { buildXlsx } from './xlsx';

/** Přehled faktur jako soubor .xlsx nebo .csv (sdílí export z tabulky Faktur i balíček pro účetní). */
export function invoiceFile(rows: InvoiceRow[], format: 'xlsx' | 'csv'): Uint8Array | string {
  const table = exportTable(
    rows,
    (key) => t(`inv.col.${key}` as MessageKey),
    (s) => t(`inv.status.${s}` as MessageKey),
  );
  return format === 'xlsx' ? buildXlsx(t('inv.title'), table.headers, table.rows) : toCsv(table.headers, table.rows);
}

export interface PackageInput {
  /** Faktury v pořadí, v jakém půjdou do přehledu. */
  jobs: Job[];
  cards: Record<string, DocumentCard | null | undefined>;
  paid: Record<string, number> | undefined;
  include: PackageInclude;
  /** Šablona názvů souborů (nastavení). */
  template: string;
  today: string;
  readInput(job: Job): Promise<Uint8Array>;
  /** Původní XML ISDOC přiložené k dokumentu; bez něj undefined. */
  readIsdoc(job: Job): Promise<string | undefined>;
}

/** ZIP pro účetní: PDF/ (originály), ISDOC/, Prehled.xlsx a Prehled.csv podle výběru. Vrací ZIP a cesty souborů v něm. */
export async function buildPackage(input: PackageInput): Promise<{ zip: Uint8Array; files: string[] }> {
  const rows = invoiceRows(input.jobs, input.cards, input.paid, input.today);
  const byId = new Map(input.jobs.map((j) => [j.id, j]));
  const bases = uniqueBases(rows.map((r) => ({ id: r.jobId, base: packageBase(applyTemplate(input.cards[r.jobId]!, input.template), byId.get(r.jobId)!.name) })));
  const entries = packageEntries(
    rows.map((r) => ({ jobId: r.jobId, base: bases.get(r.jobId)!, ext: byId.get(r.jobId)!.ext.toLowerCase(), isdoc: r.isdoc && byId.get(r.jobId)!.ext.toLowerCase() === '.pdf' })),
    input.include,
  );
  const zip: Zippable = {};
  for (const e of entries) {
    const job = e.jobId ? byId.get(e.jobId)! : undefined;
    if (e.kind === 'original') zip[e.path] = [await input.readInput(job!), { level: 0 }];
    else if (e.kind === 'isdoc') {
      const xml = await input.readIsdoc(job!);
      if (xml) zip[e.path] = strToU8(xml);
    } else {
      const file = invoiceFile(rows, e.kind);
      zip[e.path] = typeof file === 'string' ? strToU8(file) : file;
    }
  }
  return { zip: zipSync(zip), files: Object.keys(zip) };
}
