import { inText, pageLabel, printedPages, reference, toHtml, toPlain, type Lang } from '../shared/citation';
import { getLang, t } from '../shared/i18n';
import type { Job, Settings } from '../shared/types';
import { jobTitle, toast } from './dom';

const STYLE_NAME = { iso690: 'ČSN ISO 690', apa7: 'APA 7' };

let citation: Settings['citation'] = { enabled: true, style: 'iso690' };

/** Načte nastavení citací; volá se při otevření detailu, tlačítka se řídí poslední načtenou hodnotou. */
export async function refreshCitation() {
  citation = (await window.api.getSettings()).citation;
}
export const citationEnabled = () => citation.enabled;

export interface CopyOptions {
  /** Doslovný úryvek dokumentu. */
  quote?: string;
  /** Odpověď chatu (s ukazateli zdrojů [n]). */
  text?: string;
  /** Čísla stran PDF, ze kterých text pochází. */
  pdfPages: number[];
  translated: boolean;
}

async function writeClipboard(plain: string, html: string) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([plain], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
  } catch {
    await navigator.clipboard.writeText(plain);
  }
}

const para = (text: string) => `<p>${toHtml([{ text }])}</p>`;

/** Zkopíruje úryvek nebo odpověď chatu s citací (prostý text i HTML s kurzívou). */
export async function copyWithCitation(jobId: string, job: Job, opts: CopyOptions) {
  await refreshCitation();
  const lang: Lang = getLang();
  const card = await window.api.getCard(jobId).catch(() => null);
  const biblio = card?.biblio.title?.trim() ? card.biblio : null;
  const ownTranslation = opts.translated && job.targetLang !== job.sourceLang;
  const body = opts.quote !== undefined ? (lang === 'cs' ? `„${opts.quote}“` : `“${opts.quote}”`) : (opts.text ?? '').replace(/\s*\[\d+\]/g, '').replace(/ {2,}/g, ' ').trim();

  if (!card || !biblio) {
    const pages = opts.pdfPages.length ? `, ${lang === 'cs' ? 's.' : 'p.'} ${pageLabel(opts.pdfPages)}` : '';
    const text = `${body} (${jobTitle(job)}${pages})`;
    await writeClipboard(text, para(text));
    return toast(t('citation.missing'));
  }

  const pages = printedPages(biblio, card.type, opts.pdfPages);
  const cite = inText(biblio, citation.style, lang, pages, ownTranslation);
  const today = new Date().toISOString().slice(0, 10);
  const ref = reference(biblio, card.type, citation.style, lang, today);
  await writeClipboard(`${body} ${cite}\n\n${toPlain(ref)}`, `${para(`${body} ${cite}`)}<p>${toHtml(ref)}</p>`);
  toast(t('citation.copied', { style: STYLE_NAME[citation.style] }));
}
