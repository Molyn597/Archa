import { t, type MessageKey } from '../shared/i18n';
import { childFolders, fold, folderName, folderPath, isLocked, placementActive, resolvePath, subtree, TRASH_DAYS } from '../shared/folders';
import { duplicateGroups, type DuplicateGroup } from '../shared/duplicates';
import { OTHER_FOLDER } from '../shared/overview';
import { isOnline } from '../shared/provider';
import type { DocumentCard, FolderMerge, Job, LibraryState, OrganizePlan, Placement, Project, ProjectKind } from '../shared/types';
import type { Tab } from './detail';
import { cleanError, date, h, icon, ICONS, jobDuration, jobTitle, langPair, MODES, openModal, progressInfo, statusIcon, STATUS_TEXT, toast, toastAction } from './dom';
import { showProjectChat } from './chat';
import { planView } from './plan-view';
import { flushProject, newProjectModal, pickProjectModal, renderProject, type ProjectCtx } from './project-view';
import { dueSoon, renderDeadlines } from './deadlines-view';
import { invoiceCount, renderInvoices } from './invoices-view';
import { lockFolder, unlockFolder, unlockModal, vault } from './vault';

export interface LibraryHost {
  /** Všechny úlohy od nejnovější. */
  jobs(): Job[];
  open(id: string, tab?: Tab, withChat?: boolean): void;
  modelName(id: string): string;
  showHome(): void;
  /** Strom složek je v levém panelu i mimo Knihovnu (detail dokumentu): výběr přepne na její view. */
  showLibrary(): void;
  /** Výběr nebo seznam složek se změnil (chat s knihovnou nabízí „Jen ve složce“). */
  folderChanged(): void;
  /** Výběr se změnil (vybraný projekt zvýrazňuje v navigaci Projekty, ne Soubory). */
  selectionChanged(): void;
}

/** Výběr v seznamu složek: všechny, nezařazené, nebo id složky. */
const ALL = 'all';
const UNSORTED = 'unsorted';
// Pseudo-složky: koš a přehled toho, co zařadila AI.
const TRASH = 'trash';
const AI_LOG = 'aiLog';
const DUPLICATES = 'duplicates';
const INVOICES = 'invoices';
const DEADLINES = 'deadlines';
// Výběr projektu: PROJECT + id (v hlavní oblasti je pak detail projektu, ne seznam dokumentů).
const PROJECT = 'project:';
const DAY = 86_400_000;
const FOLDER_KEY = 'libraryFolder';
const SUMMARY_PREVIEW = 140;
const COLLAPSED_KEY = 'libraryCollapsed';
const DRAG_TYPE = 'application/x-translatte-job';
const FOLDER_DRAG_TYPE = 'application/x-translatte-folder';
const INDENT = 14;
const OFFER_KEY = 'libraryOfferNo';
// Od kolika dokumentů ve složce bez podsložek se nabízí třídění; po „Ne“ znovu až o OFFER_STEP víc.
const OFFER_MIN = 8;
const OFFER_STEP = 5;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let host: LibraryHost;
let state: LibraryState = { library: { folders: [], assign: {} }, cards: {} };
let selected = ALL;
let openId: string | null = null;
// Právě se vytváří nebo přejmenovává složka: překreslení by rozepsaný název smazalo.
let editing: string | null = null;
let progress: { done: number; total: number } | null = null;
// Sbalené složky (mají skryté podsložky).
let collapsed = new Set<string>();
// Hromadný výběr dokumentů, naposledy kliknutý (kotva pro Shift) a dokumenty právě viditelné v seznamu.
const chosen = new Set<string>();
let anchor: string | null = null;
let visible: string[] = [];
// Dokumenty v koši (počet v levém panelu, seznam ve výběru Koše).
let trash: Job[] = [];
// Projekty (jedna kopie; po každém volání API se nahradí vráceným projektem).
let projects: Project[] = [];
let projectsLoaded = false;
// Právě tažená složka (dataTransfer se při dragover nedá číst).
let dragFolder: string | null = null;

try {
  selected = localStorage.getItem(FOLDER_KEY) ?? ALL;
  collapsed = new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'));
} catch {}

function saveCollapsed() {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {}
}

/** Složka dokumentu; zařazení do smazané složky se bere jako nezařazeno. */
const special = () => selected === TRASH || selected === AI_LOG || selected === DUPLICATES || selected === INVOICES || selected === DEADLINES || inProject();
const inProject = () => selected.startsWith(PROJECT);
const projectId = () => selected.slice(PROJECT.length);

const folderOf = (id: string) => {
  const folder = state.library.assign[id]?.folder;
  return state.library.folders.some((f) => f.id === folder) ? folder : undefined;
};

/** Aktuální složky knihovny. */
export const libraryFolders = () => state.library.folders;

// Nejvýš tolik viditelných dokumentů se v chatu bere jako „toto“; víc už je spíš celá složka.
const FOCUS_VISIBLE = 20;

/** Dokumenty, na které se uživatel dívá („toto“ v chatu): zaškrtnuté, jinak rozbalený řádek, jinak obsah otevřené složky. */
export function focusDocs(): string[] {
  if (special()) return [];
  if (chosen.size) return [...chosen];
  if (openId && visible.includes(openId)) return [openId];
  return selected !== ALL && visible.length <= FOCUS_VISIBLE ? [...visible] : [];
}

/** Vybraná skutečná složka (ne Vše / Nezařazené), jinak null. */
export const selectedFolder = (): { id: string; name: string } | null => {
  const f = state.library.folders.find((x) => x.id === selected);
  return f ? { id: f.id, name: folderName(f) } : null;
};

// Složky, pro které právě běží návrh podsložek.
const suggesting = new Set<string>();

/** Počty dokumentů, při kterých uživatel odmítl nabídku podsložek (id složky → počet). */
function declined(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(OFFER_KEY) ?? '{}');
  } catch {
    return {};
  }
}

const docTitle = (id: string) => {
  const job = host.jobs().find((j) => j.id === id);
  return job ? jobTitle(job) : '';
};

