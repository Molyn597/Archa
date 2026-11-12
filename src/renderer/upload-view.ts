import { docSubtitle, docTitle } from '../shared/doc-title';
import { childFolders, folderName, isLocked } from '../shared/folders';
import { t, type MessageKey } from '../shared/i18n';
import { languageName, LANGUAGES } from '../shared/languages';
import { isOnline } from '../shared/provider';
import { bulkSavable, suggestion, type Suggestion } from '../shared/upload';
import type { DocumentCard, DuplicateMatch, Job, LibraryState, Mode, Settings } from '../shared/types';
import { openChat } from './chat';
import { cleanError, date, h, icon, ICONS, MODES, openModal, progressBar, progressInfo, STATUS_TEXT, toast, toastAction } from './dom';

interface UploadHost {
  jobs(): Job[];
  settings(): Settings;
  /** Otevře stránku Nahrát (soubory pustené kdekoli v okně). */
  show(): void;
  openJob(id: string): Promise<void>;
  showAll(): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
// Od tolika souborů je výchozí seznam místo karet.
const LIST_FROM = 4;
const RECENT = 6;
const QUALITY: Record<Mode, MessageKey> = { fast: 'quality.fast', balanced: 'quality.balanced', quality: 'quality.quality' };

interface DupWait {
  path: string;
  name: string;
  match: DuplicateMatch;
}

let host: UploadHost;
let lib: LibraryState = { library: { folders: [], assign: {} }, cards: {} };
// Soubory nahrané v této relaci, nejnovější první; po restartu seznam začíná prázdný.
let tray: string[] = [];
let waiting: DupWait[] = [];
let layout: 'cards' | 'list' | undefined;
let menuOpen: string | null = null;
// Řádky „Hotovo“ pod kartou (Word uložen, překlad zařazen) a běžící nástroje.
const did = new Map<string, string[]>();
const busy = new Set<string>();

const isActive = (j: Job) => j.status === 'running' || j.status === 'queued';
const note = (id: string, text: string) => did.set(id, [...(did.get(id) ?? []), text]);

const traySize = () => waiting.length + trayJobs().length;
const trayJobs = () => {
  const byId = new Map(host.jobs().map((j) => [j.id, j]));
  return tray.map((id) => byId.get(id)).filter((j): j is Job => Boolean(j));
};
const currentLayout = () => layout ?? (traySize() >= LIST_FROM ? 'list' : 'cards');

/** Přidá soubory: duplicity počkají na rozhodnutí, ostatní se zařadí do zpracování bez překladu. */
export async function addUploads(paths: string[]) {
  const fresh = [...new Set(paths)];
  if (!fresh.length) return;
  host.show();
  try {
    const dups = await window.api.checkDuplicates(fresh);
    const clean: string[] = [];
    fresh.forEach((path, i) => {
      const match = dups[i]?.[0];
      if (match) waiting.push({ path, name: path.split(/[\\/]/).pop()!, match });
      else clean.push(path);
    });
    await enqueue(clean);
  } catch (e) {
    toast(cleanError(e), true);
  }
  render();
}

/** Zpracování bez překladu: soubor se přečte, popíše a zařadí; překlad je nástroj na kartě. */
async function enqueue(paths: string[]) {
  if (!paths.length) return;
  const s = host.settings();
  const known = new Set(host.jobs().map((j) => j.id));
  try {
    const ids = await window.api.addJobs(paths, { mode: 'fast', sourceLang: 'auto', targetLang: s.targetLang, keepFigures: s.keepFigures, provider: s.provider, translate: false });
    tray = [...ids.reverse(), ...tray];
  } catch (e) {
    // Část souborů mohla projít, jen jiná selhala: nové úlohy se do seznamu přidají i tak.
    const added = (await window.api.listJobs().catch(() => [])).filter((j) => !known.has(j.id)).map((j) => j.id);
    tray = [...added, ...tray];
    toast(cleanError(e), true);
  }
}

// ---------- Akce karty ----------

async function reloadState() {
  try {
    lib = await window.api.libraryState();
  } catch (e) {
    toast(cleanError(e), true);
  }
  render();
}

/** Potvrdí návrh jako ruční zařazení (existující složka se jen přiřadí, nová cesta se založí). */
const saveTo = async (id: string, s: Suggestion) => {
  try {
    if (s.folder) await window.api.moveToFolder([id], s.folder);
    else await window.api.answerFolder(id, s.path);
  } catch (e) {
    toast(cleanError(e), true);
  }
  await reloadState();
};

function saveAll() {
  const todo = trayJobs().flatMap((j) => {
    const s = suggestion(lib.library, j.id, lib.cards[j.id]);
    return j.status === 'done' && bulkSavable(s) ? [{ id: j.id, s }] : [];
  });
  void Promise.all(todo.map(({ id, s }) => saveTo(id, s)));
}

/** Výběr složky ze stromu knihovny (zamčené se nenabízejí). */
export function chooseFolder(done: (folder: string) => void, folders = lib.library.folders) {
  const list = h('div', { class: 'up-folders' });
  const add = (parent?: string, depth = 0) => {
    for (const f of childFolders(folders, parent)) {
      if (isLocked(folders, f)) continue;
      list.append(
        h(
          'button',
          {
            class: 'up-folder',
            type: 'button',
            style: `padding-left:${10 + depth * 18}px`,
            onclick: () => {
              close();
              done(f.id);
            },
          },
          icon(ICONS.folder),
          folderName(f),
        ),
      );
      add(f.id, depth + 1);
    }
  };
  add();
  const close = openModal(t('upload.chooseFolder'), [list], [h('button', { class: 'btn', type: 'button', onclick: () => close() }, t('region.close'))]);
}

const elsewhere = (id: string) =>
  chooseFolder((folder) => {
    void window.api.moveToFolder([id], folder).then(reloadState, (e) => toast(cleanError(e), true));
  });

/** Do koše (jde obnovit); karta zmizí a po Vrátit se vrátí. */
async function discard(id: string) {
  try {
    await window.api.deleteJob(id);
  } catch (e) {
    return toast(cleanError(e), true);
  }
  toastAction(t('trash.moved', { count: 1 }), t('trash.undo'), () => void window.api.restoreJobs([id]).catch((e) => toast(cleanError(e), true)));
}

function translateDialog(job: Job) {
  const s = host.settings();
  const target = h('select', { 'aria-label': t('home.to') }) as HTMLSelectElement;
  for (const l of LANGUAGES) if (l.code !== job.sourceLang) target.append(h('option', { value: l.code }, languageName(l.code)));
  target.value = s.targetLang === job.sourceLang ? (LANGUAGES.find((l) => l.code !== job.sourceLang)?.code ?? '') : s.targetLang;
  let mode: Mode = isOnline(s) ? 'quality' : s.mode;
  const segments = h('div', { class: 'segmented', role: 'radiogroup' });
  const paint = () =>
    segments.replaceChildren(
      ...(Object.keys(MODES) as Mode[]).map((m) =>
        h('button', { class: mode === m ? 'segment active' : 'segment', type: 'button', role: 'radio', 'aria-checked': String(mode === m), title: t(MODES[m].desc), onclick: () => ((mode = m), paint()) }, t(QUALITY[m])),
      ),
    );
  paint();
  const start = h('button', { class: 'btn primary', type: 'button' }, t('detail.tool.translate'));
  const close = openModal(
    t('upload.translateTitle', { name: docTitle(job, lib.cards[job.id]) }),
    [h('label', { class: 'up-field' }, h('span', {}, t('home.to')), target), ...(isOnline(s) ? [] : [h('div', { class: 'up-field' }, h('span', {}, t('home.mode')), segments)])],
    [h('button', { class: 'btn', type: 'button', onclick: () => close() }, t('region.close')), start],
  );
  start.addEventListener('click', () => {
    close();
    window.api.translateJob(job.id, mode, target.value).then(
      () => {
        note(job.id, t('upload.translateQueued', { lang: languageName(target.value) }));
        render();
      },
      (e) => toast(cleanError(e), true),
    );
  });
}

async function toWord(job: Job) {
  busy.add(job.id);
  render();
  try {
    const file = await window.api.saveWord(job.id, 'original');
    if (file) note(job.id, t('detail.word.saved', { path: file }));
  } catch (e) {
    toast(cleanError(e), true);
  } finally {
    busy.delete(job.id);
    render();
  }
}

const ask = async (id: string) => {
  await host.openJob(id);
  openChat();
};

// ---------- Vykreslení ----------

const TOOLS: { label: MessageKey; icon: string; run: (job: Job) => void }[] = [
  { label: 'detail.tool.translate', icon: ICONS.translate, run: translateDialog },
  { label: 'detail.tool.word', icon: ICONS.file, run: (j) => void toWord(j) },
  { label: 'detail.tool.extract', icon: ICONS.sparkle, run: (j) => void host.openJob(j.id) },
  { label: 'detail.tool.ask', icon: ICONS.chat, run: (j) => void ask(j.id) },
];

const remove = (id: string) => {
  tray = tray.filter((x) => x !== id);
  render();
};

const removeButton = (id: string) => h('button', { class: 'icon-btn', type: 'button', title: t('upload.removeFromList'), 'aria-label': t('upload.removeFromList'), onclick: () => remove(id) }, icon(ICONS.x));

/** Název, typ a první věta shrnutí; u rozpracovaného souboru stav průběhu. */
function describe(job: Job, card?: DocumentCard) {
  if (isActive(job)) {
    const info = progressInfo(job);
    return { name: `${job.name}${job.ext}`, meta: [info.label, info.eta].filter(Boolean).join(' · ') };
  }
  if (job.status !== 'done') return { name: `${job.name}${job.ext}`, meta: job.error ?? '' };
  const parts = [card && t(`docType.${card.type}` as MessageKey), job.pages && t('cost.pages', { count: job.pages }), card && languageName(card.lang), docSubtitle(job, card)];
  return { name: docTitle(job, card), meta: parts.filter(Boolean).join(' · ') };
}

const typeIcon = (job: Job) => h('span', { class: 'up-ico' }, icon(job.status === 'error' ? ICONS.alert : ICONS.file));

/** Návrh složky s tlačítky; po potvrzení řádek „Uloženo do …“. */
function saveRow(job: Job, s?: Suggestion) {
  const id = job.id;
  if (s?.confirmed) {
    return h('div', { class: 'up-save ok' }, icon(ICONS.check), h('span', { class: 'up-sg' }, t('upload.savedTo'), ' ', h('b', {}, s.path)));
  }
  const suggest = s
    ? h('span', { class: 'up-sg' }, icon(ICONS.sparkle), t('upload.suggests'), ' ', h('b', {}, s.path), ' ', h('span', { class: `chip${s.sure ? ' ok' : ' warn'}` }, t(s.sure ? 'upload.sure' : 'upload.unsure')))
    : h('span', { class: 'up-sg muted' }, t('upload.noSuggestion'));
  return h(
    'div',
    { class: 'up-save' },
    suggest,
    s && h('button', { class: 'btn primary sm', type: 'button', onclick: () => void saveTo(id, s) }, icon(ICONS.check), t('upload.saveHere')),
    h('button', { class: 'btn sm', type: 'button', onclick: () => elsewhere(id) }, t('upload.elsewhere')),
    h('button', { class: 'btn sm', type: 'button', onclick: () => void discard(id) }, t('upload.discard')),
  );
}

const didRows = (id: string) => (did.get(id) ?? []).map((text) => h('div', { class: 'up-did' }, icon(ICONS.check), h('span', {}, text)));

function trayCard(job: Job) {
  const card = lib.cards[job.id];
  const { name, meta } = describe(job, card);
  const ready = job.status === 'done';
  return h(
    'div',
    { class: `up-card${isActive(job) ? ' reading' : ''}` },
    h(
      'div',
      { class: 'up-top' },
      typeIcon(job),
      h('div', { class: 'up-mid' }, h('div', { class: 'up-name', title: name }, name), h('div', { class: `up-meta${job.status === 'error' ? ' err' : ''}` }, isActive(job) && h('span', { class: 'chat-spin' }), meta)),
      removeButton(job.id),
    ),
    isActive(job) && progressBar(progressInfo(job).fraction),
    ready && saveRow(job, suggestion(lib.library, job.id, card)),
    ready &&
      h(
        'div',
        { class: 'up-tools' },
        ...TOOLS.map((tool) => h('button', { class: 'btn sm', type: 'button', disabled: busy.has(job.id), onclick: () => tool.run(job) }, icon(tool.icon), t(tool.label))),
      ),
    ...didRows(job.id),
  );
}

function trayRow(job: Job) {
  const card = lib.cards[job.id];
  const { name, meta } = describe(job, card);
  const ready = job.status === 'done';
  const s = ready ? suggestion(lib.library, job.id, card) : undefined;
  const status = isActive(job)
    ? h('span', { class: 'up-sg muted' }, h('span', { class: 'chat-spin' }), t('upload.reading'))
    : s?.confirmed
      ? h('span', { class: 'up-sg' }, icon(ICONS.check), t('upload.savedTo'), ' ', h('b', {}, s.path))
      : s
        ? h('span', { class: 'up-sg' }, h('span', { class: 'muted' }, '→'), h('b', {}, s.path), h('span', { class: `chip${s.sure ? ' ok' : ' warn'}` }, t(s.sure ? 'upload.sure' : 'upload.unsure')))
        : h('span', { class: 'up-sg muted' }, job.status === 'error' ? t(STATUS_TEXT.error) : t('upload.noSuggestion'));
  const save = ready && s && !s.confirmed ? h('button', { class: 'btn sm', type: 'button', onclick: () => void saveTo(job.id, s) }, icon(ICONS.check), t('upload.save')) : h('span');
  const item = (label: string, ico: string, run: () => void, danger = false) =>
    h('button', { type: 'button', role: 'menuitem', class: danger ? 'danger' : '', onclick: () => ((menuOpen = null), run()) }, icon(ico), label);
  const menu = h(
    'div',
    { class: 'menu', role: 'menu' },
    ...(ready ? [item(t('upload.saveElsewhere'), ICONS.folder, () => elsewhere(job.id)), ...(s?.confirmed ? [] : [item(t('upload.discard'), ICONS.trash, () => void discard(job.id))]), h('div', { class: 'menu-sep' })] : []),
    ...(ready ? TOOLS.map((tool) => item(t(tool.label), tool.icon, () => tool.run(job))) : []),
    ...(ready ? [h('div', { class: 'menu-sep' })] : []),
    item(t('upload.removeFromList'), ICONS.x, () => remove(job.id)),
  );
  return h(
    'div',
    { class: `up-row${isActive(job) ? ' reading' : ''}` },
    typeIcon(job),
    h('div', { class: 'up-mid' }, h('div', { class: 'up-name', title: name }, name), h('div', { class: `up-meta${job.status === 'error' ? ' err' : ''}` }, meta)),
    status,
    save,
    h(
      'span',
      { class: 'menu-wrap' },
      h(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          title: t('library.more'),
          'aria-label': t('library.more'),
          'aria-haspopup': 'menu',
          onclick: (e: Event) => {
            e.stopPropagation();
            menuOpen = menuOpen === job.id ? null : job.id;
            render();
          },
        },
        icon(ICONS.more),
      ),
      menuOpen === job.id && menu,
    ),
    ...didRows(job.id).map((r) => h('div', { class: 'up-row-did' }, r)),
  );
}

