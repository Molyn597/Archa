import { docSubtitle, docTitle } from '../shared/doc-title';
import { childFolders, folderName, isLocked } from '../shared/folders';
import { t, type MessageKey } from '../shared/i18n';
import { languageName, LANGUAGES } from '../shared/languages';
import { isOnline } from '../shared/provider';
import { bulkSavable, suggestion, type Suggestion } from '../shared/upload';
import type { DocumentCard, DuplicateMatch, Job, LibraryState, Mode, Provider, Settings } from '../shared/types';
import { openChat } from './chat';
import { currentTitle, libraryFor, libraryTitle, moveDocTo } from './library-switch';
import { actionMenu, cleanError, date, h, icon, ICONS, MODES, openModal, progressBar, progressInfo, STATUS_TEXT, toast, toastAction } from './dom';

interface UploadHost {
  jobs(): Job[];
  settings(): Settings;
  /** Otevře stránku Nahrát (soubory pustené kdekoli v okně). */
  show(): void;
  openJob(id: string): Promise<void>;
  showAll(): void;
  showSettings(): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const RECENT = 5;
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
let recentOpen = false;
// Řádky „Hotovo“ pod řádkem (Word uložen, překlad zařazen) a běžící nástroje.
const did = new Map<string, string[]>();
const busy = new Set<string>();
// Dokumenty, u kterých uživatel odmítl návrh jiné knihovny („Nechat v …“).
const stay = new Set<string>();

const isActive = (j: Job) => j.status === 'running' || j.status === 'queued';
const note = (id: string, text: string) => did.set(id, [...(did.get(id) ?? []), text]);

const traySize = () => waiting.length + trayJobs().length;
const trayJobs = () => {
  const byId = new Map(host.jobs().map((j) => [j.id, j]));
  return tray.map((id) => byId.get(id)).filter((j): j is Job => Boolean(j));
};

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

/** Zpracování bez překladu: soubor se přečte, popíše a zařadí; překlad je nástroj v nabídce řádku. */
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

// ---------- Akce řádku ----------

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

/** Návrh jiné knihovny pro hotový, dosud nepotvrzený dokument. */
function otherLibrary(job: Job) {
  if (job.status !== 'done' || stay.has(job.id) || suggestion(lib.library, job.id, lib.cards[job.id])?.confirmed) return null;
  return libraryFor(lib.cards[job.id]);
}

/** Hromadně se ukládá jen v otevřené knihovně: přesun mezi knihovnami kopíruje soubory, ať ho uživatel potvrdí u každého dokumentu zvlášť. */
const bulkReady = (job: Job) => job.status === 'done' && !otherLibrary(job) && bulkSavable(suggestion(lib.library, job.id, lib.cards[job.id]));

function saveAll() {
  const todo = trayJobs().flatMap((j) => {
    const s = suggestion(lib.library, j.id, lib.cards[j.id]);
    return bulkReady(j) && s ? [{ id: j.id, s }] : [];
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

/** Do koše (jde obnovit); řádek zmizí a po Vrátit se vrátí. */
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
  let mode: Mode = s.mode;
  let provider: Provider = s.provider;
  const segments = h('div', { class: 'segmented', role: 'radiogroup' });
  const where = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': t('home.provider') });
  const modeField = h('div', { class: 'up-field' }, h('span', {}, t('home.mode')), segments);
  const notReady = h('div', { class: 'warn-box up-notready' });
  notReady.hidden = true;
  const start = h('button', { class: 'btn primary', type: 'button' }, t('detail.tool.translate'));
  let check = 0;
  const paint = () => {
    segments.replaceChildren(
      ...(Object.keys(MODES) as Mode[]).map((m) =>
        h('button', { class: mode === m ? 'segment active' : 'segment', type: 'button', role: 'radio', 'aria-checked': String(mode === m), title: t(MODES[m].desc), onclick: () => ((mode = m), paint()) }, t(QUALITY[m])),
      ),
    );
    where.replaceChildren(
      ...(['local', 'openrouter'] as Provider[]).map((p) =>
        h('button', { class: provider === p ? 'segment active' : 'segment', type: 'button', role: 'radio', 'aria-checked': String(provider === p), title: t(`home.provider.${p}Desc`), onclick: () => ((provider = p), paint()) }, t(`home.provider.${p}`)),
      ),
    );
    modeField.hidden = isOnline({ provider });
    // Připravenost se ověřuje v hlavním procesu; zastaralá odpověď (rychlé přepnutí) se zahodí.
    const mine = ++check;
    start.disabled = true;
    void window.api.providerReady(provider).then((reason) => {
      if (mine !== check) return;
      start.disabled = Boolean(reason);
      notReady.hidden = !reason;
      if (reason)
        notReady.replaceChildren(
          h('p', {}, reason),
          h('button', { class: 'btn sm', type: 'button', onclick: () => (close(), host.showSettings()) }, t('error.openSettings')),
        );
    });
  };
  const close = openModal(
    t('upload.translateTitle', { name: docTitle(job, lib.cards[job.id]) }),
    [h('label', { class: 'up-field' }, h('span', {}, t('home.to')), target), h('div', { class: 'up-field' }, h('span', {}, t('home.provider')), where), modeField, notReady],
    [h('button', { class: 'btn', type: 'button', onclick: () => close() }, t('region.close')), start],
  );
  paint();
  start.addEventListener('click', () => {
    close();
    window.api.translateJob(job.id, isOnline({ provider }) ? 'quality' : mode, target.value, provider).then(
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

const didRows = (id: string) => (did.get(id) ?? []).map((text) => h('div', { class: 'up-did' }, icon(ICONS.check), h('span', {}, text)));

function trayRow(job: Job) {
  const card = lib.cards[job.id];
  const { name, meta } = describe(job, card);
  const ready = job.status === 'done';
  const s = ready ? suggestion(lib.library, job.id, card) : undefined;
  const other = otherLibrary(job);
  const status = isActive(job)
    ? h('span', { class: 'up-sg muted' }, h('span', { class: 'chat-spin' }), t('upload.reading'))
    : other
      ? h('span', { class: 'up-sg' }, h('span', { class: 'muted' }, '→'), h('b', {}, [libraryTitle(other.library), other.folders[0]].filter(Boolean).join(' · ')))
      : s?.confirmed
      ? h('span', { class: 'up-sg' }, icon(ICONS.check), t('upload.savedTo'), ' ', h('b', {}, s.path))
      : s
        ? h('span', { class: 'up-sg' }, h('span', { class: 'muted' }, '→'), h('b', {}, s.path), h('span', { class: `chip${s.sure ? ' ok' : ' warn'}` }, t(s.sure ? 'upload.sure' : 'upload.unsure')))
        : h('span', { class: 'up-sg muted' }, job.status === 'error' ? t(STATUS_TEXT.error) : t('upload.noSuggestion'));
  const save = other
    ? h('button', { class: 'btn primary sm', type: 'button', onclick: () => void moveDocTo(job.id, other.library, other.folders).then(reloadState) }, icon(ICONS.check), t('upload.save'))
    : ready && s && !s.confirmed
      ? h('button', { class: 'btn primary sm', type: 'button', onclick: () => void saveTo(job.id, s) }, icon(ICONS.check), t('upload.save'))
      : h('span');
  const menu = actionMenu(() => [
    ...(ready ? [{ label: t('upload.saveElsewhere'), icon: ICONS.folder, run: () => elsewhere(job.id) }, ...(other ? [{ label: t('upload.stay', { library: currentTitle() }), icon: ICONS.check, run: () => (stay.add(job.id), render()) }] : []), ...(s?.confirmed ? [] : [{ label: t('upload.discard'), icon: ICONS.trash, run: () => discard(job.id) }]), null] : []),
    ...(ready ? [...TOOLS.map((tool) => ({ label: t(tool.label), icon: tool.icon, disabled: busy.has(job.id), run: () => tool.run(job) })), null] : []),
    { label: t('upload.removeFromList'), icon: ICONS.x, run: () => remove(job.id) },
  ]);
  return h(
    'div',
    { class: `up-row${isActive(job) ? ' reading' : ''}` },
    typeIcon(job),
    h('div', { class: 'up-mid' }, h('div', { class: 'up-name', title: name }, name), h('div', { class: `up-meta${job.status === 'error' ? ' err' : ''}` }, meta)),
    status,
    save,
    menu,
    ...didRows(job.id).map((r) => h('div', { class: 'up-row-did' }, r)),
  );
}

/** Soubor, který už v knihovně je: otevřít nebo přesto nahrát. */
function dupRow(w: DupWait) {
  const drop = () => {
    waiting = waiting.filter((x) => x !== w);
    render();
  };
  const trashed = w.match.trashed;
  return h(
    'div',
    { class: 'up-row up-dup' },
    h('span', { class: 'up-ico' }, icon(ICONS.copy)),
    h('div', { class: 'up-mid' }, h('div', { class: 'up-name', title: w.path }, w.name), h('div', { class: 'up-meta' }, t(trashed ? 'upload.dupTrash' : 'upload.dupHave', { name: w.match.name }))),
    h('span'),
    trashed
      ? h('button', { class: 'btn sm', type: 'button', onclick: () => void window.api.restoreJobs([w.match.id]).then(() => (toast(t('home.dupRestored')), drop()), (e) => toast(cleanError(e), true)) }, t('home.dupRestore'))
      : h('button', { class: 'btn sm', type: 'button', onclick: () => (drop(), void host.openJob(w.match.id)) }, t('home.dupOpen')),
    actionMenu(() => [
      { label: t('upload.dupAnyway'), icon: ICONS.upload, run: () => (drop(), enqueue([w.path]).then(render)) },
      { label: t('upload.removeFromList'), icon: ICONS.x, run: drop },
    ]),
  );
}

function recentSection() {
  const done = host
    .jobs()
    .filter((j) => j.status === 'done')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, RECENT);
  if (!done.length) return null;
  const details = h(
    'details',
    { class: 'ov-card up-recent' },
    h('summary', {}, icon(ICONS.clock), t('upload.recent', { count: done.length })),
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
    h('button', { class: 'ov-link', type: 'button', onclick: host.showAll }, t('overview.allFiles')),
  ) as HTMLDetailsElement;
  details.open = recentOpen;
  details.addEventListener('toggle', () => (recentOpen = details.open));
  return details;
}

export function renderUpload() {
  if (!host || document.body.dataset.view !== 'upload') return;
  render();
}

function render() {
  const jobs = trayJobs();
  const total = traySize();
  const savable = jobs.filter(bulkReady).length;
  const all = $<HTMLButtonElement>('upload-save-all');
  all.hidden = savable < 2;
  all.querySelector('span')!.textContent = t('upload.saveAll', { count: savable });

  const recent = recentSection();
  $('upload-body').replaceChildren(
    ...(total ? [h('h2', { class: 'section-title' }, t('upload.tray', { count: total })), h('div', { class: 'up-list' }, ...waiting.map(dupRow), ...jobs.map(trayRow))] : []),
    ...(recent ? [recent] : []),
  );
}

export function setupUpload(uploadHost: UploadHost) {
  host = uploadHost;
  $('upload-drop').addEventListener('click', async () => addUploads(await window.api.pickFiles()));
  $('upload-more').replaceChildren(
    actionMenu(() => [
      {
        label: t('upload.import'),
        icon: ICONS.folder,
        run: async () => {
          const paths = await window.api.pickFolder();
          if (paths.length) await addUploads(paths);
          else toast(t('upload.folderEmpty'));
        },
      },
    ]),
  );
  $('upload-save-all').addEventListener('click', saveAll);
  window.api.onLibraryChanged(() => void reloadState());
  document.addEventListener('libraries-changed', () => void reloadState());
  void reloadState();
}