/** Náhled návrhu v modálním okně. */
function showPlan(plan: OrganizePlan) {
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  const overlay: HTMLElement = h(
    'div',
    { class: 'modal-overlay', onmousedown: (e: Event) => e.target === overlay && close() },
    h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'modal-head' }, h('strong', {}, t('organize.title')), h('button', { class: 'btn', type: 'button', title: t('region.close'), 'aria-label': t('region.close'), onclick: close }, icon(ICONS.x))),
      h('div', { class: 'modal-body' }, planView(plan, { title: docTitle, folders: libraryFolders, onDone: close, onCancel: close })),
    ),
  );
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
}

async function suggest(id: string) {
  suggesting.add(id);
  renderLibrary();
  try {
    const plan = await window.api.organizeFolder(id);
    if (plan.folders.length || plan.questions.length) showPlan(plan);
    else toast(t('organize.unchanged'));
  } catch (e) {
    toast(cleanError(e), true);
  } finally {
    suggesting.delete(id);
    renderLibrary();
  }
}

/** Dotazy AI na zařazení a nabídka třídění přeplněné složky, nad seznamem. */
function renderAsk(jobs: Job[]) {
  const box = $('library-ask');
  if (special()) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  const known = new Set(jobs.map((j) => j.id));
  const questions = (state.library.questions ?? []).filter((q) => known.has(q.jobId));
  const blocks = questions.map((q) =>
    h(
      'div',
      { class: 'library-ask-item' },
      h('span', {}, t('library.question', { doc: docTitle(q.jobId) })),
      h(
        'div',
        { class: 'library-ask-actions' },
        ...q.options.map((o) =>
          h('button', { class: 'btn', type: 'button', onclick: () => void window.api.answerFolder(q.jobId, o).catch((e) => toast(cleanError(e), true)) }, o, resolvePath(state.library.folders, o) === undefined && h('span', { class: 'plan-new' }, t('library.questionNew'))),
        ),
        h('button', { class: 'btn', type: 'button', onclick: () => void window.api.answerFolder(q.jobId, null).catch((e) => toast(cleanError(e), true)) }, t('library.questionKeep')),
      ),
    ),
  );
  const folder = state.library.folders.find((f) => f.id === selected);
  if (folder && !childFolders(state.library.folders, folder.id).length) {
    const count = jobs.filter((j) => folderOf(j.id) === folder.id).length;
    const no = declined()[folder.id];
    if (count >= OFFER_MIN && (no === undefined || count >= no + OFFER_STEP)) {
      const busy = suggesting.has(folder.id);
      blocks.push(
        h(
          'div',
          { class: 'library-ask-item' },
          h('span', {}, t('organize.offer', { name: folderName(folder), count })),
          h(
            'div',
            { class: 'library-ask-actions' },
            h('button', { class: 'btn primary', type: 'button', disabled: busy, onclick: () => void suggest(folder.id) }, t(busy ? 'organize.suggesting' : 'organize.suggest')),
            h(
              'button',
              {
                class: 'btn',
                type: 'button',
                disabled: busy,
                onclick: () => {
                  try {
                    localStorage.setItem(OFFER_KEY, JSON.stringify({ ...declined(), [folder.id]: count }));
                  } catch {}
                  renderLibrary();
                },
              },
              t('organize.no'),
            ),
          ),
        ),
      );
    }
  }
  box.hidden = !blocks.length;
  box.replaceChildren(...blocks);
}

function select(value: string) {
  host.showLibrary();
  flushProject();
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

/** Přesune dokumenty (ručně) a seznam se překreslí podle události z hlavního procesu. */
const move = (jobIds: string[], folder: string | null) => window.api.moveToFolder(jobIds, folder).catch((e) => toast(cleanError(e), true));

/** Složky jako plochý strom (odsazení = hloubka), pro výběry. */
function flatFolders(parent?: string, depth = 0): { id: string; name: string; depth: number }[] {
  return childFolders(state.library.folders, parent).flatMap((f) => [{ id: f.id, name: folderName(f), depth }, ...flatFolders(f.id, depth + 1)]);
}

/** Možnosti výběru složky s odsazenými názvy podsložek. */
const folderOptions = (current?: string) =>
  flatFolders().map((f) => h('option', { value: f.id, ...(f.id === current ? { selected: true } : {}) }, `${'\u00a0\u00a0\u00a0'.repeat(f.depth)}${f.name}`));

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

interface FolderOpts {
  depth?: number;
  /** Kam se pouští dokumenty (null = nezařazené); undefined = nelze pustit. */
  docTarget?: string | null;
  /** Kam se pouští složky (null = nejvyšší úroveň); undefined = nelze pustit. */
  folderTarget?: string | null;
  /** Složka je tažitelná. */
  draggable?: boolean;
  /** Počet podsložek, pro šipku sbalení. */
  kids?: number;
  /** Ikona místo složky. */
  iconPath?: string;
  /** Pustit sem dokumenty = přesun do koše. */
  trash?: boolean;
  /** Složka je zamčená (sama nebo zděděně): ikona zámku, při zamčeném trezoru dotaz na heslo. */
  locked?: boolean;
}

function folderItem(id: string, label: string, count: number, opts: FolderOpts = {}) {
  const { depth = 0, docTarget, folderTarget, kids = 0 } = opts;
  const open = !collapsed.has(id);
  const toggle = kids
    ? h(
        'button',
        {
          class: `folder-toggle${open ? ' open' : ''}`,
          type: 'button',
          title: t(open ? 'library.collapse' : 'library.expand'),
          'aria-label': t(open ? 'library.collapse' : 'library.expand'),
          'aria-expanded': String(open),
          onclick: () => {
            if (open) collapsed.add(id);
            else collapsed.delete(id);
            saveCollapsed();
            draw();
          },
        },
        icon(ICONS.chevron),
      )
    : h('span', { class: 'folder-toggle' });
  const choose = () => {
    select(id);
    if (opts.locked && !vault.unlocked) unlockModal();
  };
  const main = h('button', { class: 'folder-main', type: 'button', onclick: choose }, icon(opts.iconPath ?? ICONS.folder), h('span', { class: 'folder-name' }, label), opts.locked && h('span', { class: 'folder-lock', title: t('vault.folderIcon') }, icon(ICONS.lock)), h('span', { class: 'folder-count' }, String(count)));
  const item = h('div', { class: `folder-item${selected === id ? ' active' : ''}` }, toggle, main);
  item.style.paddingLeft = `${depth * INDENT}px`;

  const accepts = (e: DragEvent) => {
    const types = e.dataTransfer?.types ?? [];
    if ((docTarget !== undefined || opts.trash) && types.includes(DRAG_TYPE)) return true;
    // Složku nelze pustit do sebe ani do vlastní podsložky.
    return folderTarget !== undefined && !!dragFolder && types.includes(FOLDER_DRAG_TYPE) && !subtree(state.library.folders, dragFolder).has(folderTarget ?? '');
  };
  item.addEventListener('dragover', (e) => {
    if (!accepts(e)) return;
    e.preventDefault();
    item.classList.add('drop');
  });
  item.addEventListener('dragleave', (e) => {
    if (!item.contains(e.relatedTarget as Node | null)) item.classList.remove('drop');
  });
  item.addEventListener('drop', (e) => {
    item.classList.remove('drop');
    if (!accepts(e)) return;
    e.preventDefault();
    if (dragFolder && e.dataTransfer?.types.includes(FOLDER_DRAG_TYPE)) {
      void window.api.moveFolder(dragFolder, folderTarget ?? null).catch((err) => toast(cleanError(err), true));
      return;
    }
    const raw = e.dataTransfer?.getData(DRAG_TYPE);
    if (!raw || (docTarget === undefined && !opts.trash)) return;
    // Pole id (výběr), kvůli zpětné kompatibilitě i jedno id.
    let ids: unknown;
    try {
      ids = JSON.parse(raw);
    } catch {}
    const list = Array.isArray(ids) ? (ids as string[]) : [raw];
    if (opts.trash) {
      chosen.clear();
      void toTrash(list);
    } else void move(list, docTarget ?? null);
  });
  if (opts.draggable) {
    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
      dragFolder = id;
      e.dataTransfer?.setData(FOLDER_DRAG_TYPE, id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
      dragFolder = null;
      item.classList.remove('dragging');
    });
  }
  return item;
}

