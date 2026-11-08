import { writeFile } from 'node:fs/promises';
import { tempCopy, wipeTempCopies } from './temp-open';
import { lockTransitions, syncLocks } from './locks';
import { passwordOk, WrongPasswordError } from './vault';
import { VaultState } from './vault-state';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron';
import { resolveLang, setLang, t, type MessageKey } from '../shared/i18n';
import { LIBRARY_CHAT, projectChatKey, TRASH_DAYS } from '../shared/folders';
import { languageName } from '../shared/languages';
import { findRegion, normalizeCrop } from '../shared/regions';
import type { ChatModel, DocumentCard, Libraries, LibraryKind, DuplicateMatch, Highlight, Project, ProjectKind, Job, Library, LibraryFolder, JobOptions, Mode, OrganizePlan, OutputKind, Placement, Provider, RegionTranslation, Settings, Stage } from '../shared/types';
import { isOnline } from '../shared/provider';
import { exportTable, invoiceRows, isoDay, toCsv } from '../shared/invoices';
import { buildXlsx } from './xlsx';
import { buildDocx, loadFigures } from './docx';
import { originalText } from './segments';
import { isTranslated } from '../shared/detail-tabs';
import { makeCard } from './make-card';
import { answerQuestion, applyPlan, markOpened, mergeFolders, moveDocs, moveFolder, removeFolder, shouldBeLocked, undoPlacement } from './library';
import { organizeFolder, suggestMerges } from './organize';
import { askDocument } from './chat';
import { askLibrary } from './library-chat';
import { askProject } from './project-chat';
import { buildIndex, embedder, embedModelFor, indexModel } from './embed';
import { fileInfo } from './fileinfo';
import { fillHashes, hashFile } from './hash';
import { adoptFolder } from '../shared/duplicates';
import { addSources, newProject } from '../shared/projects';
import { usdCzk } from './fx';
import { clearKey, readKey, saveKey } from './keystore';
import { listModels, status } from './lmstudio';
import { fetchEmbedCatalog, openrouterStatus, refreshCatalog } from './provider';
import { relayoutJob, translateRegion } from './pipeline';
import { Queue, SUPPORTED, type QueueEvents } from './queue';
import { createLibrary, libraryRoot, loadLibraries, saveLibraries, setupLibraries } from './libraries';
import { checkUpdate, downloadUpdate } from './updates';
import { Store } from './store';

const isMac = process.platform === 'darwin';
const TITLE_BAR = {
  light: { color: '#F7F7F6', symbolColor: '#18181B' },
  dark: { color: '#0B0B0C', symbolColor: '#EDEDEF' },
};
const STAGE_LABEL: Record<Stage, MessageKey> = {
  prepare: 'tray.stage.prepare',
  extract: 'tray.stage.extract',
  ocr: 'tray.stage.ocr',
  tables: 'tray.stage.tables',
  context: 'tray.stage.context',
  translate: 'tray.stage.translate',
  check: 'tray.stage.check',
  fix: 'tray.stage.fix',
  write: 'tray.stage.write',
  layout: 'tray.stage.layout',
};

if (process.env.TRANSLATTE_USER_DATA) app.setPath('userData', process.env.TRANSLATTE_USER_DATA);

const appRoot = app.getPath('userData');
/** Aktuální knihovna: úložiště, trezor a fronta se při přepnutí vymění (handlery IPC je čtou až při volání). */
let libs: Libraries;
let store: Store;
let vault: VaultState;
let queue: Queue;
let win: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
const active = new Map<string, Job>();

const send = (channel: string, ...args: unknown[]) => win?.webContents.send(channel, ...args);

/** Doplní otisky starších dokumentů na pozadí a pošle je oknu (přehled duplicit). */
const refreshHashes = async () => {
  for (const job of await fillHashes(store).catch(() => [] as Job[])) send('job-update', job);
};
/** Knihovna se změnila; když AI přitom založila složky, renderer nabídne Vrátit. */
const libraryChanged = (placed?: Placement) => {
  send('library-changed');
  // Oznámení s Vrátit jen u nově založených složek; ostatní zařazení jsou v přehledu „Zařadila AI“.
  if (placed?.created.length) send('library-placed', placed);
};

