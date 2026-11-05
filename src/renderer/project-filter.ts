import { fold } from '../shared/folders';
import type { DocumentCard, Job } from '../shared/types';

/** Dokumenty, jejichž název, autor nebo klíčová slova obsahují všechna slova z dotazu (bez diakritiky a velikosti písmen). */
export function filterSources<T extends { job: Job; card?: DocumentCard | null }>(items: T[], query: string): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter(({ job, card }) => {
    const text = fold([job.name, card?.biblio.title, card?.biblio.authors.map((a) => `${a.given} ${a.family}`).join(' '), card?.keywords.join(' ')].filter(Boolean).join(' '));
    return words.every((w) => text.includes(w));
  });
}
