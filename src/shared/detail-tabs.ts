import type { DocType, Job, Segment } from './types';

/** Pohled na dokument; záložka Překlad má uvnitř přepínač pohledů. */
export type View = 'original' | 'translation' | 'compare' | 'translated-pdf' | 'side-by-side';
/** Záložky s informacemi o dokumentu (na celou šířku místo dokumentu). */
export type InfoTab = 'overview' | 'links' | 'file';
/** Co je v detailu otevřené: pohled na dokument, nebo informační záložka. */
export type Tab = View | InfoTab;
/** Horní řada záložek detailu. */
export type TopTab = 'original' | 'translation' | InfoTab;
export const TOP_TABS: TopTab[] = ['original', 'translation', 'overview', 'links', 'file'];

export const isInfoTab = (tab: Tab): tab is InfoTab => tab === 'overview' || tab === 'links' || tab === 'file';

/** Dokument jiného jazyka než originál, který už doběhl (bez segmentů, např. pro seznam). */
export const wasTranslated = (job: Pick<Job, 'status' | 'sourceLang' | 'targetLang'>) =>
  job.status === 'done' && job.sourceLang !== 'auto' && job.sourceLang !== job.targetLang;

/** Má smysl záložka Překlad: cílový jazyk se liší a existují přeložené odstavce (nebo se teprve vybírají). */
export function isTranslated(job: Pick<Job, 'status' | 'sourceLang' | 'targetLang'>, segments: Pick<Segment, 'translation' | 'layoutOnly'>[]) {
  if (job.sourceLang === job.targetLang) return false;
  return job.status === 'picking' || segments.some((s) => !s.layoutOnly && s.translation !== undefined);
}

export const topTab = (tab: Tab): TopTab => (tab === 'original' || isInfoTab(tab) ? tab : 'translation');

/** Záložky, které dokument má; Překlad jen u přeloženého. */
export const topTabs = (translated: boolean): TopTab[] => TOP_TABS.filter((k) => translated || k !== 'translation');

/** Volby přepínače uvnitř záložky Překlad; PDF volby jen když existuje přeložené PDF. */
export const translationViews = (hasPdf: boolean): View[] => (hasPdf ? ['translation', 'compare', 'translated-pdf', 'side-by-side'] : ['translation', 'compare']);

/** Výchozí záložka při otevření: faktura a smlouva Přehled, přeložený dokument Srovnání, jinak originál. */
export function defaultTab(type: DocType | undefined, translated: boolean): Tab {
  if (type === 'invoice' || type === 'contract') return 'overview';
  return translated ? 'compare' : 'original';
}

/** Záložka, která zůstane dostupná, když se změní stav dokumentu (např. zmizelo přeložené PDF). */
export function usableView(tab: Tab, translated: boolean, hasPdf: boolean): Tab {
  if (topTab(tab) !== 'translation') return tab;
  if (!translated) return 'original';
  return translationViews(hasPdf).includes(tab as View) ? tab : 'compare';
}