const queueEvents: QueueEvents = {
  update(job) {
    if (job.status === 'running' || job.status === 'queued') active.set(job.id, job);
    else active.delete(job.id);
    send('job-update', job);
    updateProgressUi();
  },
  async finished(job) {
    const settings = await store.settings();
    if (!settings.notify || !Notification.isSupported()) return;
    if (job.status !== 'done' && job.status !== 'error') return;
    const n = new Notification({
      title: job.status === 'done' ? t('notify.done') : t('notify.failed'),
      body:
        job.status === 'done'
          ? job.warnings
            ? t('notify.doneWarnings', { name: job.name, lang: languageName(job.targetLang), count: job.warnings })
            : t('notify.doneBody', { name: job.name, lang: languageName(job.targetLang) })
          : `${job.name}: ${job.error ?? ''}`.slice(0, 200),
      silent: false,
    });
    n.on('click', () => {
      showWindow();
      send('open-job', job.id);
    });
    n.show();
  },
  idle: () => updateProgressUi(),
  library: libraryChanged,
};

/** Otevře knihovnu: vlastní úložiště (společné nastavení AI zůstává v userData), trezor a frontu. */
function openLibrary(id: string) {
  store = new Store(libraryRoot(appRoot, id), appRoot);
  // Trezor zamčených složek; změna stavu = renderer znovu načte úlohy i knihovnu.
  vault = new VaultState(store, () => {
    send('vault-changed');
    send('library-changed');
  });
  queue = new Queue(store, queueEvents);
}

/** Úklid knihovny po otevření: přerušené šifrování a úlohy, starý koš, otisky. */
async function startLibrary() {
  await store.cleanupLocked().catch(() => undefined);
  await queue.recover();
  await queue.purgeOld(TRASH_DAYS).catch(() => undefined);
  void refreshHashes();
}

/** Přepnutí knihovny: trezor předchozí se zamkne (dočasné kopie pryč), okno se načte znovu. */
async function switchLibrary(id: string) {
  if (!libs.list.some((l) => l.id === id)) throw new Error('Unknown library');
  if (id === libs.current) return;
  if (queue.busy) throw new Error(t('libraries.busy'));
  await vault.dispose();
  libs.current = id;
  await saveLibraries(appRoot, libs);
  openLibrary(id);
  await startLibrary();
  win?.webContents.reload();
}

/** Celkový průběh z uplynulého času a odhadu zbytku; průběh fáze by u každé fáze začínal od nuly. */
function overallProgress(job: Job) {
  const eta = job.progress?.eta;
  if (eta === undefined || !job.startedAt) return -1;
  const elapsed = (Date.now() - job.startedAt) / 1000;
  return Math.min(0.99, elapsed / (elapsed + eta));
}

