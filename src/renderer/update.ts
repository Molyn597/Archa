import { t } from '../shared/i18n';
import type { UpdateCheck, UpdateProgress } from '../shared/types';
import { h, icon, ICONS, toast, toastAction } from './dom';

type Latest = NonNullable<UpdateCheck['latest']>;

let onProgress: ((p: UpdateProgress) => void) | null = null;

/** Stáhne aktualizaci a průběh hlásí přes `label` (bez procent = zatím neznámá velikost). */
async function download(latest: Latest, label: (percent?: number) => void) {
  if (!onProgress) window.api.onUpdateProgress((p) => onProgress?.(p));
  label();
  onProgress = (p) => label(p.total > 0 ? Math.min(100, Math.floor((p.received / p.total) * 100)) : undefined);
  const r = await window.api.downloadUpdate().catch((e: Error) => ({ ok: false as const, error: e.message, url: latest.url }));
  onProgress = null;
  return r;
}

const progressText = (percent?: number) => (percent === undefined ? t('update.downloading') : t('update.downloadingPercent', { percent }));

/** Karta „Je k dispozici nová verze“: změny, stažení s průběhem a po stažení další krok podle systému. */
export function updateCard(latest: Latest, onLater?: () => void) {

  const message = h('p', { class: 'update-msg' }, '');
  message.hidden = true;
  // Popis vydání je v Markdownu; tučné hvězdičky by v prostém textu jen překážely.
  const notes = h('pre', { class: 'update-notes' }, latest.notes.replace(/\*\*/g, '') || t('update.noNotes'));
  notes.hidden = true;
  const toggle = h('button', { class: 'link', type: 'button', 'aria-expanded': 'false' }, t('update.whatsNew'));
  toggle.addEventListener('click', () => {
    notes.hidden = !notes.hidden;
    toggle.setAttribute('aria-expanded', String(!notes.hidden));
  });
  const install = h('button', { class: 'btn primary', type: 'button' }, t('update.install'));
  const actions = h('div', { class: 'update-actions' }, install);
  if (onLater) actions.append(h('button', { class: 'btn', type: 'button', onclick: onLater }, t('update.later')));

  const say = (text: string, error = false) => {
    message.textContent = text;
    message.className = error ? 'update-msg error' : 'update-msg';
    message.hidden = false;
  };

  let releaseShown = false;
  install.addEventListener('click', async () => {
    install.disabled = true;
    message.hidden = true;
    const r = await download(latest, (percent) => (install.textContent = progressText(percent)));
    if (!r.ok) {
      install.textContent = t('update.install');
      install.disabled = false;
      say(t('update.error', { error: r.error }), true);
      if (!releaseShown) {
        releaseShown = true;
        actions.append(h('button', { class: 'btn', type: 'button', onclick: () => void window.api.openUrl(r.url ?? latest.url) }, t('update.openRelease')));
      }
      return;
    }
    install.hidden = true;
    if (r.platform === 'windows') return say(t('update.installing'));
    say(t('update.macStep'));
    actions.append(h('button', { class: 'btn primary', type: 'button', onclick: () => void window.api.quitApp() }, t('update.quit')));
  });

  return h(
    'div',
    { class: 'update-card' },
    h('div', { class: 'update-head' }, h('strong', {}, t('update.available', { version: latest.version })), toggle),
    notes,
    message,
    actions,
  );
}

/** Kompaktní jednořádková nabídka aktualizace v levém panelu: stejné stažení jako v kartě, hlášky jako toast. */
export function updateRow(latest: Latest, onLater: () => void) {

  const action = h('button', { class: 'link', type: 'button' }, t('update.get'));
  let downloaded = false;
  action.addEventListener('click', async () => {
    if (downloaded) return void window.api.quitApp();
    action.disabled = true;
    const r = await download(latest, (percent) => (action.textContent = progressText(percent)));
    if (!r.ok) {
      action.textContent = t('update.get');
      action.disabled = false;
      toastAction(t('update.error', { error: r.error }), t('update.openRelease'), () => void window.api.openUrl(r.url ?? latest.url));
      return;
    }
    if (r.platform === 'windows') {
      action.hidden = true;
      return toast(t('update.installing'));
    }
    toast(t('update.macStep'));
    downloaded = true;
    action.textContent = t('update.restart');
    action.disabled = false;
  });

  return [
    icon(ICONS.sparkle),
    h('span', { class: 'grow', title: t('update.available', { version: latest.version }) }, t('update.ready', { version: latest.version })),
    action,
    h('button', { class: 'icon-btn', type: 'button', title: t('update.later'), 'aria-label': t('update.later'), onclick: onLater }, icon(ICONS.x)),
  ];
}