// ---------- Slučování složek ----------

/** Sloučení jedné složky do vybrané (cíl nesmí být ona ani její podsložka). */
function mergeInto(from: string, name: string) {
  for (const m of document.querySelectorAll<HTMLElement>('.menu')) m.hidden = true;
  const { folders } = state.library;
  const inside = subtree(folders, from);
  const targets = flatFolders().filter((f) => !inside.has(f.id));
  if (!targets.length) return void toast(t('merge.noTarget'));
  const field = h('select', {}, ...targets.map((f) => h('option', { value: f.id }, `${'\u00a0\u00a0\u00a0'.repeat(f.depth)}${f.name}`)));
  const apply = h('button', { class: 'btn primary', type: 'button' }, t('merge.apply'));
  const close = openModal(
    t('merge.title'),
    [h('p', { class: 'merge-hint' }, t('merge.hint', { name })), h('label', { class: 'field' }, t('merge.target'), field)],
    [h('button', { class: 'btn', type: 'button', onclick: () => close() }, t('merge.cancel')), apply],
  );
  apply.addEventListener('click', () => {
    const into = field.value;
    apply.disabled = true;
    window.api.mergeFolders(from, into).then(
      () => {
        if (selected === from) select(into);
        toast(t('merge.done'));
        close();
      },
      (e) => {
        toast(cleanError(e), true);
        apply.disabled = false;
      },
    );
  });
}

let findingMerges = false;

/** Najde podobné složky (AI, trvá) a nabídne jejich sloučení. */
async function findMerges() {
  findingMerges = true;
  renderLibrary();
  try {
    const merges = await window.api.suggestMerges();
    if (merges.length) showMerges(merges);
    else toast(t('merge.none'));
  } catch (e) {
    toast(cleanError(e), true);
  } finally {
    findingMerges = false;
    renderLibrary();
  }
}

function showMerges(merges: FolderMerge[]) {
  const { folders } = state.library;
  const path = (id: string) => {
    const f = folders.find((x) => x.id === id);
    return f ? folderPath(folders, f) : '';
  };
  const rows = merges.map((m) => {
    const box = h('input', { type: 'checkbox', checked: true });
    return { m, box, row: h('label', { class: 'merge-row' }, box, h('span', {}, h('span', {}, `${path(m.from)} → ${path(m.into)}`), m.reason && h('span', { class: 'merge-reason' }, m.reason))) };
  });
  const apply = h('button', { class: 'btn primary', type: 'button' }, t('merge.applySelected'));
  const close = openModal(t('merge.suggestTitle'), rows.map((r) => r.row), [h('button', { class: 'btn', type: 'button', onclick: () => close() }, t('merge.cancel')), apply]);
  apply.addEventListener('click', async () => {
    apply.disabled = true;
    let count = 0;
    for (const { m, box } of rows) {
      // Složka mohla mezitím zmizet (např. dřívějším sloučením) – návrh přeskočíme.
      if (!box.checked || !path(m.from) || !path(m.into)) continue;
      await window.api.mergeFolders(m.from, m.into).then(
        () => {
          count++;
          if (selected === m.from) select(m.into);
        },
        (e) => toast(cleanError(e), true),
      );
    }
    if (count) toast(t('merge.doneCount', { count }));
    close();
  });
}

// Složka, jejíž dokumenty se právě šifrují nebo dešifrují.
let encrypting: string | null = null;

function folderMenu(id: string, name: string) {
  const { folders } = state.library;
  const folder = folders.find((f) => f.id === id);
  const locked = !!folder && isLocked(folders, folder);
  const busy = (on: boolean) => {
    encrypting = on ? id : null;
    renderLibrary();
  };
  const menu = h(
    'div',
    { class: 'menu', role: 'menu', hidden: true },
    h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        onclick: () => {
          // Rodič se rozbalí, aby bylo políčko vidět.
          collapsed.delete(id);
          saveCollapsed();
          editing = `+${id}`;
          draw();
        },
      },
      t('library.newSubfolder'),
    ),
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
    h('button', { type: 'button', role: 'menuitem', onclick: () => mergeInto(id, name) }, t('merge.menu')),
    // Zamknout jde jen nezamčenou složku; zrušit zámek jen tam, kde je nastavený přímo (zděděný se ruší u předka).
    !locked && h('button', { type: 'button', role: 'menuitem', disabled: !!encrypting, onclick: () => lockFolder(id, busy) }, t(encrypting === id ? 'vault.encrypting' : 'vault.lockMenu')),
    folder?.locked && h('button', { type: 'button', role: 'menuitem', disabled: !!encrypting, onclick: () => unlockFolder(id, name, busy) }, t(encrypting === id ? 'vault.decrypting' : 'vault.unlockMenu')),
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

