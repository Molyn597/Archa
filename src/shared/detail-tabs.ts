import type { DocType, Job, Segment } from './types';

/** Pohled v detailu dokumentu; horní záložky jsou jen tři, „translation“ skupina má uvnitř přepínač. */
export type View = 'about' | 'original' | 'translation' | 'compare' | 'translated-pdf' | 'side-by-side';
export type TopTab = 'about' | 'original' | 'translation';

/** Dokument jiného jazyka než originál, který už doběhl (bez segmentů, např. pro seznam). */
export const wasTranslated = (job: Pick<Job, 'status' | 'sourceLang' | 'targetLang'>) =>
  job.status === 'done' && job.sourceLang !== 'auto' && job.sourceLang !== job.targetLang;

/** Má smysl záložka Překlad: cílový jazyk se liší a existují přeložené odstavce (nebo se teprve vybírají). */
export function isTranslated(job: Pick<Job, 'status' | 'sourceLang' | 'targetLang'>, segments: Pick<Segment, 'translation' | 'layoutOnly'>[]) {
  if (job.sourceLang === job.targetLang) return false;
  return job.status === 'picking' || segments.some((s) => !s.layoutOnly && s.translation !== undefined);
}

export const topTab = (view: View): TopTab => (view === 'about' || view === 'original' ? view : 'translation');

/** Volby přepínače uvnitř záložky Překlad; PDF volby jen když existuje přeložené PDF. */
export const translationViews = (hasPdf: boolean): View[] => (hasPdf ? ['translation', 'compare', 'translated-pdf', 'side-by-side'] : ['translation', 'compare']);

/** Výchozí pohled při otevření: faktura a smlouva O dokumentu, jiný přeložený dokument Překlad. */
export function defaultView(translated: boolean, type?: DocType): View {
  if (type === 'invoice' || type === 'contract') return 'about';
  return translated ? 'compare' : 'about';
}

/** Pohled, který zůstane dostupný, když se změní stav dokumentu (např. zmizelo přeložené PDF). */
export function usableView(view: View, translated: boolean, hasPdf: boolean): View {
  if (topTab(view) !== 'translation') return view;
  if (!translated) return 'about';
  return translationViews(hasPdf).includes(view) ? view : 'compare';
}