function updateProgressUi() {
  const running = [...active.values()].find((j) => j.status === 'running');
  const fraction = running ? overallProgress(running) : -1;
  // Dock / hlavní panel Windows ukazuje průběh i se schovaným oknem.
  win?.setProgressBar(running ? (fraction < 0 ? 2 : fraction) : -1);
  if (!tray) return;
  const waiting = [...active.values()].filter((j) => j.status === 'queued').length;
  const percent = t('common.percent', { percent: Math.round(fraction * 100) });
  const stage = running && t(STAGE_LABEL[running.progress?.stage ?? 'prepare']);
  const label = running
    ? fraction >= 0
      ? t('tray.runningPercent', { stage: stage!, name: running.name, percent })
      : t('tray.running', { stage: stage!, name: running.name })
    : t('tray.idle');
  if (isMac) tray.setTitle(running && fraction >= 0 ? percent : '');
  tray.setToolTip(`TransLatte – ${label}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      ...(waiting ? [{ label: t('tray.waiting', { count: waiting }), enabled: false }] : []),
      { type: 'separator' },
      { label: t('tray.open'), click: showWindow },
      { label: t('tray.quit'), click: () => app.quit() },
    ]),
  );
}

function createTray() {
  const icon = isMac
    ? nativeImage.createFromPath(path.join(__dirname, 'trayTemplate.png'))
    : nativeImage.createFromPath(path.join(__dirname, 'tray-win.png'));
  if (isMac) icon.setTemplateImage(true);
  tray = new Tray(icon);
  if (!isMac) tray.on('click', showWindow);
  updateProgressUi();
}

function setMenu() {
  const template: MenuItemConstructorOptions[] = [];
  if (isMac) template.push({ role: 'appMenu' });
  template.push({ role: 'editMenu' });
  if (!app.isPackaged) template.push({ label: t('menu.dev'), submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function applyTheme(theme: Settings['theme']) {
  nativeTheme.themeSource = theme;
  if (!isMac && win) win.setTitleBarOverlay({ ...TITLE_BAR[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'], height: 36 });
}

function applyLang(uiLang: Settings['uiLang']) {
  setLang(resolveLang(uiLang, app.getLocale()));
  setMenu();
  updateProgressUi();
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    title: 'TransLatte',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0B0B0C' : '#F7F7F6',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? {} : { titleBarOverlay: { ...TITLE_BAR[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'], height: 36 } }),
    autoHideMenuBar: !isMac,
    ...(isMac ? {} : { icon: path.join(__dirname, 'icon.png') }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // Během překladu zavření okna aplikaci neukončí, překlad doběhne na pozadí (ikona v liště).
  win.on('close', (e) => {
    if (!quitting && (queue.busy || isMac)) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on('closed', () => (win = undefined));
  win.loadFile(path.join(__dirname, 'index.html'));
}

const outputName = (job: Job, kind: OutputKind = 'docx') => (kind === 'pdf' ? job.outputPdf : kind === 'input' ? `input${job.ext}` : job.output);

function jobFile(job: Job, kind: OutputKind = 'docx') {
  const name = outputName(job, kind);
  return name ? path.join(store.jobDir(job.id), name) : null;
}

/** Úlohy mimo zamčené složky: hromadné AI zpracování (karty, fakta, indexy) zamčené dokumenty nikdy neposílá modelu. */
async function openJobs() {
  const library = await store.library();
  return (await store.jobs()).filter((j) => !shouldBeLocked(library, j.id));
}

function registerIpc() {
  ipcMain.handle('libraries', () => libs);
  ipcMain.handle('libraries-switch', (_e, id: string) => switchLibrary(id));
  ipcMain.handle('libraries-setup', async (_e, kinds: LibraryKind[], opts: { subjects?: string[]; keep?: LibraryKind }) => {
    libs = await setupLibraries(appRoot, libs, kinds, opts);
    send('library-changed');
    return libs;
  });
  ipcMain.handle('libraries-create', async (_e, kind: LibraryKind, name?: string, subjects?: string[]) => {
    const info = await createLibrary(appRoot, libs, kind, subjects, name);
    await switchLibrary(info.id);
    return info;
  });
  ipcMain.handle('libraries-rename', async (_e, id: string, name: string) => {
    const info = libs.list.find((l) => l.id === id);
    if (!info) return libs;
    if (name.trim()) info.name = name.trim();
    else delete info.name;
    await saveLibraries(appRoot, libs);
    return libs;
  });
  ipcMain.handle('settings', () => store.settings());
  ipcMain.handle('settings-save', async (_e, settings: Settings) => {
    // lastUpdateCheck patří hlavnímu procesu; zastaralá kopie z okna ho nesmí přepsat.
    await store.saveSettings({ ...settings, lastUpdateCheck: (await store.settings()).lastUpdateCheck });
    applyTheme(settings.theme);
    applyLang(settings.uiLang);
  });
  ipcMain.handle('lm-status', async (_e, provider?: Provider) => {
    const s = await store.settings();
    return isOnline({ provider: provider ?? s.provider }) ? openrouterStatus(s.remoteModels, await readKey(store.appRoot)) : status(s.apiUrl, s.models);
  });
  ipcMain.handle('catalog-refresh', () => refreshCatalog());
  // Klíč se do okna nikdy nevrací, jen informace, zda existuje.
  ipcMain.handle('api-key-has', async () => Boolean(await readKey(store.appRoot)));
  ipcMain.handle('api-key-set', (_e, key: string) => saveKey(store.appRoot, key));
  ipcMain.handle('api-key-clear', () => clearKey(store.appRoot));
  ipcMain.handle('pick-files', async () => {
    const res = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: t('dialog.documents'), extensions: SUPPORTED.map((e) => e.slice(1)) }],
    });
    return res.canceled ? [] : res.filePaths;
  });
  ipcMain.handle('file-info', (_e, paths: string[]) => fileInfo(paths));
  ipcMain.handle('usd-czk', () => usdCzk(store));
  ipcMain.handle('app-version', () => app.getVersion());
  ipcMain.handle('update-check', (_e, auto?: boolean) => checkUpdate(store, Boolean(auto)));
  ipcMain.handle('update-download', () => downloadUpdate((received, total) => send('update-progress', { received, total })));
  ipcMain.handle('app-quit', () => app.quit());
  ipcMain.handle('open-url', async (_e, url: string) => {
    if (typeof url === 'string' && url.startsWith('https://github.com/')) await shell.openExternal(url);
  });
  ipcMain.handle('jobs-add', async (_e, paths: string[], options: JobOptions) => {
    const errors: string[] = [];
    const ids: string[] = [];
    for (const p of paths) {
      try {
        ids.push(await queue.add(p, options));
      } catch (e) {
        errors.push(`${path.basename(p)}: ${(e as Error).message}`);
      }
    }
    if (errors.length) throw new Error(errors.join('\n'));
    return ids;
  });
  ipcMain.handle('jobs', () => store.jobs());
  // Shodné soubory v knihovně (i v koši); zamčené dokumenty jen s odemčeným trezorem.
  ipcMain.handle('duplicates-check', async (_e, paths: string[]): Promise<DuplicateMatch[][]> => {
    const jobs = [...(await store.jobs()), ...(await store.jobs(true))];
    return Promise.all(
      paths.map(async (p) => {
        const hash = await hashFile(p).catch(() => undefined);
        return hash ? jobs.filter((j) => j.inputHash === hash).map((j) => ({ id: j.id, name: j.name, trashed: !!j.trashedAt })) : [];
      }),
    );
  });
  /** Zdrojům projektu bez karty ji na pozadí vytvoří, ať se rovnou objeví v seznamu literatury (jen hotové, ne zamčené). */
  const cardsForSources = async (ids: string[]) => {
    if (!(await store.settings()).autoCard) return;
    const todo: Job[] = [];
    for (const job of await openJobs()) if (ids.includes(job.id) && job.status === 'done' && !(await store.card(job.id))) todo.push(job);
    for (const job of todo) await queue.exclusive(async () => makeCard(store, job, await store.settings(), libraryChanged)).catch(() => undefined);
    if (todo.length) send('library-changed');
  };
  ipcMain.handle('projects', () => store.projects());
  ipcMain.handle('project-create', async (_e, name: string, kind: ProjectKind) => {
    const project = newProject(name, kind, (await store.settings()).citation.style, randomUUID());
    await store.saveProject(project);
    return project;
  });
  ipcMain.handle('project-save', async (_e, project: Project) => {
    const saved = { ...project, updatedAt: Date.now() };
    await store.saveProject(saved);
    return saved;
  });
  ipcMain.handle('project-chat', (_e, id: string) => store.projectChat(id));
  ipcMain.handle('project-chat-clear', (_e, id: string) => store.saveProjectChat(id, []));
  ipcMain.handle('project-chat-ask', async (_e, id: string, question: string, model?: ChatModel) => {
    const project = await store.project(id);
    if (!project) throw new Error(t('project.missing'));
    const key = projectChatKey(id);
    if (queue.busy) send('chat-progress', { jobId: key, step: t('chat.stepQueue') });
    return queue.exclusive(async () =>
      askProject(store, await store.settings(), project, question, model, {
        step: (step, tags) => send('chat-progress', { jobId: key, step, tags }),
        delta: (d) => send('chat-delta', { jobId: key, ...d }),
      }),
    );
  });
  ipcMain.handle('project-delete', (_e, id: string) => store.deleteProject(id));
  ipcMain.handle('project-add', async (_e, id: string, jobIds: string[]) => {
    const project = await store.project(id);
    if (!project) throw new Error(t('project.missing'));
    addSources(project, jobIds);
    project.updatedAt = Date.now();
    await store.saveProject(project);
    void cardsForSources(jobIds);
    return project;
  });
  ipcMain.handle('library-dedupe', async (_e, keep: string, drop: string[]) => {
    await editLibrary((library) => adoptFolder(library, keep, drop));
    for (const id of drop) {
      await queue.trash(id);
      send('job-removed', id);
    }
    send('trash-changed');
  });
  ipcMain.handle('job', async (_e, id: string) => {
    const job = active.get(id) ?? (await store.job(id));
    return job ? { job, segments: await store.segments(id) } : null;
  });
  ipcMain.handle('job-opened', async (_e, id: string) => {
    await store.updateLibrary((library) => markOpened(library, id));
  });
  ipcMain.handle('job-input', async (_e, id: string) => {
    const job = await store.job(id);
    return job ? new Uint8Array(await store.readInput(job)) : null;
  });
  ipcMain.handle('job-figure', async (_e, id: string, file: string) => {
    if (!/^figures\/[\w.-]+\.png$/.test(file) || file.includes('..')) throw new Error('Neplatný soubor');
    const job = await store.job(id);
    if (!job) throw new Error('Úloha neexistuje');
    return `data:image/png;base64,${(await store.readJobFile(job.id, file)).toString('base64')}`;
  });
  ipcMain.handle('job-output-pdf', async (_e, id: string) => {
    const job = await store.job(id);
    const name = job && outputName(job, 'pdf');
    return name ? new Uint8Array(await store.readJobFile(job.id, name)) : null;
  });
  ipcMain.handle('job-cancel', (_e, id: string) => queue.cancel(id));
  ipcMain.handle('job-retry', (_e, id: string, mode: Mode, targetLang?: string) => queue.retry(id, mode, targetLang));
  ipcMain.handle('job-relayout', async (_e, id: string) => {
    if (active.has(id)) return;
    const job = await store.job(id);
    if (!job) return;
    await relayoutJob(store, job, await store.settings());
    send('job-update', job);
  });
  ipcMain.handle('job-translate-segments', (_e, id: string, ids: number[]) => queue.translateSegments(id, ids));
  ipcMain.handle('job-regions', (_e, id: string) => store.regions(id));
  ipcMain.handle('job-highlights', (_e, id: string) => store.highlights(id));
  ipcMain.handle('job-highlights-save', async (_e, id: string, list: Highlight[]) => {
    if (!(await store.job(id))) throw new Error(t('highlight.missing'));
    await store.saveHighlights(id, list);
  });
  ipcMain.handle('job-translate-region', async (_e, id: string, page: number, crop: RegionTranslation['crop'], replaces?: RegionTranslation['crop']) => {
    const job = await store.job(id);
    if (!job) throw new Error(t('study.noJob'));
    const saved = replaces ? undefined : findRegion(await store.regions(id), page, normalizeCrop(crop));
    if (saved) return saved;
    const region = await queue.exclusive(async () => translateRegion(store, job, await store.settings(), page, crop, replaces));
    send('job-update', job);
    return region;
  });
  ipcMain.handle('job-delete-region', async (_e, id: string, page: number, crop: RegionTranslation['crop']) => {
    const regions = await store.regions(id);
    const saved = findRegion(regions, page, normalizeCrop(crop));
    if (saved) await store.saveRegions(id, regions.filter((r) => r !== saved));
  });
  ipcMain.handle('job-chat', (_e, id: string) => store.chat(id));
  ipcMain.handle('job-chat-ask', async (_e, id: string, question: string, model?: ChatModel) => {
    const job = await store.job(id);
    if (!job) throw new Error(t('study.noJob'));
    if (queue.busy) send('chat-progress', { jobId: id, step: t('chat.stepQueue') });
    const answer = await queue.exclusive(async () =>
      askDocument(store, job, await store.settings(), question, model, {
        step: (step, tags) => send('chat-progress', { jobId: id, step, tags }),
        delta: (d) => send('chat-delta', { jobId: id, ...d }),
      }),
    );
    send('job-update', job);
    return answer;
  });
  ipcMain.handle('job-chat-clear', (_e, id: string) => store.saveChat(id, []));
  ipcMain.handle('library-answer', (_e, jobId: string, path: string | null) => editLibrary((library) => answerQuestion(library, jobId, path)));
  ipcMain.handle('library-undo', (_e, placement: Placement) => editLibrary((library) => undoPlacement(library, placement)));
  ipcMain.handle('library-organize', async (_e, folderId: string | null, model?: ChatModel) =>
    queue.exclusive(async () => organizeFolder(store, await store.settings(), folderId, model)),
  );
  ipcMain.handle('library-apply', (_e, plan: OrganizePlan) => editLibrary((library) => applyPlan(library, plan)));
  ipcMain.handle('library-merge', (_e, from: string, into: string) =>
    editLibrary((library) => {
      if (!mergeFolders(library, from, into)) throw new Error(t('library.moveInvalid'));
    }),
  );
  ipcMain.handle('library-merge-suggest', async (_e, model?: ChatModel) => queue.exclusive(async () => suggestMerges(store, await store.settings(), model)));
  ipcMain.handle('embed-models', async (_e, provider: Provider) =>
    provider === 'openrouter' ? fetchEmbedCatalog(await readKey(store.appRoot)) : (await listModels('embedding')).map((m) => ({ key: m.modelKey, name: m.displayName ?? m.modelKey })),
  );
  const unindexed = async () => {
    const model = embedModelFor(await store.settings());
    const jobs = (await openJobs()).filter((j) => j.status === 'done');
    const missing = model ? (await Promise.all(jobs.map(async (j) => ((await indexModel(store, j.id)) === model ? undefined : j)))).filter((j): j is Job => !!j) : [];
    return { model, total: jobs.length, missing };
  };
  ipcMain.handle('index-status', async () => {
    const { model, total, missing } = await unindexed();
    return { model, total, missing: missing.length };
  });
  ipcMain.handle('index-build', async () => {
    const { missing } = await unindexed();
    send('index-progress', { done: 0, total: missing.length });
    for (const [i, job] of missing.entries()) {
      await queue
        .exclusive(async () => {
          const emb = await embedder(await store.settings(), store.appRoot);
          if (emb) await buildIndex(store, job.id, job.name, emb);
        })
        .catch(() => undefined);
      send('index-progress', { done: i + 1, total: missing.length });
    }
  });
  ipcMain.handle('library-chat', () => store.libraryChat());
  ipcMain.handle('library-chat-ask', async (_e, question: string, model?: ChatModel, folder?: string, focus?: string[]) => {
    if (queue.busy) send('chat-progress', { jobId: LIBRARY_CHAT, step: t('chat.stepQueue') });
    return queue.exclusive(async () =>
      askLibrary(store, await store.settings(), question, model, folder, focus, {
        step: (step, tags) => send('chat-progress', { jobId: LIBRARY_CHAT, step, tags }),
        delta: (d) => send('chat-delta', { jobId: LIBRARY_CHAT, ...d }),
      }),
    );
  });
  ipcMain.handle('library-chat-clear', () => store.saveLibraryChat([]));
  ipcMain.handle('job-card', (_e, id: string) => store.card(id));
  ipcMain.handle('job-card-make', async (_e, id: string) => {
    const job = await store.job(id);
    if (!job) throw new Error(t('study.noJob'));
    const card = await queue.exclusive(async () => makeCard(store, job, await store.settings(), libraryChanged));
    send('job-update', job);
    return card;
  });
  ipcMain.handle('job-card-save', async (_e, id: string, card: DocumentCard) => {
    await store.saveCard(id, { ...card, edited: true });
    send('library-changed');
  });
  ipcMain.handle('library-state', async () => {
    const jobs = await store.jobs();
    const cards = await Promise.all(jobs.map((j) => store.card(j.id)));
    return { library: await store.library(), cards: Object.fromEntries(jobs.flatMap((j, i) => (cards[i] ? [[j.id, cards[i]]] : []))) };
  });
  // Změna knihovny: načíst, upravit, uložit a dát vědět oknu.
  /**
   * Úprava knihovny. Když změna vyžaduje šifrování či dešifrování dokumentů (zamčená složka, přesun do ní / z ní),
   * musí být trezor odemčený – to se ověří nanečisto ještě před uložením.
   */
  const editLibrary = async <T>(change: (library: Library) => T): Promise<T> => {
    const preview = structuredClone(await store.library());
    change(preview);
    if (!store.unlocked && (await lockTransitions(store, preview)).length) throw new Error(t('vault.unlockFirst'));
    const result = await store.updateLibrary(change);
    if (store.unlocked) await syncLocks(store, await store.library());
    send('library-changed');
    return result;
  };
  ipcMain.handle('vault-status', () => vault.status());
  ipcMain.handle('vault-create', async (_e, password: string) => {
    if (!passwordOk(password)) throw new Error(t('vault.short'));
    await vault.create(password);
  });
  ipcMain.handle('vault-unlock', async (_e, password: string) => {
    try {
      await vault.unlock(password);
    } catch (e) {
      throw new Error(e instanceof WrongPasswordError ? t('vault.wrong') : (e as Error).message);
    }
    void refreshHashes();
  });
  ipcMain.handle('vault-lock', () => vault.lock());
  ipcMain.handle('vault-change', async (_e, oldPassword: string, newPassword: string) => {
    if (!passwordOk(newPassword)) throw new Error(t('vault.short'));
    try {
      await vault.changePassword(oldPassword, newPassword);
    } catch (e) {
      throw new Error(e instanceof WrongPasswordError ? t('vault.wrong') : (e as Error).message);
    }
  });
  ipcMain.handle('vault-ping', () => vault.touch());
  /** Zamknout složku (zašifruje ji i podsložky) / zrušit zámek natrvalo (dešifruje). */
  ipcMain.handle('library-folder-lock', async (_e, id: string, locked: boolean) => {
    if (!store.unlocked) throw new Error(t('vault.unlockFirst'));
    await editLibrary((library) => {
      const folder = library.folders.find((f) => f.id === id);
      if (!folder) return;
      if (locked) folder.locked = true;
      else delete folder.locked;
    });
  });
  ipcMain.handle('library-folder-create', (_e, name: string, parent?: string): Promise<LibraryFolder> =>
    editLibrary((library) => {
      const folder: LibraryFolder = { id: randomUUID(), name: name.trim(), createdAt: Date.now() };
      if (parent && library.folders.some((f) => f.id === parent)) folder.parent = parent;
      library.folders.push(folder);
      return folder;
    }),
  );
  ipcMain.handle('library-folder-move', (_e, id: string, parent: string | null) =>
    editLibrary((library) => {
      if (!moveFolder(library, id, parent)) throw new Error(t('library.moveInvalid'));
    }),
  );
  ipcMain.handle('library-folder-rename', (_e, id: string, name: string) =>
    editLibrary((library) => {
      const folder = library.folders.find((f) => f.id === id);
      if (folder && name.trim()) folder.name = name.trim();
    }),
  );
  ipcMain.handle('library-folder-delete', (_e, id: string) => editLibrary((library) => removeFolder(library, id)));
  ipcMain.handle('library-move', (_e, jobIds: string[], folderId: string | null) => editLibrary((library) => moveDocs(library, jobIds, folderId)));
  ipcMain.handle('invoices-paid', (_e, ids: string[], paid: boolean) =>
    editLibrary((library) => {
      const map = (library.paid ??= {});
      for (const id of ids) {
        if (paid) map[id] ??= Date.now();
        else delete map[id];
      }
      if (!Object.keys(map).length) delete library.paid;
    }),
  );
  ipcMain.handle('invoices-export', async (_e, ids: string[], format: 'xlsx' | 'csv') => {
    const library = await store.library();
    const jobs = (store.unlocked ? await store.jobs() : await openJobs()).filter((j) => ids.includes(j.id));
    const cards = Object.fromEntries(await Promise.all(jobs.map(async (j) => [j.id, await store.card(j.id)] as const)));
    const today = isoDay();
    const rows = invoiceRows(jobs, cards, library.paid, today);
    const order = new Map(ids.map((id, i) => [id, i]));
    rows.sort((a, b) => order.get(a.jobId)! - order.get(b.jobId)!);
    const table = exportTable(
      rows,
      (key) => t(`inv.col.${key}` as MessageKey),
      (s) => t(`inv.status.${s}` as MessageKey),
    );
    const res = await dialog.showSaveDialog(win!, {
      defaultPath: path.join(app.getPath('documents'), `${t('inv.fileName')}-${today}.${format}`),
      filters: format === 'xlsx' ? [{ name: 'Excel', extensions: ['xlsx'] }] : [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (res.canceled || !res.filePath) return null;
    await writeFile(res.filePath, format === 'xlsx' ? buildXlsx(t('inv.title'), table.headers, table.rows) : toCsv(table.headers, table.rows));
    return res.filePath;
  });
  ipcMain.handle('library-make-cards', async () => {
    const todo: Job[] = [];
    for (const job of await openJobs()) if (job.status === 'done' && !(await store.card(job.id))) todo.push(job);
    send('library-progress', { done: 0, total: todo.length });
    for (const [i, job] of todo.entries()) {
      // Chyba jednoho dokumentu (prázdný text, model neodpověděl) ostatní nezastaví.
      await queue.exclusive(async () => makeCard(store, job, await store.settings(), libraryChanged)).catch(() => undefined);
      send('library-progress', { done: i + 1, total: todo.length });
    }
    send('library-changed');
  });
  ipcMain.handle('library-fill-facts', async () => {
    const todo: Job[] = [];
    for (const job of await openJobs()) {
      const card = job.status === 'done' ? await store.card(job.id) : undefined;
      if (card && (card.type === 'invoice' || card.type === 'contract') && !card.edited && !card.facts) todo.push(job);
    }
    send('library-progress', { done: 0, total: todo.length });
    for (const [i, job] of todo.entries()) {
      const card = await queue.exclusive(async () => makeCard(store, job, await store.settings(), libraryChanged)).catch(() => undefined);
      // Model nic nenašel: prázdná fakta = už zkoušeno, banner je znovu nenabídne.
      if (card && !card.facts) await store.saveCard(job.id, { ...card, facts: {} });
      send('library-progress', { done: i + 1, total: todo.length });
    }
    send('library-changed');
  });
  ipcMain.handle('job-delete', async (_e, id: string) => {
    await queue.trash(id);
    send('job-removed', id);
    send('trash-changed');
  });
  ipcMain.handle('trash-list', () => store.jobs(true));
  ipcMain.handle('trash-restore', async (_e, ids: string[]) => {
    for (const id of ids) {
      const job = await queue.restore(id);
      if (job) send('job-update', job);
    }
    send('trash-changed');
    send('library-changed');
  });
  const purge = async (ids: string[]) => {
    for (const id of ids) await queue.remove(id);
    send('trash-changed');
    send('library-changed');
  };
  ipcMain.handle('trash-purge', (_e, ids: string[]) => purge(ids));
  ipcMain.handle('trash-empty', async () => purge((await store.jobs(true)).map((j) => j.id)));
  ipcMain.handle('job-open', async (_e, id: string, kind?: OutputKind) => {
    const job = await store.job(id);
    const name = job && outputName(job, kind);
    if (!job || !name) return;
    // Zamčený dokument: jiná aplikace dostane dočasnou nešifrovanou kopii (smaže se při zamčení trezoru).
    const file = (await store.isLockedJob(id)) ? await tempCopy(name, await store.readJobFile(id, name)) : jobFile(job, kind)!;
    await shell.openPath(file);
  });
  ipcMain.handle('job-reveal', async (_e, id: string) => {
    if (await store.isLockedJob(id)) throw new Error(t('vault.noReveal'));
    const job = await store.job(id);
    const file = job && jobFile(job);
    if (file) shell.showItemInFolder(file);
  });
  ipcMain.handle('job-save-as', async (_e, id: string) => {
    const job = await store.job(id);
    const file = job && jobFile(job);
    if (!file) return;
    const pdf = jobFile(job, 'pdf');
    const res = await dialog.showSaveDialog(win!, {
      defaultPath: path.join(app.getPath('documents'), job.output!),
      filters: [{ name: 'Word', extensions: ['docx'] }, ...(pdf ? [{ name: 'PDF', extensions: ['pdf'] }] : [])],
    });
    if (res.canceled || !res.filePath) return;
    // Typ se pozná podle přípony, kterou dialog doplní podle zvoleného filtru; zamčený dokument se uloží dešifrovaný.
    const name = pdf && path.extname(res.filePath).toLowerCase() === '.pdf' ? job.outputPdf! : job.output!;
    await writeFile(res.filePath, await store.readJobFile(id, name));
  });
  // Word z knihovny: překlad = hotový výstup, originál = výstup (nepřeložený dokument) nebo Word sestavený ze zdrojového textu.
  ipcMain.handle('job-save-word', async (_e, id: string, which: 'original' | 'translation') => {
    const job = await store.job(id);
    if (!job?.output) return null;
    const segments = await store.segments(id);
    const rebuild = which === 'original' && isTranslated(job, segments);
    const base = path.parse(job.output).name;
    const res = await dialog.showSaveDialog(win!, {
      defaultPath: path.join(app.getPath('documents'), rebuild ? `${base} (${t('detail.word.originalSuffix')}).docx` : job.output),
      filters: [{ name: 'Word', extensions: ['docx'] }],
    });
    if (res.canceled || !res.filePath) return null;
    // Zamčený dokument se čte dešifrovaný jen v paměti a zapíše se až na zvolené místo.
    const data = rebuild
      ? // Originál celý, i odstavce nevybrané k překladu.
        await buildDocx(job.name, segments.map((s) => ({ ...s, skipped: false })), await loadFigures((file) => store.readJobFile(id, file), segments), originalText)
      : await store.readJobFile(id, job.output);
    await writeFile(res.filePath, data);
    return res.filePath;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => {
    quitting = true;
    // Dočasné nešifrované kopie zamčených dokumentů nesmí přežít aplikaci.
    void vault?.lock();
    void wipeTempCopies();
  });
  app.on('activate', showWindow);
  app.on('window-all-closed', () => {
    if (!isMac && !queue?.busy) app.quit();
  });
  app.whenReady().then(async () => {
    app.setName('TransLatte');
    if (isMac) app.dock?.setIcon(path.join(__dirname, 'icon.png'));
    // Starší verze měla vše přímo v userData: převezme se do první knihovny.
    libs = await loadLibraries(appRoot);
    openLibrary(libs.current);
    const settings = await store.settings();
    setLang(resolveLang(settings.uiLang, app.getLocale()));
    setMenu();
    registerIpc();
    // Uspání nebo zamčení obrazovky zamkne i trezor.
    powerMonitor.on('suspend', () => void vault.lock());
    powerMonitor.on('lock-screen', () => void vault.lock());
    await startLibrary();
    applyTheme(settings.theme);
    createWindow();
    createTray();
  });
}