// ---------- Projekty ----------

/** Nahradí (nebo přidá) kopii projektu a překreslí. */
function putProject(p: Project) {
  projects = projects.some((x) => x.id === p.id) ? projects.map((x) => (x.id === p.id ? p : x)) : [...projects, p];
  renderLibrary();
}

const projectCtx: ProjectCtx = {
  get: (id) => projects.find((p) => p.id === id),
  put: putProject,
  jobs: () => host.jobs(),
  trash: () => trash,
  cards: () => state.cards,
  folderLabel: (id) => {
    const folder = state.library.folders.find((f) => f.id === folderOf(id));
    return folder ? folderPath(state.library.folders, folder) : '';
  },
  open: (id, tab) => host.open(id, tab),
  remove: (id) => {
    if (selected === PROJECT + id) select(ALL);
    projects = projects.filter((p) => p.id !== id);
    renderLibrary();
    void window.api.deleteProject(id).catch((e) => toast(cleanError(e), true));
  },
  reload: () => void reloadLibrary(),
};

/** Dialog nového projektu; po založení se projekt otevře, nebo se do něj přidají dokumenty. */
export function createProject(ids: string[] = []) {
  newProjectModal(async (name, kind: ProjectKind) => {
    try {
      let p = await window.api.createProject(name, kind);
      putProject(p);
      if (!ids.length) return select(PROJECT + p.id);
      p = await window.api.addToProject(p.id, ids);
      putProject(p);
      toast(t('project.added', { name: p.name, count: p.sources.length }));
    } catch (e) {
      toast(cleanError(e), true);
    }
  });
}

/** Otevře projekt v jeho detailu (view Soubory s vybraným projektem). */
export const openProject = (id: string) => select(PROJECT + id);

/** Je vybraný projekt? */
export const projectSelected = () => inProject();

/** Opustí vybraný projekt (Soubory se otevřou na všech dokumentech). */
export function leaveProject() {
  if (inProject()) select(ALL);
}

/** Otevře Soubory na pohledu Termíny. */
export const showDeadlines = () => select(DEADLINES);

/** Otevře Soubory na dokumentech k zařazení: nezařazené, jinak složka Ostatní. */
export function showUnsorted() {
  const { folders } = state.library;
  select(host.jobs().some((j) => !folderOf(j.id)) ? UNSORTED : folders.some((f) => f.id === OTHER_FOLDER) ? OTHER_FOLDER : ALL);
}

/** Přidá dokumenty do projektu a oznámí, kolik jich v něm přibylo. */
async function addToProject(id: string, ids: string[]) {
  const before = projects.find((p) => p.id === id)?.sources.length ?? 0;
  try {
    const p = await window.api.addToProject(id, ids);
    putProject(p);
    const added = p.sources.length - before;
    toast(added ? t('project.added', { name: p.name, count: added }) : t('project.addedNone', { name: p.name }));
  } catch (e) {
    toast(cleanError(e), true);
  }
}

function renderFolders(jobs: Job[]) {
  const { folders } = state.library;
  const counts = new Map<string | undefined, number>();
  for (const j of jobs) counts.set(folderOf(j.id), (counts.get(folderOf(j.id)) ?? 0) + 1);
  const unsorted = counts.get(undefined) ?? 0;
  // Počet u složky = dokumenty v celém podstromu.
  // Dokumenty zamčených složek při zamčeném trezoru nejsou v seznamu úloh, počítají se ze zařazení.
  if (!vault.unlocked) {
    for (const [jobId, a] of Object.entries(state.library.assign)) {
      const f = folders.find((x) => x.id === a.folder);
      if (f && isLocked(folders, f) && !host.jobs().some((j) => j.id === jobId)) counts.set(f.id, (counts.get(f.id) ?? 0) + 1);
    }
  }
  const total = (id: string) => [...subtree(folders, id)].reduce((sum, x) => sum + (counts.get(x) ?? 0), 0);

  const items: HTMLElement[] = [folderItem(ALL, t('library.all'), jobs.length, { folderTarget: null })];
  const branch = (parent: string | undefined, depth: number) => {
    for (const f of childFolders(folders, parent)) {
      const name = folderName(f);
      if (editing === f.id) {
        items.push(h('div', { class: 'folder-item active' }, nameInput(name, (value) => void window.api.renameFolder(f.id, value))));
        continue;
      }
      const kids = childFolders(folders, f.id).length;
      const item = folderItem(f.id, name, total(f.id), { depth, docTarget: f.id, folderTarget: f.id, draggable: true, kids, locked: isLocked(folders, f) });
      item.append(folderMenu(f.id, name));
      items.push(item);
      if (editing === `+${f.id}`) {
        const row = h('div', { class: 'folder-item active' }, nameInput('', (value) => void window.api.createFolder(value, f.id).then((c) => select(c.id))));
        row.style.paddingLeft = `${(depth + 1) * INDENT}px`;
        items.push(row);
      }
      if (!collapsed.has(f.id)) branch(f.id, depth + 1);
    }
  };
  branch(undefined, 0);
  if (unsorted || selected === UNSORTED) items.push(folderItem(UNSORTED, t('library.unsorted'), unsorted, { docTarget: null }));

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
    h('button', { class: 'folder-add folder-find', type: 'button', disabled: findingMerges, onclick: () => void findMerges() }, t(findingMerges ? 'merge.finding' : 'merge.find')),
  );
  // Zvláštní pohledy (ne složky) připnuté dole, oddělené od stromu.
  const deadlineSet = deadlineData(jobs);
  const dups = duplicateGroups(jobs, state.cards, state.library);
  const projectBlock = h(
    'div',
    { class: 'folder-projects' },
    ...projects.map((p) => folderItem(PROJECT + p.id, p.name, p.sources.length, { iconPath: ICONS.book })),
    h('button', { class: 'folder-add', type: 'button', onclick: () => createProject() }, icon(ICONS.plus), t('project.new')),
  );
  const pinned = h(
    'div',
    { class: 'folder-pinned' },
    deadlineSet.all.length ? folderItem(DEADLINES, t('dl.title'), deadlineSet.soon.length, { iconPath: ICONS.clock }) : null,
    invoiceCount(jobs, state.cards) ? folderItem(INVOICES, t('inv.title'), invoiceCount(jobs, state.cards), { iconPath: ICONS.invoice }) : null,
    dups.length ? folderItem(DUPLICATES, t('dup.title'), dups.length, { iconPath: ICONS.copy }) : null,
    folderItem(AI_LOG, t('aiLog.title'), aiActive().length, { iconPath: ICONS.fast }),
    folderItem(TRASH, t('trash.title'), trash.length, { iconPath: ICONS.trash, trash: true }),
  );
  $('library-folders').replaceChildren(h('div', { class: 'folder-tree' }, ...items), pinned);
  $('project-folders').replaceChildren(projectBlock);
}

