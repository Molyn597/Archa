import { t, type MessageKey } from '../shared/i18n';
import { fold, folderName } from '../shared/folders';
import { isOnline } from '../shared/provider';
import type { DocumentCard, Job, LibraryState } from '../shared/types';
import type { Tab } from './detail';
import { cleanError, date, h, icon, ICONS, jobDuration, langPair, MODES, progressInfo, statusIcon, STATUS_TEXT, toast } from './dom';

export interface LibraryHost {
  /** Všechny úlohy od nejnovější. */
  jobs(): Job[];
  open(id: string, tab?: Tab, withChat?: boolean): void;
  modelName(id: string): string;
  showHome(): void;
}

/** Výběr v seznamu složek: všechny, nezařazené, nebo id složky. */
const ALL = 'all';
const UNSORTED = 'unsorted';
const FOLDER_KEY = 'libraryFolder';
const SUMMARY_PREVIEW = 140;
const DRAG_TYPE = 'application/x-translatte-job';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let host: LibraryHost;
let state: LibraryState = { library: { folders: [], assign: {} }, cards: {} };
let selected = ALL;
let openId: string | null = null;
// Právě se vytváří nebo přejmenovává složka: překreslení by rozepsaný název smazalo.
let editing: string | null = null;
let progress: { done: number; total: number } | null = null;

try {
  selected = localStorage.getItem(FOLDER_KEY) ?? ALL;
} catch {}

/** Složka dokumentu; zařazení do smazané složky se bere jako nezařazeno. */
const folderOf = (id: string) => {
  const folder = state.library.assign[id]?.folder;
  return state.library.folders.some((f) => f.id === folder) ? folder : undefined;
};

function select(value: string) {
  selected = value;
  openId = null;
  try {
    localStorage.setItem(FOLDER_KEY, value);
  } catch {}
  renderLibrary();
}

function searchText(job: Job, card?: DocumentCard) {
  const biblio = card?.biblio;
  return fold([job.name, card?.summary, card?.keywords.join(' '), biblio?.title, biblio?.authors.map((a) => a.family).join(' ')].filter(Boolean).join(' '));
}

/** Přesune dokument (ručně) a seznam se překreslí podle události z hlavního procesu. */
const move = (jobId: string, folder: string | null) => window.api.moveToFolder([jobId], folder).catch((e) => toast(cleanError(e), true));

/** Políčko pro název složky: Enter uloží, Escape nebo ztráta fokusu zruší (prázdný název nic nezmění). */
function nameInput(initial: string, done: (name: string) => void) {
  let finished = false;
  const finish = (save: boolean, value: string) => {
    if (finished) return;
    finished = true;
    editing = null;
    if (save && value.trim() && value.trim() !== initial) done(value.trim());
    else renderLibrary();
  };
  const input = h('input', { class: 'folder-input', type: 'text', value: initial, placeholder: t('library.folderPlaceholder'), maxlength: '60' });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true, input.value);
    if (e.key === 'Escape') finish(false, '');
  });
  input.addEventListener('blur', () => finish(true, input.value));
  queueMicrotask(() => {
    input.focus();
    input.select();
  });
  return input;
}

// ---------- Složky ----------

function folderItem(id: string, label: string, count: number, drop?: string | null) {
  const main = h('button', { class: 'folder-main', type: 'button', onclick: () => select(id) }, icon(ICONS.folder), h('span', { class: 'folder-name' }, label), h('span', { class: 'folder-count' }, String(count)));
  const item = h('div', { class: `folder-item${selected === id ? ' active' : ''}` }, main);
  // Cíl přetažení: „Vše“ ho nemá.
  if (drop !== undefined) {
    item.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      item.classList.add('drop');
    });
    item.addEventListener('dragleave', (e) => {
      if (!item.contains(e.relatedTarget as Node | null)) item.classList.remove('drop');
    });
    item.addEventListener('drop', (e) => {
      item.classList.remove('drop');
      const jobId = e.dataTransfer?.getData(DRAG_TYPE);
      if (!jobId) return;
      e.preventDefault();
      void move(jobId, drop);
    });
  }
  return item;
}

