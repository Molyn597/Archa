import { docTitle } from '../shared/doc-title';
import type { InvoiceStatusFilter } from '../shared/invoices';
import { t } from '../shared/i18n';
import { buildNotes, markSeen, noteTime, unreadCount, type Note, type NoteTarget } from '../shared/notifications';
import type { Job, Settings } from '../shared/types';
import { h } from './dom';
import { overviewKind, overviewSignals } from './overview';
import { openPractice } from './practice-view';

interface NotesHost {
  jobs(): Job[];
  settings(): Settings;
  openJob(id: string): void;
  openProject(id: string): void;
  showUnsorted(): void;
  showAll(): void;
  showInvoices(status: InvoiceStatusFilter): void;
  showDeadlines(): void;
}

const SEEN_KEY = 'notesSeen';
let host: NotesHost;
let bell: HTMLElement;
let dot: HTMLElement;
let pop: HTMLElement;
let timer: number | undefined;

// Viděná id jsou jen pohodlí tohoto zařízení; bez úložiště se tečka prostě nepamatuje.
function loadSeen(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveSeen(ids: string[]) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(ids));
  } catch {
    /* úložiště nedostupné */
  }
}

function collect(): Note[] {
  if (!host.settings().bell) return [];
  const jobs = host.jobs();
  const sig = overviewSignals(jobs);
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const title = (id: string) => {
    const job = byId.get(id);
    return job ? docTitle(job, sig.cards[id]) : '';
  };
  return buildNotes({ today: sig.today, now: Date.now(), jobs, title, wait: sig.wait(overviewKind() === 'study' ? 'study' : 'work'), deadlines: sig.deadlines });
}

function go(target: NoteTarget) {
  pop.hidden = true;
  bell.setAttribute('aria-expanded', 'false');
  switch (target.to) {
    case 'job':
      return host.openJob(target.id);
    case 'project':
      return host.openProject(target.id);
    case 'unsorted':
      return host.showUnsorted();
    case 'all':
      return host.showAll();
    case 'invoices':
      return host.showInvoices(target.status);
    case 'deadlines':
      return host.showDeadlines();
    case 'practice':
      return void openPractice(target.scope);
  }
}

function fill(notes: Note[], fresh: ReadonlySet<string>) {
  if (!notes.length) return pop.replaceChildren(h('p', { class: 'note-empty' }, t('note.empty')));
  pop.replaceChildren(
    ...notes.map((n) =>
      h(
        'button',
        { class: `note-row${fresh.has(n.id) ? ' new' : ''}`, type: 'button', role: 'menuitem', title: n.title, onclick: () => go(n.target) },
        h('span', { class: 'note-title' }, n.title),
        n.at > 0 && h('span', { class: 'note-sub note-time' }, noteTime(n.at, Date.now())),
        n.sub && h('span', { class: 'note-sub' }, n.sub),
      ),
    ),
  );
}

/** Přepočítá seznam a tečku; otevřený seznam se hned označí jako viděný. */
function update() {
  const notes = collect();
  const seen = loadSeen();
  const open = !pop.hidden;
  if (open) {
    fill(notes, new Set(notes.map((n) => n.id).filter((id) => !seen.includes(id))));
    saveSeen(markSeen(seen, notes));
  }
  dot.hidden = open || unreadCount(notes, new Set(seen)) === 0;
}

/** Přepočet se slučuje: průběh úlohy hlásí změnu i několikrát za vteřinu. */
export function updateNotifications() {
  window.clearTimeout(timer);
  timer = window.setTimeout(update, 250);
}

export function setupNotifications(notesHost: NotesHost) {
  host = notesHost;
  bell = document.getElementById('topbar-bell')!;
  dot = document.getElementById('topbar-bell-dot')!;
  pop = document.getElementById('note-pop')!;
  bell.setAttribute('aria-haspopup', 'menu');
  bell.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = pop.hidden;
    for (const m of document.querySelectorAll<HTMLElement>('.menu')) m.hidden = true;
    pop.hidden = !open;
    bell.setAttribute('aria-expanded', String(open));
    update();
  });
  document.addEventListener('click', (e) => {
    if (pop.hidden || pop.contains(e.target as Node)) return;
    pop.hidden = true;
    bell.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || pop.hidden) return;
    pop.hidden = true;
    bell.setAttribute('aria-expanded', 'false');
    bell.focus();
  });
  document.addEventListener('overview-refreshed', updateNotifications);
  document.addEventListener('libraries-changed', updateNotifications);
  update();
}