/** Soubor, který už v knihovně je: otevřít nebo přesto nahrát. */
function dupCard(w: DupWait) {
  const drop = () => {
    waiting = waiting.filter((x) => x !== w);
    render();
  };
  const trashed = w.match.trashed;
  return h(
    'div',
    { class: 'up-card' },
    h(
      'div',
      { class: 'up-top' },
      h('span', { class: 'up-ico' }, icon(ICONS.copy)),
      h('div', { class: 'up-mid' }, h('div', { class: 'up-name', title: w.path }, w.name), h('div', { class: 'up-meta' }, t(trashed ? 'upload.dupTrash' : 'upload.dupHave', { name: w.match.name }))),
      h('button', { class: 'icon-btn', type: 'button', title: t('upload.removeFromList'), 'aria-label': t('upload.removeFromList'), onclick: drop }, icon(ICONS.x)),
    ),
    h(
      'div',
      { class: 'up-save' },
      trashed
        ? h('button', { class: 'btn sm', type: 'button', onclick: () => void window.api.restoreJobs([w.match.id]).then(() => (toast(t('home.dupRestored')), drop()), (e) => toast(cleanError(e), true)) }, t('home.dupRestore'))
        : h('button', { class: 'btn sm', type: 'button', onclick: () => (drop(), void host.openJob(w.match.id)) }, t('home.dupOpen')),
      h('button', { class: 'btn sm', type: 'button', onclick: () => (drop(), void enqueue([w.path]).then(render)) }, t('upload.dupAnyway')),
    ),
  );
}