function folderMenu(id: string, name: string) {
  const menu = h(
    'div',
    { class: 'menu', role: 'menu', hidden: true },
    h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        onclick: () => {
          editing = id;
          draw();
        },
      },
      t('library.rename'),
    ),
    h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        class: 'danger',
        onclick: () => {
          if (!confirm(t('library.confirmDelete', { name }))) return;
          if (selected === id) select(ALL);
          void window.api.deleteFolder(id).catch((e) => toast(cleanError(e), true));
        },
      },
      icon(ICONS.trash),
      t('library.delete'),
    ),
  );
  const button = h(
    'button',
    {
      class: 'folder-more',
      type: 'button',
      title: t('library.folderMenu'),
      'aria-label': t('library.folderMenu'),
      'aria-haspopup': 'menu',
      onclick: (e: Event) => {
        e.stopPropagation();
        const wasHidden = menu.hidden;
        for (const m of document.querySelectorAll<HTMLElement>('.menu')) m.hidden = true;
        menu.hidden = !wasHidden;
      },
    },
    icon(ICONS.more),
  );
  return h('div', { class: 'menu-wrap' }, button, menu);
}

function renderFolders(jobs: Job[]) {
  const { folders } = state.library;
  const counts = new Map<string | undefined, number>();
  for (const j of jobs) counts.set(folderOf(j.id), (counts.get(folderOf(j.id)) ?? 0) + 1);
  const unsorted = counts.get(undefined) ?? 0;

  const items: HTMLElement[] = [folderItem(ALL, t('library.all'), jobs.length)];
  for (const f of folders) {
    const name = folderName(f);
    if (editing === f.id) {
      items.push(h('div', { class: 'folder-item active' }, nameInput(name, (value) => void window.api.renameFolder(f.id, value))));
      continue;
    }
    const item = folderItem(f.id, name, counts.get(f.id) ?? 0, f.id);
    item.append(folderMenu(f.id, name));
    items.push(item);
  }
  if (unsorted || selected === UNSORTED) items.push(folderItem(UNSORTED, t('library.unsorted'), unsorted, null));

  items.push(
    editing === '+'
      ? h('div', { class: 'folder-item active' }, nameInput('', (value) => void window.api.createFolder(value).then((f) => select(f.id))))
      : h(
          'button',
          {
            class: 'folder-add',
            type: 'button',
            onclick: () => {
              editing = '+';
              draw();
            },
          },
          icon(ICONS.plus),
          t('library.newFolder'),
        ),
  );
  $('library-folders').replaceChildren(...items);
}

// ---------- Banner s chybějícími kartami ----------

let making = false;

function renderBanner(jobs: Job[]) {
  const missing = jobs.filter((j) => j.status === 'done' && !state.cards[j.id]).length;
  const banner = $('library-banner');
  banner.hidden = !missing && !making;
  if (banner.hidden) return;
  const label = making && progress ? t('library.makingCards', progress) : t('library.missing', { count: missing });
  const button = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      disabled: making,
      onclick: () => {
        making = true;
        progress = { done: 0, total: missing };
        renderLibrary();
        window.api
          .makeMissingCards()
          .catch((e) => toast(cleanError(e), true))
          .finally(() => {
            making = false;
            progress = null;
            void reloadLibrary();
          });
      },
    },
    t('library.makeCards'),
  );
  banner.replaceChildren(h('span', {}, label), button);
}

// ---------- Řádky dokumentů ----------

function detailPanel(job: Job, card?: DocumentCard) {
  const { folders } = state.library;
  const current = folderOf(job.id) ?? '';
  const folderSelect = h(
    'select',
    { onchange: (e: Event) => void move(job.id, (e.target as HTMLSelectElement).value || null) },
    h('option', { value: '' }, t('library.noFolder')),
    ...folders.map((f) => h('option', { value: f.id, ...(f.id === current ? { selected: true } : {}) }, folderName(f))),
  );
  const open = (tab?: Tab, withChat = false) => host.open(job.id, tab, withChat);
  const buttons = h(
    'div',
    { class: 'row gap lib-actions' },
    h('button', { class: 'btn', type: 'button', onclick: () => open(job.output ? 'translation' : 'compare') }, t('library.openTranslation')),
    h('button', { class: 'btn', type: 'button', onclick: () => open('original') }, t('library.original')),
    h('button', { class: 'btn', type: 'button', onclick: () => open(undefined, true) }, t('library.chat')),
  );
  if (job.status === 'done' && !card) {
    const create = h(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: async () => {
          create.disabled = true;
          create.textContent = t('card.creating');
          try {
            await window.api.makeCard(job.id);
          } catch (e) {
            toast(cleanError(e), true);
            create.disabled = false;
            create.textContent = t('card.create');
          }
        },
      },
      t('card.create'),
    );
    buttons.append(create);
  }
  return h(
    'div',
    { class: 'lib-detail' },
    card ? h('p', { class: 'lib-summary' }, card.summary) : null,
    card?.keywords.length ? h('div', { class: 'chips' }, ...card.keywords.map((k) => h('span', { class: 'chip' }, k))) : null,
    h('label', { class: 'lib-folder' }, h('span', { class: 'muted small' }, t('library.folder')), folderSelect),
    buttons,
  );
}

