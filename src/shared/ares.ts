import { bareName, code, hasOwnCompany, isOwn } from './finance';
import { fold } from './folders';
import type { AresRecord, DocFacts, OwnCompany } from './types';

/** IČO z textu doplněné nulami na 8 číslic; cizí identifikátor (písmena, příliš dlouhý) není IČO. */
export function normalizeIco(text: string | undefined): string | undefined {
  const digits = (text ?? '').replace(/[\s.-]/g, '');
  return /^\d{5,8}$/.test(digits) ? digits.padStart(8, '0') : undefined;
}

/** Strana dokumentu, kterou má smysl ověřit: dodavatel, u vydané faktury (dodavatel jsem já) odběratel. */
export function aresTarget(facts: DocFacts | undefined, own?: OwnCompany): { ico: string; name: string } | undefined {
  if (!facts) return undefined;
  const mine = hasOwnCompany(own) && isOwn(own, facts.supplier ?? '', facts.supplierVat ?? '', facts.supplierId ?? '');
  const [name, id] = mine ? [facts.customer, facts.customerId] : [facts.supplier, facts.supplierId];
  const ico = normalizeIco(id);
  return ico ? { ico, name: name ?? '' } : undefined;
}

/** Odpověď ARES (`ekonomicke-subjekty/{ico}`); bez jména a IČO undefined. */
export function parseAres(json: unknown): AresRecord | undefined {
  const j = json as { ico?: unknown; obchodniJmeno?: unknown; dic?: unknown; sidlo?: { textovaAdresa?: unknown; nazevObce?: unknown; psc?: unknown } } | null;
  if (typeof j?.obchodniJmeno !== 'string' || typeof j.ico !== 'string') return undefined;
  const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
  return {
    ico: j.ico,
    name: j.obchodniJmeno,
    address: text(j.sidlo?.textovaAdresa),
    city: text(j.sidlo?.nazevObce),
    zip: text(j.sidlo?.psc),
    ...(typeof j.dic === 'string' && { vat: j.dic }),
  };
}

export type AresVerdict = { kind: 'ok' } | { kind: 'missing' } | { kind: 'name'; name: string } | { kind: 'address'; city: string };

/**
 * Porovná záznam z ARES s dokumentem: název (bez právní formy), pak sídlo.
 * Karta adresu nemá, proto se obec nebo PSČ ze sídla v ARES hledá v textu dokumentu; bez textu se sídlo neposuzuje.
 */
export function compareAres(record: AresRecord | null, name: string, text: string): AresVerdict {
  if (!record) return { kind: 'missing' };
  const [a, b] = [bareName(name), bareName(record.name)];
  if (a && b && a !== b && !(Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a)))) return { kind: 'name', name: record.name };
  const found = (fold(text).includes(fold(record.city)) && !!record.city) || (!!code(record.zip) && code(text).includes(code(record.zip)));
  return text.trim() && (record.city || record.zip) && !found ? { kind: 'address', city: record.city } : { kind: 'ok' };
}
