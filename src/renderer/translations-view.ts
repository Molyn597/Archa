import { docTitle } from '../shared/doc-title';
import { t } from '../shared/i18n';
import { noteTime } from '../shared/notifications';
import { recentTranslations } from '../shared/translations';
import type { DocumentCard, Job, Provider } from '../shared/types';
import { cleanError, h, ICONS, icon, MODES, progressBar, progressInfo, STATUS_TEXT, toast } from './dom';

export interface TranslationsHost {
  jobs(): Job[];
  cards(): Record<string, DocumentCard>;
  open(id: string): void;
  showSettings(): void;
  /** Poslední známý důvod, proč poskytovatel nejde použít (prázdný = připraven nebo ještě nezjištěno). */
  notReady(provider: Provider): string | null | undefined;
}

const codes = (job: Job) => `${job.sourceLang === 'auto' ? t('lang.autoShort') : job.sourceLang.toUpperCase()} → ${job.targetLang.toUpperCase()}`;

/** Stejné opakování jako v pruhu s chybou v detailu: překlad na místě, nahrání bez překladu přes retry. */
function retry(job: Job, button: HTMLButtonElement) {
  button.disabled = true;
  const again = job.translate === false ? window.api.retryJob(job.id, job.mode, undefined, { plain: true }) : window.api.translateJob(job.id, job.mode, job.targetLang);
  again.then(
    () => toast(t('detail.retryQueued', { name: job.name, mode: t(MODES[job.mode].title) })),
    (e) => {
      button.disabled = false;
      toast(cleanError(e), true);
    },
  );
}

function row(job: Job, host: TranslationsHost) {
  const title = docTitle(job, host.cards()[job.id]);
  const active = job.status === 'running' || job.status === 'queued';
  const head = h('span', { class: 'tr-title', title }, title);
  const lang = h('span', { class: 'tr-lang' }, codes(job));
  const actions = h('span', { class: 'tr-actions' });
  let state: HTMLElement;
  if (active) {
    const info = progressInfo(job);
    const percent = info.fraction === null ? '' : t('common.percent', { percent: Math.round(info.fraction * 100) });
    state = h('span', { class: 'tr-state tr-progress' }, progressBar(info.fraction), h('span', { class: 'tr-percent' }, percent), h('span', { class: 'tr-stage' }, info.label.replace(/ · .*$/, '')));
  } else if (job.status === 'error') {
    state = h('span', { class: 'tr-state tr-error', title: job.error ?? '' }, job.error ?? t(STATUS_TEXT.error));
    if (host.notReady(job.provider ?? 'local')) actions.append(h('button', { class: 'btn sm', type: 'button', onclick: host.showSettings }, t('error.openSettings')));
    const again = h('button', { class: 'btn sm', type: 'button' }, t('error.retry'));
    again.addEventListener('click', () => retry(job, again));
    actions.append(again);
  } else {
    const when = noteTime(job.finishedAt ?? job.createdAt, Date.now());
    state = h('span', { class: 'tr-state' }, job.status === 'done' ? when : t(STATUS_TEXT[job.status]));
    actions.append(h('button', { class: 'btn sm', type: 'button', onclick: () => host.open(job.id) }, t('translate.open')));
  }
  const dot = h('span', { class: `dot dot-${job.status}`, title: t(STATUS_TEXT[job.status]) });
  return h('div', { class: `tr-row${job.status === 'error' ? ' failed' : ''}` }, dot, head, lang, state, actions);
}

export function renderTranslations(container: HTMLElement, host: TranslationsHost) {
  const list = recentTranslations(host.jobs());
  container.replaceChildren(...(list.length ? list.map((j) => row(j, host)) : [h('div', { class: 'tr-empty' }, icon(ICONS.translate), t('translate.empty'))]));
}