function recentSection() {
  const done = host
    .jobs()
    .filter((j) => j.status === 'done')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, RECENT);
  if (!done.length) return null;
  return h(
    'section',
    { class: 'ov-card up-recent' },
    h('h2', {}, icon(ICONS.clock), t('upload.recent'), h('button', { class: 'ov-link', type: 'button', onclick: host.showAll }, t('overview.allFiles'))),
    h(
      'div',
      { class: 'dl-list' },
      ...done.map((j) => {
        const card = lib.cards[j.id];
        return h(
          'button',
          { class: 'ov-row', type: 'button', onclick: () => void host.openJob(j.id), title: docTitle(j, card) },
          h('span', { class: 'ov-row-title' }, docTitle(j, card)),
          h('span', { class: 'ov-row-sub' }, [card && t(`docType.${card.type}` as MessageKey), date(j.createdAt)].filter(Boolean).join(' · ')),
        );
      }),
    ),
  );
}

export function renderUpload() {
  if (!host || document.body.dataset.view !== 'upload') return;
  render();
}

function render() {
  const jobs = trayJobs();
  const total = traySize();
  const savable = jobs.filter((j) => j.status === 'done' && bulkSavable(suggestion(lib.library, j.id, lib.cards[j.id]))).length;
  const all = $<HTMLButtonElement>('upload-save-all');
  all.hidden = savable < 2;
  all.querySelector('span')!.textContent = t('upload.saveAll', { count: savable });
  $('upload-drop').classList.toggle('compact', total > 0);

  const body = $('upload-body');
  if (!total) {
    const recent = recentSection();
    body.replaceChildren(...(recent ? [recent] : []));
    return;
  }
  const view = currentLayout();
  const seg = (key: 'cards' | 'list', label: MessageKey) =>
    h('button', { class: view === key ? 'segment active' : 'segment', type: 'button', 'aria-pressed': String(view === key), onclick: () => ((layout = key), render()) }, t(label));
  const items = view === 'list' ? [...waiting.map(dupCard), ...jobs.map(trayRow)] : [...waiting.map(dupCard), ...jobs.map(trayCard)];
  const recent = recentSection();
  body.replaceChildren(
    h('div', { class: 'up-head' }, h('h2', { class: 'section-title' }, t('upload.tray', { count: total })), h('div', { class: 'segmented', role: 'group', 'aria-label': t('upload.layout') }, seg('cards', 'upload.cards'), seg('list', 'upload.list'))),
    h('div', { class: view === 'list' ? 'up-list' : 'up-cards' }, ...items),
    h('p', { class: 'muted small up-foot' }, t('upload.foot')),
    ...(recent ? [recent] : []),
  );
}

export function setupUpload(uploadHost: UploadHost) {
  host = uploadHost;
  $('upload-drop').addEventListener('click', async () => addUploads(await window.api.pickFiles()));
  $('upload-import').addEventListener('click', async () => {
    const paths = await window.api.pickFolder();
    if (paths.length) await addUploads(paths);
    else toast(t('upload.folderEmpty'));
  });
  $('upload-save-all').addEventListener('click', saveAll);
  document.addEventListener('click', () => {
    if (menuOpen === null) return;
    menuOpen = null;
    renderUpload();
  });
  window.api.onLibraryChanged(() => void reloadState());
  document.addEventListener('libraries-changed', () => void reloadState());
  void reloadState();
}
