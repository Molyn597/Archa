import { englishName } from '../shared/languages';
import { flat } from '../shared/risks';
import type { ContractRisk, RiskSeverity } from '../shared/types';
import { extractJsonObject } from './review';

const MAX_RISKS = 6;
const MAX_QUOTE = 400;
const ORDER: RiskSeverity[] = ['high', 'medium', 'low'];

/** `side` = strana, za kterou se smlouva posuzuje (vlastní firma); bez ní ta, která smlouvu podepisuje jako zákazník/nájemce/objednatel. */
export function contractRisksPrompt(text: string, target: string, side?: string) {
  const lang = englishName(target);
  const party = side ? `the party "${side}"` : 'the party that signs this contract as customer, tenant, buyer or client';
  return (
    `You review a contract for ${party}. Find clauses that are unusual or disadvantageous for that party compared with common practice ` +
    'in Czech and EU business contracts, and return JSON only, without any other text:\n' +
    '{"risks": [{"severity": "high" | "medium" | "low", "title": "...", "quote": "...", "why": "...", "tip": "..."}]}\n' +
    'Look especially for: automatic renewal or a long or date-bound notice period; contractual penalties that are high, daily or one-sided; ' +
    'unilateral changes of price, terms or general conditions; price indexation without a cap; exclusion or limitation of the other party’s liability ' +
    'or a waiver of damages; long payment terms (over 60 days) or non-refundable advances; termination rights for one party only; exclusivity, ' +
    'non-compete or lock-in; an arbitration clause, foreign courts or foreign law; personal guarantees, promissory notes or assignment of receivables; ' +
    'transfer of intellectual property beyond the purpose; hidden fees.\n' +
    'Rules: report only clauses that are really in the text, at most 6, the most serious first. Do not report standard, balanced clauses. ' +
    'quote is the exact wording copied from the document (one sentence or a short passage, max 300 characters, in the document’s language, no changes). ' +
    `title (max 8 words), why (1–2 sentences: what it means for ${side ? 'that party' : 'the signing party'}) and tip (one short practical suggestion, or "") are in ${lang}. ` +
    'severity: high = can cost significant money or lock the party in; medium = clearly one-sided but limited; low = worth knowing. ' +
    'If nothing is unusual, return {"risks": []}.' +
    `\n\nCONTRACT:\n${text}`
  );
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Rizika z odpovědi modelu; citace, která v textu smlouvy není, se zahodí (model si ji vymyslel nebo přeformuloval). */
export function parseRisks(answer: string, documentText: string): ContractRisk[] | undefined {
  const d = extractJsonObject(answer);
  if (!d || !Array.isArray(d.risks)) return undefined;
  const doc = flat(documentText);
  const out: ContractRisk[] = [];
  for (const r of d.risks as Record<string, unknown>[]) {
    const severity = str(r?.severity).toLowerCase() as RiskSeverity;
    const quote = str(r?.quote).slice(0, MAX_QUOTE);
    const title = str(r?.title);
    if (!ORDER.includes(severity) || !title || !quote || !doc.includes(flat(quote))) continue;
    out.push({ severity, title, quote, why: str(r?.why), ...(str(r?.tip) && { tip: str(r?.tip) }) });
  }
  return out.sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity)).slice(0, MAX_RISKS);
}