function docRow(job: Job) {
  const card = state.cards[job.id];
  const parts = [t(STATUS_TEXT[job.status]), date(job.createdAt), t(MODES[job.mode].title), langPair(job), jobDuration(job)];
  if (job.status === 'running' || job.status === 'queued') parts.splice(1, 0, progressInfo(job).label);
  const expanded = openId === job.id;
  const row = h(
    'button',
    { class: 'job-row', type: 'button', 'aria-expanded': String(expanded), onclick: () => ((openId = expanded ? null : job.id), renderLibrary()) },
    statusIcon(job),
    h(
      'span',
      {},
      h('div', { class: 'job-row-name' }, `${job.name}${job.ext}`),
      h('div', { class: 'job-row-meta' }, parts.filter(Boolean).join(' · ')),
      card ? h('div', { class: 'job-row-summary' }, card.summary.length > SUMMARY_PREVIEW ? `${card.summary.slice(0, SUMMARY_PREVIEW).trimEnd()}…` : card.summary) : null,
    ),
    card ? h('span', { class: 'chip accent' }, t(`docType.${card.type}` as MessageKey)) : '',
    isOnline(job) ? h('span', { class: 'chip' }, job.models ? `${t('job.online')} · ${host.modelName(job.models.translate)}` : t('job.online')) : '',
    job.warnings ? h('span', { class: 'chip warn' }, t('job.warnings', { count: job.warnings })) : job.status === 'error' ? h('span', { class: 'chip err' }, t('status.error')) : '',
  );
  const item = h('div', { class: `lib-item${expanded ? ' open' : ''}`, draggable: 'true' }, row, expanded ? detailPanel(job, card) : null);
  item.addEventListener('dragstart', (e) => {
    e.dataTransfer?.setData(DRAG_TYPE, job.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    item.classList.add('dragging');
  });
  item.addEventListener('dragend', () => item.classList.remove('dragging'));
  return item;
}

// ---------- Vykreslení ----------

/** Překreslí knihovnu z posledního načteného stavu (karty a složky), úlohy se berou čerstvé. */
export function renderLibrary() {
  // Rozepsaný název složky se překreslením (např. při průběhu úlohy) nesmí ztratit.
  if (!editing) draw();
}

function draw() {
  const jobs = host.jobs();
  const { folders } = state.library;
  if (selected !== ALL && selected !== UNSORTED && !folders.some((f) => f.id === selected)) selected = ALL;
  if (selected === UNSORTED && !jobs.some((j) => !folderOf(j.id))) selected = ALL;

  renderFolders(jobs);
  renderBanner(jobs);

  const query = fold($<HTMLInputElement>('history-search').value);
  const list = jobs
    .filter((j) => selected === ALL || (selected === UNSORTED ? !folderOf(j.id) : folderOf(j.id) === selected))
    .filter((j) => !query || searchText(j, state.cards[j.id]).includes(query));
  $('history-list').replaceChildren(...list.map(docRow));
  $('history-empty').hidden = list.length > 0;
  // Prázdná knihovna nabízí první překlad, prázdná složka nebo hledání jen vysvětlení.
  $('history-empty-text').textContent = t(!jobs.length ? 'history.empty' : query ? 'library.noResults' : 'library.emptyFolder');
  $('history-empty-action').hidden = jobs.length > 0;
}

/** Znovu načte složky a karty z disku a překreslí. */
export async function reloadLibrary() {
  try {
    state = await window.api.libraryState();
  } catch (e) {
    toast(cleanError(e), true);
  }
  renderLibrary();
}

export function setupLibrary(libraryHost: LibraryHost) {
  host = libraryHost;
  $('history-search').addEventListener('input', renderLibrary);
  $('history-empty-action').addEventListener('click', () => host.showHome());
  document.addEventListener('click', () => {
    for (const m of document.querySelectorAll<HTMLElement>('.menu')) m.hidden = true;
  });
  window.api.onLibraryChanged(() => void reloadLibrary());
  window.api.onLibraryProgress((p) => {
    progress = p;
    renderLibrary();
  });
  // Stav je potřeba i mimo knihovnu (rychlé zobrazení při prvním otevření).
  void reloadLibrary();
}
