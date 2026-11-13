import { addDuration, findDurations, type Duration, type FoundDuration } from './duration';
import { docTitle } from './doc-title';
import { locale, t } from './i18n';
import { invoiceRows } from './invoices';
import { formatMoney } from './money';
import type { DocFacts, DocumentCard, Job, Project } from './types';

export type DeadlineKind = 'invoiceDue' | 'contractEnd' | 'contractNotice' | 'projectDeadline' | 'warranty';

export interface Deadline {
  kind: DeadlineKind;
  /** RRRR-MM-DD. */
  date: string;
  jobId?: string;
  projectId?: string;
  title: string;
  detail?: string;
  overdue: boolean;
}

export type DeadlineGroup = 'overdue' | 'week' | 'month' | 'later';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Smlouvy a projekty po termínu zmizí po této době (nezaplacené faktury zůstávají).
const OVERDUE_KEEP_DAYS = 60;
const ENDED_KEEP_DAYS = 30;
const BEFORE = /^\s*(před|before|vor|prior)/i;
const RENEW_WORD = /(?:^|[\s,;(])(o|by|um|for|vždy|každý|každé|each|every|jeweils)\s*$/i;
const HAS_BEFORE = /před|before|vor\b|prior/i;
const NEGATIVE = /^\s*(ne|no|none|nein|žádn\w*)\b/i;

const clean = (s: string | undefined) => (s ?? '').trim();
const dur = (d: FoundDuration): Duration => ({ ...(d.days !== undefined && { days: d.days }), ...(d.months !== undefined && { months: d.months }) });

/** Z textu o automatickém prodloužení: délka prodloužení a lhůta „před koncem“ (každá jen když ji jde rozlišit). */
function splitRenewal(text: string): { renew?: FoundDuration; notice?: FoundDuration } {
  const found = findDurations(text);
  const notice = found.find((d) => BEFORE.test(text.slice(d.end)));
  const rest = found.filter((d) => d !== notice);
  // Prodloužení je údaj u slov „o / by / um / vždy“; bez nich stačí první údaj, ale jen když text lhůtu „před koncem“ nezmiňuje.
  const renew = rest.find((d) => RENEW_WORD.test(text.slice(0, d.index))) ?? (HAS_BEFORE.test(text) ? undefined : rest[0]);
  return { renew, notice };
}

/** Přidá den k datu RRRR-MM-DD (kladné i záporné). */
const shift = (iso: string, days: number) => addDuration(iso, { days: Math.abs(days) }, days < 0 ? -1 : 1);

const ISO_IN_TEXT = /(\d{4})-(\d{2})-(\d{2})/;
const CZ_IN_TEXT = /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/;

/** Konec záruky RRRR-MM-DD: datum v textu, jinak doba (měsíce, roky) od vystavení; neznámý konec undefined. */
export function warrantyEnd(facts: Pick<DocFacts, 'warranty' | 'issued'> | undefined): string | undefined {
  const text = clean(facts?.warranty);
  if (!text) return undefined;
  const issued = clean(facts?.issued);
  const iso = text.match(ISO_IN_TEXT);
  const cz = text.match(CZ_IN_TEXT);
  const date = iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : cz ? `${cz[3]}-${cz[2]!.padStart(2, '0')}-${cz[1]!.padStart(2, '0')}` : undefined;
  // Datum před vystavením je spíš začátek („od 18. 6. 2025 na 24 měsíců“): pak rozhoduje doba.
  if (date && !Number.isNaN(Date.parse(date)) && !(DATE.test(issued) && date <= issued)) return date;
  const term = findDurations(text)[0];
  return term && DATE.test(issued) ? addDuration(issued, dur(term)) : undefined;
}

function contractDeadlines(job: Job, card: DocumentCard, today: string): Deadline[] {
  const f = card.facts ?? {};
  // Bez data konce: začátek + doba trvání („od 1. 4. 2026 na 24 měsíců“).
  const term = !f.validTo && f.validFrom && DATE.test(f.validFrom) && f.period ? findDurations(f.period)[0] : undefined;
  const validTo = f.validTo ?? (term && shift(addDuration(f.validFrom!, dur(term)), -1));
  if (!validTo || !DATE.test(validTo)) return [];
  const autoRenewal = clean(f.autoRenewal);
  const renewing = Boolean(autoRenewal) && !NEGATIVE.test(autoRenewal);
  const split = renewing ? splitRenewal(autoRenewal) : {};
  const title = clean(f.subject) || clean(f.parties?.[0]) || `${job.name}${job.ext}`;

  let end = validTo;
  let extended = false;
  if (end < today) {
    if (split.renew) {
      const step = dur(split.renew);
      // Ochrana proti nekonečné smyčce při nulové délce.
      for (let i = 0; end < today && i < 1000; i++) end = addDuration(end, step);
      extended = true;
    } else if (end < shift(today, -ENDED_KEEP_DAYS)) return [];
  }

  const out: Deadline[] = [{ kind: 'contractEnd', date: end, jobId: job.id, title, ...(extended && { detail: t('dl.extended') }), overdue: end < today }];

  // Výpovědní lhůta: z pole `notice`, jinak z údaje „před koncem“ v textu o prodloužení.
  const noticeText = clean(f.notice);
  const fromField = noticeText ? findDurations(noticeText)[0] : undefined;
  const notice = fromField ?? split.notice;
  if (notice) {
    const date = addDuration(end, dur(notice), -1);
    // U automaticky prodloužené smlouvy je lhůta pro tento cyklus už v minulosti: nic by se nedalo udělat.
    if (!(extended && date < today)) {
      out.push({
        kind: 'contractNotice',
        date,
        jobId: job.id,
        title,
        detail: t(renewing ? 'dl.noticeRenews' : 'dl.notice', { notice: notice.text }),
        overdue: date < today,
      });
    }
  }
  return out;
}

/** Termíny: splatnosti nezaplacených faktur, konce smluv, výpovědní lhůty a termíny projektů seřazené podle data. */
export function deadlines(input: {
  jobs: Job[];
  cards: Record<string, DocumentCard | null | undefined>;
  paid: Record<string, number> | undefined;
  projects: Project[];
  today: string;
}): Deadline[] {
  const { jobs, cards, paid, projects, today } = input;
  const out: Deadline[] = [];

  for (const r of invoiceRows(jobs, cards, paid, today)) {
    if (r.status === 'paid' || !r.due) continue;
    // Parsovaná částka ve formátu aplikace, jinak surový text z karty.
    const amount = r.total !== undefined ? formatMoney(r.total, r.currency, locale()) : clean(cards[r.jobId]?.facts?.amount);
    out.push({
      kind: 'invoiceDue',
      date: r.due,
      jobId: r.jobId,
      title: r.supplier || r.number || r.file,
      ...(amount || r.number ? { detail: [amount, r.number].filter(Boolean).join(' · ') } : {}),
      overdue: r.due < today,
    });
  }

  for (const job of jobs) {
    const card = cards[job.id];
    if (card?.type === 'contract') out.push(...contractDeadlines(job, card, today));
  }

  for (const p of projects) {
    if (p.deadline && DATE.test(p.deadline)) out.push({ kind: 'projectDeadline', date: p.deadline, projectId: p.id, title: p.name, overdue: p.deadline < today });
  }

  // Záruka: u jakéhokoli dokladu s údajem o záruce; skončená už nikoho nezajímá.
  for (const job of jobs) {
    const card = cards[job.id];
    const end = warrantyEnd(card?.facts);
    if (!card || !end || end < today) continue;
    const supplier = clean(card.facts?.supplier);
    out.push({ kind: 'warranty', date: end, jobId: job.id, title: clean(card.facts?.subject) || docTitle(job, card), ...(supplier && { detail: supplier }), overdue: false });
  }

  const cutoff = shift(today, -OVERDUE_KEEP_DAYS);
  return out.filter((d) => d.kind === 'invoiceDue' || d.date >= cutoff).sort((a, b) => a.date.localeCompare(b.date));
}

/** Rozdělení podle blízkosti: po termínu, do 7 dní, do 31 dní a později. */
export function groupDeadlines(items: Deadline[], today: string): Record<DeadlineGroup, Deadline[]> {
  const week = shift(today, 7);
  const month = shift(today, 31);
  const groups: Record<DeadlineGroup, Deadline[]> = { overdue: [], week: [], month: [], later: [] };
  for (const d of items) {
    const g: DeadlineGroup = d.date < today ? 'overdue' : d.date <= week ? 'week' : d.date <= month ? 'month' : 'later';
    groups[g].push(d);
  }
  return groups;
}
