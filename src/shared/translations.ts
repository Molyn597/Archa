import type { Job } from './types';

type TranslationJob = Pick<Job, 'translate' | 'sourceLang' | 'targetLang' | 'status' | 'trashedAt' | 'createdAt'>;

/** Úloha je překlad, pokud se nezakládala jen jako karta (`translate: false`) a cílový jazyk se liší; zrušené a smazané se neukazují. */
export const isTranslation = (job: TranslationJob) => job.translate !== false && job.sourceLang !== job.targetLang && job.status !== 'cancelled' && !job.trashedAt;

/** Poslední překlady, nejnovější první. */
export function recentTranslations<T extends TranslationJob>(jobs: Iterable<T>, limit = 20): T[] {
  return [...jobs]
    .filter(isTranslation)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

/** Celkový postup úloh (0–1); `null`, když ho žádná z nich zatím neumí určit. */
export function overallFraction(fractions: (number | null)[]): number | null {
  const known = fractions.filter((f): f is number => f !== null);
  return known.length ? known.reduce((sum, f) => sum + f, 0) / known.length : null;
}
