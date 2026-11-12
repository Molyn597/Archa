import { t } from './i18n';
import { day } from './invoices';
import { applyTemplate } from './name-template';
import type { DocumentCard, Job } from './types';

type NamedJob = Pick<Job, 'name'>;
const SUBTITLE_MAX = 80;

const clean = (s: string | undefined) => (s ?? '').trim();
const fileTitle = (job: NamedJob) => job.name.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim() || job.name;

// Šablona názvu z Nastavení (jen když je zapnutá „Přejmenovat podle šablony“); nastavuje ji okno.
let nameTemplate: string | undefined;
export const setNameTemplate = (template?: string) => void (nameTemplate = template);

/** Název dokumentu pro seznamy: podle šablony (je-li zapnutá), jinak číslo faktury, předmět smlouvy, název z bibliografie, jinak název souboru. */
export function docTitle(job: NamedJob, card?: DocumentCard | null): string {
  const named = card && nameTemplate ? applyTemplate(card, nameTemplate) : '';
  if (named) return named;
  const f = card?.facts;
  if (card?.type === 'invoice' && clean(f?.number)) return t('doc.invoice', { number: clean(f?.number) });
  if (card?.type === 'contract' && clean(f?.subject)) return clean(f?.subject);
  return clean(card?.biblio?.title) || fileTitle(job);
}

/** Podtext pod názvem: u faktury dodavatel a předmět, u smlouvy strana a platnost, jinak první věta shrnutí. */
export function docSubtitle(_job: NamedJob, card?: DocumentCard | null): string {
  if (!card) return '';
  const f = card.facts;
  if (card.type === 'invoice') return [clean(f?.supplier), clean(f?.subject)].filter(Boolean).join(' · ');
  if (card.type === 'contract') return [clean(f?.parties?.[0]), clean(f?.validTo) && t('doc.validTo', { date: day(clean(f?.validTo)) })].filter(Boolean).join(' · ');
  const sentence = card.summary.trim().split(/(?<=[.!?])\s+/)[0] ?? '';
  return sentence.length > SUBTITLE_MAX ? `${sentence.slice(0, SUBTITLE_MAX).trimEnd()}…` : sentence;
}