// ---------- Banner s chybějícími kartami ----------

let making = false;
let index = { model: undefined as string | undefined, missing: 0 };
let indexing: { done: number; total: number } | null = null;

async function loadIndexStatus() {
  try {
    const { model, missing } = await window.api.indexStatus();
    index = { model, missing };
  } catch {
    index = { model: undefined, missing: 0 };
  }
  renderLibrary();
}

function buildIndex() {
  indexing = { done: 0, total: index.missing };
  renderLibrary();
  window.api
    .buildIndexes()
    .catch((e) => toast(t('index.failed', { error: cleanError(e) }), true))
    .finally(() => {
      indexing = null;
      void loadIndexStatus();
    });
}

function renderBanner(jobs: Job[]) {
  const missing = jobs.filter((j) => j.status === 'done' && !state.cards[j.id]).length;
  // Staré karty faktur a smluv bez faktů (ručně upravené se nepřepisují).
  const noFacts = jobs.filter((j) => {
    const c = state.cards[j.id];
    return j.status === 'done' && c && (c.type === 'invoice' || c.type === 'contract') && !c.edited && !c.facts;
  }).length;
  const fillFacts = !missing && noFacts > 0;
  const banner = $('library-banner');
  // Banner indexu až po kartách a faktech a jen v běžné knihovně.
  const showIndex = !missing && !noFacts && !making && !special() && Boolean(index.model) && (index.missing > 0 || indexing !== null);
  banner.hidden = !missing && !noFacts && !making && !showIndex;
  if (banner.hidden) return;
  if (showIndex) {
    const button = h('button', { class: 'btn', type: 'button', disabled: indexing !== null, onclick: buildIndex }, t('index.build'));
    banner.replaceChildren(h('span', {}, indexing ? t('index.building', indexing) : t('index.missing', { count: index.missing })), button);
    return;
  }
  const total = fillFacts ? noFacts : missing;
  const label = making && progress ? t('library.makingCards', progress) : fillFacts ? t('library.missingFacts', { count: noFacts }) : t('library.missing', { count: missing });
  const button = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      disabled: making,
      onclick: () => {
        making = true;
        progress = { done: 0, total };
        renderLibrary();
        (fillFacts ? window.api.fillFacts() : window.api.makeMissingCards())
          .catch((e) => toast(cleanError(e), true))
          .finally(() => {
            making = false;
            progress = null;
            void reloadLibrary();
          });
      },
    },
    t(fillFacts ? 'library.fillFacts' : 'library.makeCards'),
  );
  banner.replaceChildren(h('span', {}, label), button);
}

// ---------- Koš a přehled „Zařadila AI“ ----------

/** Přesune dokumenty do koše bez ptaní; vrátit je jde z upozornění. */
export async function toTrash(ids: string[]) {
  const done: string[] = [];
  for (const id of ids) await window.api.deleteJob(id).then(() => done.push(id), (e) => toast(cleanError(e), true));
  if (done.length) toastAction(t('trash.moved', { count: done.length }), t('trash.undo'), () => void window.api.restoreJobs(done).catch((e) => toast(cleanError(e), true)));
}

async function reloadTrash() {
  try {
    trash = await window.api.trashList();
  } catch (e) {
    toast(cleanError(e), true);
  }
  renderLibrary();
}

const daysLeft = (job: Job) => Math.max(0, Math.ceil(((job.trashedAt ?? 0) + TRASH_DAYS * DAY - Date.now()) / DAY));

/** Záznamy AI k dokumentům, které ještě existují. */
const aiEntries = (): Placement[] => (state.library.aiLog ?? []).filter((p) => host.jobs().some((j) => j.id === p.jobId));

/** Zařazení, která jde ještě vrátit. */
const aiActive = () => aiEntries().filter((p) => placementActive(state.library, p));

function trashRow(job: Job) {
  const check = h('input', { type: 'checkbox', class: 'lib-check', title: t('trash.selectRow'), 'aria-label': t('trash.selectRow') });
  check.checked = chosen.has(job.id);
  check.addEventListener('click', (e) => {
    const on = check.checked;
    const from = e.shiftKey && anchor ? visible.indexOf(anchor) : -1;
    const to = visible.indexOf(job.id);
    const ids = from >= 0 && to >= 0 ? visible.slice(Math.min(from, to), Math.max(from, to) + 1) : [job.id];
    for (const id of ids) on ? chosen.add(id) : chosen.delete(id);
    anchor = job.id;
    renderLibrary();
  });
  const meta = [t('trash.deleted', { date: date(job.trashedAt ?? 0) }), t('trash.expires', { count: daysLeft(job) })];
  return h(
    'div',
    { class: `lib-item trash-row${chosen.has(job.id) ? ' chosen' : ''}` },
    h('div', { class: 'lib-line' }, check, h('div', { class: 'job-row' }, h('span', {}, h('div', { class: 'job-row-name' }, `${job.name}${job.ext}`), h('div', { class: 'job-row-meta' }, meta.join(' · '))))),
  );
}

