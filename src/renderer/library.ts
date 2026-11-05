import { t, type MessageKey } from '../shared/i18n';
import { childFolders, fold, folderName, folderPath, placementActive, resolvePath, subtree, TRASH_DAYS } from '../shared/folders';
import { isOnline } from '../shared/provider';
import type { DocumentCard, FolderMerge, Job, LibraryState, OrganizePlan, Placement } from '../shared/types';
import type { Tab } from './detail';
import { cleanError, date, h, icon, ICONS, jobDuration, jobTitle, langPair, MODES, progressInfo, statusIcon, STATUS_TEXT, toast, toastAction } from './dom';
import { planView } from './plan-view';

export interface LibraryHost {
  /** Všechny úlohy od nejnovější. */
  jobs(): Job[];
  open(id: string, tab?: Tab, withChat?: boolean): void;
  modelName(id: string): string;
  showHome(): void;
  /** Výběr nebo seznam složek se změnil (chat s knihovnou nabízí „Jen ve složce“). */
  folderChanged(): void;
}

/** Výběr v seznamu složek: všechny, nezařazené, nebo id složky. */
const ALL = 'all';
const UNSORTED = 'unsorted';
// Pseudo-složky: koš a přehled toho, co zařadila AI.
const TRASH = 'trash';
const AI_LOG = 'aiLog';
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
const special = () => selected === TRASH || selected === AI_LOG;

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
  const main = h('button', { class: 'folder-main', type: 'button', onclick: () => select(id) }, icon(opts.iconPath ?? ICONS.folder), h('span', { class: 'folder-name' }, label), h('span', { class: 'folder-count' }, String(count)));
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

/** Obecné malé modální okno; vrací funkci pro zavření. */
function openModal(title: string, body: HTMLElement[], foot: HTMLElement[]) {
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
      { class: 'modal merge-modal', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'modal-head' }, h('strong', {}, title), h('button', { class: 'btn', type: 'button', title: t('region.close'), 'aria-label': t('region.close'), onclick: close }, icon(ICONS.x))),
      h('div', { class: 'modal-body' }, ...body),
      h('div', { class: 'modal-foot merge-foot' }, ...foot),
    ),
  );
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  return close;
}

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
  // Počet u složky = dokumenty v celém podstromu.
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
      const item = folderItem(f.id, name, total(f.id), { depth, docTarget: f.id, folderTarget: f.id, draggable: true, kids });
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
  const pinned = h(
    'div',
    { class: 'folder-pinned' },
    folderItem(AI_LOG, t('aiLog.title'), aiActive().length, { iconPath: ICONS.fast }),
    folderItem(TRASH, t('trash.title'), trash.length, { iconPath: ICONS.trash, trash: true }),
  );
  $('library-folders').replaceChildren(h('div', { class: 'folder-tree' }, ...items), pinned);
}

// ---------- Banner s chybějícími kartami ----------

let making = false;

function renderBanner(jobs: Job[]) {
  const missing = jobs.filter((j) => j.status === 'done' && !state.cards[j.id]).length;
  // Staré karty faktur a smluv bez faktů (ručně upravené se nepřepisují).
  const noFacts = jobs.filter((j) => {
    const c = state.cards[j.id];
    return j.status === 'done' && c && (c.type === 'invoice' || c.type === 'contract') && !c.edited && !c.facts;
  }).length;
  const fillFacts = !missing && noFacts > 0;
  const banner = $('library-banner');
  banner.hidden = !missing && !noFacts && !making;
  if (banner.hidden) return;
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
      class: 'btn',
      type: 'button',
      onclick: () => {
        chosen.clear();
        renderLibrary();
      },
    },
    t('library.clearSelection'),
  );
  const allLabel = h('label', { class: 'lib-bar-all' }, all, h('span', {}, chosen.size ? t('library.selected', { count: chosen.size }) : t('library.selectAll')));
  const none = !chosen.size;
  moveTo.disabled = none;
  del.disabled = none;
  clear.hidden = none;
  bar.replaceChildren(allLabel, moveTo, del, clear);
}

/** Seznam Koše nebo přehledu AI místo běžných dokumentů. */
function drawSpecial(query: string) {
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

function draw() {
  const jobs = host.jobs();
  const { folders } = state.library;
  if (selected !== ALL && selected !== UNSORTED && !special() && !folders.some((f) => f.id === selected)) selected = ALL;
  if (selected === UNSORTED && !jobs.some((j) => !folderOf(j.id))) selected = ALL;

  renderFolders(jobs);
  renderBanner(jobs);
  renderAsk(jobs);

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
    state = await window.api.libraryState();
  } catch (e) {
    toast(cleanError(e), true);
  }
  renderLibrary();
}

export function setupLibrary(libraryHost: LibraryHost) {
  host = libraryHost;
  $('history-list').before(h('div', { class: 'library-ask', id: 'library-ask', hidden: true }), h('div', { class: 'lib-bar', id: 'library-bar', hidden: true }));
  $('history-search').addEventListener('input', renderLibrary);
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
  window.api.onLibraryChanged(() => void reloadLibrary());
  window.api.onTrashChanged(() => void reloadTrash());
  window.api.onLibraryProgress((p) => {
    progress = p;
    renderLibrary();
  });
  // Stav je potřeba i mimo knihovnu (rychlé zobrazení při prvním otevření).
  void reloadLibrary();
  void reloadTrash();
}
