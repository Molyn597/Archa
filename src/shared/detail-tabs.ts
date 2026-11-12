import type { Job, Segment } from './types';

/** Pohled v dokumentu vlevo; horní přepínač má jen Dokument a Překlad, Překlad má uvnitř přepínač pohledů. */
export type View = 'original' | 'translation' | 'compare' | 'translated-pdf' | 'side-by-side';
export type TopTab = 'original' | 'translation';
/** Záložky informačního sloupce vedle dokumentu. */
export type InfoTab = 'overview' | 'links' | 'file';
export const INFO_TABS: InfoTab[] = ['overview', 'links', 'file'];

/** Dokument jiného jazyka než originál, který už doběhl (bez segmentů, např. pro seznam). */
export const wasTranslated = (job: Pick<Job, 'status' | 'sourceLang' | 'targetLang'>) =>
  job.status === 'done' && job.sourceLang !== 'auto' && job.sourceLang !== job.targetLang;

/** Má smysl záložka Překlad: cílový jazyk se liší a existují přeložené odstavce (nebo se teprve vybírají). */
export function isTranslated(job: Pick<Job, 'status' | 'sourceLang' | 'targetLang'>, segments: Pick<Segment, 'translation' | 'layoutOnly'>[]) {
  if (job.sourceLang === job.targetLang) return false;
  return job.status === 'picking' || segments.some((s) => !s.layoutOnly && s.translation !== undefined);
}

export const topTab = (view: View): TopTab => (view === 'original' ? view : 'translation');

/** Volby přepínače uvnitř záložky Překlad; PDF volby jen když existuje přeložené PDF. */
export const translationViews = (hasPdf: boolean): View[] => (hasPdf ? ['translation', 'compare', 'translated-pdf', 'side-by-side'] : ['translation', 'compare']);

/** Výchozí pohled při otevření: přeložený dokument Srovnání, jinak originál. */
export const defaultView = (translated: boolean): View => (translated ? 'compare' : 'original');

/** Pohled, který zůstane dostupný, když se změní stav dokumentu (např. zmizelo přeložené PDF). */
export function usableView(view: View, translated: boolean, hasPdf: boolean): View {
  if (topTab(view) !== 'translation') return view;
  if (!translated) return 'original';
  return translationViews(hasPdf).includes(view) ? view : 'compare';
}
