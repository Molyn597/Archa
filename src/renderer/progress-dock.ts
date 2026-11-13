import { docTitle } from '../shared/doc-title';
import { t } from '../shared/i18n';
import { overallFraction } from '../shared/translations';
import type { DocumentCard, Job } from '../shared/types';
import { h, ICONS, icon, progressBar, progressInfo } from './dom';

export interface DockHost {
  jobs(): Job[];
  cards(): Record<string, DocumentCard>;
  open(id: string): void;
}

const RING = 2 * Math.PI * 22;
let host: DockHost;
let popOpen = false;
const dock = () => document.getElementById('pdock')!;
const percent = (fraction: number) => t('common.percent', { percent: Math.round(fraction * 100) });

function ring(fraction: number | null) {
  const svg = icon(`<circle class="pdock-track" cx="26" cy="26" r="22" /><circle class="pdock-arc" cx="26" cy="26" r="22" stroke-dasharray="${RING.toFixed(1)}" stroke-dashoffset="${(RING * (1 - (fraction ?? 0.28))).toFixed(1)}" />`);
  svg.setAttribute('viewBox', '0 0 52 52');
  svg.classList.add('pdock-ring');
  if (fraction === null) svg.classList.add('spin');
  return svg;
}

function jobRow(job: Job) {
  const info = progressInfo(job);
  const meta = [info.label, info.eta].filter(Boolean).join(' · ');
  return h(
    'div',
    { class: 'pdock-job' },
    h('div', { class: 'pdock-name', title: docTitle(job, host.cards()[job.id]) }, docTitle(job, host.cards()[job.id])),
    h('div', { class: 'pdock-meta' }, meta),
    h('div', { class: 'pdock-line' }, progressBar(info.fraction), h('span', { class: 'pdock-pct' }, info.fraction === null ? '' : percent(info.fraction))),
    h('button', { class: 'btn sm', type: 'button', onclick: () => ((popOpen = false), host.open(job.id), renderDock()) }, t('translate.open')),
  );
}

export function renderDock() {
  const active = host.jobs().filter((j) => j.status === 'running' || j.status === 'queued');
  const root = dock();
  root.hidden = !active.length;
  if (!active.length) {
    popOpen = false;
    return root.replaceChildren();
  }
  const fraction = overallFraction(active.map((j) => progressInfo(j).fraction));
  const label = t('dock.button', { count: active.length });
  const button = h(
    'button',
    { class: 'pdock-btn', type: 'button', title: label, 'aria-label': label, 'aria-expanded': String(popOpen), onclick: () => ((popOpen = !popOpen), renderDock()) },
    ring(fraction),
    icon(ICONS.translate),
    h('span', { class: 'pdock-percent' }, fraction === null ? '' : percent(fraction)),
    active.length > 1 ? h('span', { class: 'pdock-badge' }, String(active.length)) : false,
  );
  const pop = popOpen ? h('div', { class: 'pdock-pop', role: 'dialog', 'aria-label': t('dock.title') }, h('div', { class: 'pdock-title' }, t('dock.title')), ...active.map(jobRow)) : false;
  root.replaceChildren(...(pop ? [pop, button] : [button]));
}

export function setupDock(dockHost: DockHost) {
  host = dockHost;
  document.addEventListener('mousedown', (e) => {
    if (popOpen && !dock().contains(e.target as Node)) ((popOpen = false), renderDock());
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popOpen) ((popOpen = false), renderDock());
  });
  // Na úzkém okně chat překrývá pravý okraj, tlačítko se posune doleva.
  document.addEventListener('chat-open-changed', (e) => dock().classList.toggle('beside-chat', (e as CustomEvent<boolean>).detail));
}
