import type { DocFacts } from '../shared/types';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
      e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m),
    )
    .trim();

/** Vnitřek prvního prvku `name` (s libovolným prefixem jmenného prostoru); nenalezeno = undefined. */
function inner(xml: string, name: string): string | undefined {
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*?)?(?<!/)>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}\\s*>`).exec(xml);
  return m?.[1];
}

/** Hodnota prvku podle cesty vnořených prvků. */
function at(xml: string | undefined, ...path: string[]): string | undefined {
  let cur = xml;
  for (const name of path) {
    if (cur === undefined) return undefined;
    cur = inner(cur, name);
  }
  const text = cur === undefined ? undefined : decode(cur);
  return text || undefined;
}

/** Částka „12 100,00 CZK“: mezery po tisících, desetinná čárka. */
function money(value: string | undefined, currency: string | undefined) {
  const n = Number(value);
  if (!value || !Number.isFinite(n)) return undefined;
  const [int, dec] = Math.abs(n).toFixed(2).split('.');
  const text = `${n < 0 ? '-' : ''}${int.replace(/\B(?=(\d{3})+$)/g, ' ')},${dec}`;
  return currency ? `${text} ${currency}` : text;
}

/** Strana faktury; blok se nejdřív vyřízne, protože Party je pod dodavatelem i odběratelem. */
function party(xml: string, wrapper: string) {
  const p = inner(inner(xml, wrapper) ?? '', 'Party');
  return { name: at(p, 'PartyName', 'Name'), id: at(p, 'PartyIdentification', 'ID'), vat: at(p, 'PartyTaxScheme', 'CompanyID') };
}

/** Údaje faktury z XML ve formátu ISDOC 6.x; bez rozpoznatelných údajů undefined. */
export function parseIsdoc(xml: string): DocFacts | undefined {
  // Řádky faktury mají vlastní Note, TaxTotal i částky; hlavička se hledá bez nich.
  const head = xml.replace(/<(?:[\w.-]+:)?InvoiceLines[\s>][\s\S]*?<\/(?:[\w.-]+:)?InvoiceLines\s*>/, '');
  if (!inner(head, 'Invoice') && !inner(head, 'ID')) return undefined;
  const currency = at(head, 'LocalCurrencyCode');
  const totals = inner(head, 'LegalMonetaryTotal');
  const taxTotal = inner(head, 'TaxTotal')?.replace(/<(?:[\w.-]+:)?TaxSubTotal[\s>][\s\S]*?<\/(?:[\w.-]+:)?TaxSubTotal\s*>/g, '');
  const details = inner(inner(head, 'PaymentMeans') ?? '', 'Details');
  const supplier = party(head, 'AccountingSupplierParty');
  const customer = party(head, 'AccountingCustomerParty');
  const facts: DocFacts = {
    subject: at(xml, 'InvoiceLines', 'InvoiceLine', 'Item', 'Description') ?? at(head, 'Note'),
    number: at(head, 'ID'),
    vs: at(details, 'VariableSymbol'),
    supplier: supplier.name,
    supplierId: supplier.id,
    supplierVat: supplier.vat,
    customer: customer.name,
    customerId: customer.id,
    customerVat: customer.vat,
    net: money(at(totals, 'TaxExclusiveAmount'), currency),
    vat: money(at(taxTotal, 'TaxAmount'), currency),
    amount: money(at(totals, 'PayableAmount') ?? at(totals, 'TaxInclusiveAmount'), currency),
    issued: at(head, 'IssueDate'),
    due: at(details, 'PaymentDueDate'),
  };
  const clean = Object.fromEntries(Object.entries(facts).filter(([, v]) => v)) as DocFacts;
  return Object.keys(clean).length ? clean : undefined;
}