/** Lišta koše: výběr, obnovení, trvalé smazání, vyprázdnění. */
function renderTrashBar() {
  const bar = $('library-bar');
  bar.hidden = !visible.length;
  if (bar.hidden) return;
  const all = h('input', { type: 'checkbox', class: 'lib-check', title: t('library.selectAll'), 'aria-label': t('library.selectAll') });
  all.checked = visible.every((id) => chosen.has(id));
  all.indeterminate = !all.checked && chosen.size > 0;
  all.addEventListener('change', () => {
    if (all.checked) for (const id of visible) chosen.add(id);
    else chosen.clear();
    renderLibrary();
  });
  const allLabel = h('label', { class: 'lib-bar-all' }, all, h('span', {}, chosen.size ? t('library.selected', { count: chosen.size }) : t('library.selectAll')));
  const act = (run: (ids: string[]) => Promise<void>) => () => {
    const ids = [...chosen];
    chosen.clear();
    void run(ids).catch((e) => toast(cleanError(e), true));
  };
  const restore = h('button', { class: 'btn', type: 'button', onclick: act((ids) => window.api.restoreJobs(ids)) }, t('trash.restore'));
  const purge = h(
    'button',
    {
      class: 'btn danger',
      type: 'button',
      onclick: () => {
        if (confirm(t('trash.confirmPurge', { count: chosen.size }))) act((ids) => window.api.purgeJobs(ids))();
      },
    },
    icon(ICONS.trash),
    t('trash.purge'),
  );
  const empty = h(
    'button',
    {
      class: 'btn danger',
      type: 'button',
      onclick: () => {
        if (!confirm(t('trash.confirmEmpty', { count: trash.length }))) return;
        chosen.clear();
        void window.api.emptyTrash().catch((e) => toast(cleanError(e), true));
      },
    },
    t('trash.emptyAll'),
  );
  restore.disabled = purge.disabled = !chosen.size;
  bar.replaceChildren(allLabel, restore, purge, empty);
}

// Vybraný dokument k ponechání v každé skupině duplicit (klíč = ids skupiny), přežije překreslení.
const keepChoice = new Map<string, string>();

async function dedupe(keep: string, drop: string[]) {
  try {
    await window.api.dedupe(keep, drop);
    toastAction(t('trash.moved', { count: drop.length }), t('trash.undo'), () => void window.api.restoreJobs(drop).catch((e) => toast(cleanError(e), true)));
  } catch (e) {
    toast(cleanError(e), true);
  }
}

function dupGroup(g: DuplicateGroup) {
  const key = g.ids.join('|');
  const keep = g.ids.includes(keepChoice.get(key) ?? '') ? keepChoice.get(key)! : g.ids[0];
  const rows = g.ids.map((id) => {
    const job = host.jobs().find((j) => j.id === id)!;
    const card = state.cards[id];
    const folder = folderOf(id);
    const folderLabel = folder ? folderPath(state.library.folders, state.library.folders.find((f) => f.id === folder)!) : '';
    const meta = [date(job.createdAt), t(STATUS_TEXT[job.status]), folderLabel, card ? t('dup.hasCard') : ''].filter(Boolean);
    const radio = h('input', { type: 'radio', name: `keep-${key}`, class: 'lib-check', title: t('dup.keep'), 'aria-label': t('dup.keep') });
    radio.checked = id === keep;
    radio.addEventListener('change', () => {
      keepChoice.set(key, id);
      renderLibrary();
    });
    return h(
      'div',
      { class: 'lib-line' },
      h('label', { class: 'dup-keep' }, radio, h('span', {}, t('dup.keep'))),
      h('button', { class: 'job-row', type: 'button', onclick: () => host.open(id) }, h('span', {}, h('div', { class: 'job-row-name' }, card?.biblio.title || `${job.name}${job.ext}`), h('div', { class: 'job-row-meta' }, meta.join(' · ')))),
    );
  });
  const drop = g.ids.filter((id) => id !== keep);
  const act = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: () => {
        if (g.kind === 'similar' && !confirm(t('dup.confirmSimilar', { count: drop.length }))) return;
        void dedupe(keep, drop);
      },
    },
    icon(ICONS.trash),
    t('dup.resolve'),
  );
  return h(
    'div',
    { class: 'lib-item dup-group' },
    h('div', { class: 'dup-head' }, h('strong', {}, t(g.kind === 'same' ? 'dup.same' : 'dup.similar')), g.kind === 'similar' && h('span', { class: 'muted small' }, t('dup.similarHint'))),
    ...rows,
    h('div', { class: 'dup-actions' }, act),
  );
}

/** Lišta nad skupinami: hromadně vyřeší všechny shodné soubory (ponechá první z každé skupiny). */
function renderDupBar(groups: DuplicateGroup[]) {
  const bar = $('library-bar');
  const same = groups.filter((g) => g.kind === 'same');
  bar.hidden = !same.length;
  if (bar.hidden) return;
  const all = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: () => {
        const drop = same.flatMap((g) => g.ids.slice(1));
        if (!confirm(t('dup.confirmAll', { count: drop.length }))) return;
        void (async () => {
          for (const g of same) await window.api.dedupe(g.ids[0], g.ids.slice(1)).catch((e) => toast(cleanError(e), true));
          toastAction(t('trash.moved', { count: drop.length }), t('trash.undo'), () => void window.api.restoreJobs(drop).catch((e) => toast(cleanError(e), true)));
        })();
      },
    },
    t('dup.resolveAll', { count: same.length }),
  );
  bar.replaceChildren(all);
}

function aiRow(p: Placement) {
  const job = host.jobs().find((j) => j.id === p.jobId)!;
  const active = placementActive(state.library, p);
  const status = active
    ? h('button', { class: 'btn', type: 'button', onclick: () => void window.api.undoPlacement(p).catch((e) => toast(cleanError(e), true)) }, t('aiLog.undo'))
    : h('span', { class: 'chip' }, t(p.undone ? 'aiLog.undone' : 'aiLog.moved'));
  return h(
    'div',
    { class: `lib-item ai-row${active ? '' : ' dim'}` },
    h(
      'div',
      { class: 'lib-line' },
      h(
        'button',
        { class: 'job-row', type: 'button', onclick: () => host.open(job.id) },
        h('span', {}, h('div', { class: 'job-row-name' }, `${job.name}${job.ext}`), h('div', { class: 'job-row-meta' }, [p.path, date(p.at)].join(' · '))),
        p.created.length ? h('span', { class: 'chip accent' }, t('aiLog.new')) : '',
      ),
      status,
    ),
  );
}

