import { bareName, hasOwnCompany, isOwn } from './finance';
import type { DocumentCard, Library, OwnCompany } from './types';

/** Nejmenší podobnost (kosinus průměrných vektorů), od které se dokument navrhne jako související. */
export const SIMILAR_MIN = 0.75;
export const RELATED_MAX = 5;

/** Vektor dokumentu: normalizovaný průměr vektorů jeho úseků. */
export function meanVector(vectors: Float32Array[]): Float32Array | undefined {
  if (!vectors.length) return undefined;
  const sum = new Float32Array(vectors[0].length);
  for (const v of vectors) if (v.length === sum.length) for (let i = 0; i < sum.length; i++) sum[i] += v[i];
  const len = Math.hypot(...sum) || 1;
  return sum.map((x) => x / len);
}

const cosine = (a: Float32Array, b: Float32Array) => (a.length === b.length ? a.reduce((s, x, i) => s + x * b[i], 0) : 0);

/** Protistrany dokumentu (klíč bez právní formy → název); moje firma se vynechá, bez ní se u faktury neberou odběratelé. */
export function counterparties(card: DocumentCard | null | undefined, own?: OwnCompany): Map<string, string> {
  const f = card?.facts;
  const out = new Map<string, string>();
  if (!f) return out;
  const known = hasOwnCompany(own);
  const candidates: [string | undefined, string?, string?][] = [[f.supplier, f.supplierVat, f.supplierId], [f.customer, f.customerVat, f.customerId], ...(f.parties ?? []).map((p): [string] => [p])];
  candidates.forEach(([name, vat, id], i) => {
    // Bez vyplněné firmy je odběratel (index 1) nejspíš já.
    if (!name?.trim() || (known ? isOwn(own, name, vat ?? '', id ?? '') : i === 1)) return;
    const key = bareName(name);
    if (key && !out.has(key)) out.set(key, name.trim());
  });
  return out;
}

export interface RelatedItem {
  id: string;
  reason: { kind: 'party'; party: string } | { kind: 'similar' };
}

/**
 * Návrhy souvisejících dokumentů: nejdřív stejná protistrana, pak nejpodobnější podle vektorů nad prahem.
 * Už potvrzené a odmítnuté dokumenty se nenabízejí.
 */
export function suggestRelated(
  self: { id: string; vector?: Float32Array; parties: Map<string, string> },
  others: { id: string; vector?: Float32Array; parties: Map<string, string> }[],
  skip: ReadonlySet<string>,
): RelatedItem[] {
  const scored = others
    .filter((o) => o.id !== self.id && !skip.has(o.id))
    .map((o) => {
      const key = [...self.parties.keys()].find((k) => o.parties.has(k));
      const score = self.vector && o.vector ? cosine(self.vector, o.vector) : 0;
      return { id: o.id, party: key && self.parties.get(key)!, score };
    })
    .filter((o) => o.party || o.score >= SIMILAR_MIN);
  scored.sort((a, b) => Number(!!b.party) - Number(!!a.party) || b.score - a.score);
  return scored.slice(0, RELATED_MAX).map((o): RelatedItem => ({ id: o.id, reason: o.party ? { kind: 'party', party: o.party } : { kind: 'similar' } }));
}

const addBoth = (map: Record<string, string[]>, a: string, b: string) => {
  for (const [x, y] of [[a, b], [b, a]]) if (!map[x]?.includes(y)) (map[x] ??= []).push(y);
};
const dropBoth = (map: Record<string, string[]> | undefined, a: string, b: string) => {
  if (!map) return;
  for (const [x, y] of [[a, b], [b, a]]) {
    map[x] = (map[x] ?? []).filter((id) => id !== y);
    if (!map[x].length) delete map[x];
  }
};

/** Potvrdí (`linked`), nebo odmítne a zruší vazbu mezi dokumenty; obojí platí oběma směry. */
export function setLink(library: Library, a: string, b: string, linked: boolean) {
  const [yes, no] = [(library.links ??= {}), (library.rejectedLinks ??= {})];
  addBoth(linked ? yes : no, a, b);
  dropBoth(linked ? no : yes, a, b);
  if (!Object.keys(yes).length) delete library.links;
  if (!Object.keys(no).length) delete library.rejectedLinks;
}