// ---------- Řádky dokumentů ----------

function detailPanel(job: Job, card?: DocumentCard) {
  const current = folderOf(job.id) ?? '';
  const folderSelect = h(
    'select',
    { onchange: (e: Event) => void move([job.id], (e.target as HTMLSelectElement).value || null) },
    h('option', { value: '' }, t('library.noFolder')),
    ...folderOptions(current),
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
  const check = h('input', { type: 'checkbox', class: 'lib-check', title: t('library.selectRow'), 'aria-label': t('library.selectRow') });
  check.checked = chosen.has(job.id);
  // Klik na zaškrtávátko řádek nerozbaluje; Shift vybere rozsah ve viditelném seznamu.
  check.addEventListener('click', (e) => {
    e.stopPropagation();
    const on = check.checked;
    const from = e.shiftKey && anchor ? visible.indexOf(anchor) : -1;
    const to = visible.indexOf(job.id);
    const ids = from >= 0 && to >= 0 ? visible.slice(Math.min(from, to), Math.max(from, to) + 1) : [job.id];
    for (const id of ids) on ? chosen.add(id) : chosen.delete(id);
    anchor = job.id;
    renderLibrary();
  });
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
  const item = h('div', { class: `lib-item${expanded ? ' open' : ''}${chosen.has(job.id) ? ' chosen' : ''}`, draggable: 'true' }, h('div', { class: 'lib-line' }, check, row), expanded ? detailPanel(job, card) : null);
  item.addEventListener('dragstart', (e) => {
    // Dokument ve výběru táhne celý výběr.
    const ids = chosen.has(job.id) ? [...chosen] : [job.id];
    e.dataTransfer?.setData(DRAG_TYPE, JSON.stringify(ids));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    if (ids.length > 1 && e.dataTransfer) {
      const badge = h('div', { class: 'drag-badge' }, String(ids.length));
      document.body.append(badge);
      e.dataTransfer.setDragImage(badge, 0, 0);
      setTimeout(() => badge.remove());
    }
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
  host.folderChanged();
  host.selectionChanged();
  // Chat projektu jen v Knihovně; jinde (detail dokumentu) rozsah panelu nesahá.
  if (document.querySelector<HTMLElement>('.view[data-view="history"]')?.hidden === false) showProjectChat(inProject() ? (projects.find((p) => p.id === projectId()) ?? null) : null);
}

/** Lišta hromadných akcí nad seznamem; viditelná u neprázdného seznamu, akce jen s výběrem. */
function renderBar() {
  const bar = $('library-bar');
  bar.hidden = !visible.length;
  if (bar.hidden) return;
  const all = h('input', { type: 'checkbox', class: 'lib-check', title: t('library.selectAll'), 'aria-label': t('library.selectAll') });
  all.checked = visible.length > 0 && visible.every((id) => chosen.has(id));
  all.indeterminate = !all.checked && chosen.size > 0;
  all.addEventListener('change', () => {
    if (all.checked) for (const id of visible) chosen.add(id);
    else chosen.clear();
    renderLibrary();
  });
  const moveTo = h(
    'select',
    {
      class: 'lib-move',
      'aria-label': t('library.moveTo'),
      onchange: (e: Event) => {
        const value = (e.target as HTMLSelectElement).value;
        const ids = [...chosen];
        chosen.clear();
        void move(ids, value === UNSORTED ? null : value);
      },
    },
    h('option', { value: '', selected: true, disabled: true }, t('library.moveTo')),
    h('option', { value: UNSORTED }, t('library.unsorted')),
    ...folderOptions(),
  );
  const toProject = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: () => {
        const ids = [...chosen];
        pickProjectModal(projects, ids.length, (id) => {
          chosen.clear();
          renderLibrary();
          if (id === null) createProject(ids);
          else void addToProject(id, ids);
        });
      },
    },
    icon(ICONS.book),
    t('project.addTo'),
  );
  const del = h(
    'button',
    {
      class: 'btn danger',
      type: 'button',
      onclick: () => {
        const ids = [...chosen];
        chosen.clear();
        void toTrash(ids);
      },
    },
    icon(ICONS.trash),
    t('library.deleteSelected'),
  );
  const clear = h(
    'button',
    {
      class: 'btn icon-only',
      type: 'button',
      title: t('library.clearSelection'),
      'aria-label': t('library.clearSelection'),
      onclick: () => {
        chosen.clear();
        renderLibrary();
      },
    },
    icon(ICONS.x),
  );
  const allLabel = h('label', { class: 'lib-bar-all' }, all, h('span', {}, chosen.size ? t('library.selected', { count: chosen.size }) : t('library.selectAll')));
  const none = !chosen.size;
  moveTo.disabled = none;
  toProject.disabled = none;
  del.disabled = none;
  clear.hidden = none;
  bar.replaceChildren(allLabel, moveTo, toProject, del, clear);
}

const deadlineCtx = (jobs: Job[]) => ({ jobs, cards: state.cards, paid: state.library.paid, projects });
const deadlineData = (jobs: Job[]) => dueSoon(deadlineCtx(jobs));

/** Seznam Koše nebo přehledu AI místo běžných dokumentů. */
function drawSpecial(query: string) {
  if (inProject()) {
    visible = [];
    chosen.clear();
    $('library-bar').hidden = true;
    $('history-empty').hidden = true;
    $('history-empty-action').hidden = true;
    renderProject($('history-list'), projectId(), projectCtx);
    return;
  }
  if (selected === INVOICES) {
    visible = [];
    chosen.clear();
    $('library-bar').hidden = true;
    $('history-empty').hidden = true;
    $('history-empty-action').hidden = true;
    renderInvoices($('history-list'), { jobs: host.jobs(), cards: state.cards, paid: state.library.paid, query: $<HTMLInputElement>('history-search').value, open: (id) => host.open(id), redraw: renderLibrary });
    return;
  }
  if (selected === DEADLINES) {
    visible = [];
    chosen.clear();
    $('library-bar').hidden = true;
    $('history-empty').hidden = true;
    $('history-empty-action').hidden = true;
    renderDeadlines($('history-list'), { ...deadlineCtx(host.jobs()), open: (id) => host.open(id), openProject: (id) => openProject(id) });
    return;
  }
  if (selected === DUPLICATES) {
    const groups = duplicateGroups(host.jobs(), state.cards, state.library);
    visible = [];
    chosen.clear();
    renderDupBar(groups);
    $('history-list').replaceChildren(...groups.map(dupGroup));
    $('history-empty').hidden = true;
    $('history-empty-action').hidden = true;
    return;
  }
  const inTrash = selected === TRASH;
  const jobs = trash.filter((j) => !query || fold(j.name).includes(query));
  const log = aiEntries();
  visible = inTrash ? jobs.map((j) => j.id) : [];
  for (const id of chosen) if (!visible.includes(id)) chosen.delete(id);
  if (inTrash) renderTrashBar();
  else $('library-bar').hidden = true;
  $('history-list').replaceChildren(...(inTrash ? jobs.map(trashRow) : log.map(aiRow)));
  const count = inTrash ? jobs.length : log.length;
  $('history-empty').hidden = count > 0;
  $('history-empty-text').textContent = t(inTrash ? 'trash.empty' : 'aiLog.empty');
  $('history-empty-action').hidden = true;
}

/** Místo dokumentů zamčené složky výzva k odemknutí. */
function drawLocked() {
  visible = [];
  chosen.clear();
  $('library-bar').hidden = true;
  $('history-empty').hidden = true;
  $('history-list').replaceChildren(
    h(
      'div',
      { class: 'vault-locked' },
      icon(ICONS.lock),
      h('strong', {}, t('vault.folderLocked')),
      h('p', {}, t('vault.folderLockedHint')),
      h('button', { class: 'btn primary', type: 'button', onclick: () => unlockModal() }, t('vault.unlock')),
    ),
  );
}

function draw() {
  const jobs = host.jobs();
  const { folders } = state.library;
  if (selected !== ALL && selected !== UNSORTED && !special() && !folders.some((f) => f.id === selected)) selected = ALL;
  if (selected === UNSORTED && !jobs.some((j) => !folderOf(j.id))) selected = ALL;
  if (inProject() && projectsLoaded && !projects.some((p) => p.id === projectId())) selected = ALL;
  if (selected === INVOICES && !invoiceCount(jobs, state.cards)) selected = ALL;
  if (selected === DEADLINES && projectsLoaded && !deadlineData(jobs).all.length) selected = ALL;
  if (selected === DUPLICATES && !duplicateGroups(jobs, state.cards, state.library).length) selected = ALL;

  renderFolders(jobs);
  renderBanner(jobs);
  renderAsk(jobs);
  $('vault-lock').hidden = !vault.unlocked || !folders.some((f) => f.locked);

  const current = folders.find((f) => f.id === selected);
  if (current && isLocked(folders, current) && !vault.unlocked) return drawLocked();

  const query = fold($<HTMLInputElement>('history-search').value);
  if (special()) {
    drawSpecial(query);
    return;
  }
  // Vybraná složka ukazuje dokumenty celého podstromu.
  const inFolders = selected === ALL || selected === UNSORTED ? null : subtree(folders, selected);
  const list = jobs
    .filter((j) => (inFolders ? inFolders.has(folderOf(j.id) ?? '') : selected === ALL || !folderOf(j.id)))
    .filter((j) => !query || searchText(j, state.cards[j.id]).includes(query));
  visible = list.map((j) => j.id);
  // Výběr nesmí obsahovat dokumenty, které nejsou vidět (jiná složka, hledání, smazané).
  for (const id of chosen) if (!visible.includes(id)) chosen.delete(id);
  renderBar();
  $('history-list').replaceChildren(...list.map(docRow));
  $('history-empty').hidden = list.length > 0;
  // Prázdná knihovna nabízí první překlad, prázdná složka nebo hledání jen vysvětlení.
  $('history-empty-text').textContent = t(!jobs.length ? 'history.empty' : query ? 'library.noResults' : 'library.emptyFolder');
  $('history-empty-action').hidden = jobs.length > 0;
}

/** Znovu načte složky a karty z disku a překreslí. */
export async function reloadLibrary() {
  try {
    [state, projects] = await Promise.all([window.api.libraryState(), window.api.listProjects()]);
    projectsLoaded = true;
  } catch (e) {
    toast(cleanError(e), true);
  }
  renderLibrary();
  void loadIndexStatus();
}

export function setupLibrary(libraryHost: LibraryHost) {
  host = libraryHost;
  $('history-list').before(h('div', { class: 'library-ask', id: 'library-ask', hidden: true }), h('div', { class: 'lib-bar', id: 'library-bar', hidden: true }));
  $('history-search').addEventListener('input', renderLibrary);
  $('history-search').before(h('button', { class: 'btn vault-lock', id: 'vault-lock', type: 'button', hidden: true, onclick: () => void window.api.vaultLock().catch((e) => toast(cleanError(e), true)) }, icon(ICONS.lock), t('vault.lockNow')));
  document.addEventListener('keydown', (e) => {
    const field = (e.target as HTMLElement).closest('input[type=text], textarea, select');
    // Escape zruší výběr jen v zobrazené knihovně a mimo psaní do políčka.
    if (e.key !== 'Escape' || !chosen.size || field || !$('history-list').offsetParent) return;
    chosen.clear();
    renderLibrary();
  });
  $('history-empty-action').addEventListener('click', () => host.showHome());
  document.addEventListener('click', () => {
    for (const m of document.querySelectorAll<HTMLElement>('.menu')) m.hidden = true;
  });
  window.api.onLibraryPlaced((p) => {
    const doc = docTitle(p.jobId);
    toastAction(t(p.created.length ? 'library.placedNew' : 'library.placed', { doc, path: p.path }), t('library.placedUndo'), () => void window.api.undoPlacement(p).catch((e) => toast(cleanError(e), true)));
  });
  window.addEventListener('pagehide', flushProject);
  window.api.onLibraryChanged(() => void reloadLibrary());
  window.api.onTrashChanged(() => void reloadTrash());
  window.api.onIndexProgress((p) => {
    indexing = p;
    renderLibrary();
  });
  window.api.onLibraryProgress((p) => {
    progress = p;
    renderLibrary();
  });
  // Stav je potřeba i mimo knihovnu (rychlé zobrazení při prvním otevření).
  void reloadLibrary();
  void reloadTrash();
}
