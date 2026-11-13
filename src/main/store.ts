import { access, mkdir, readFile, readdir, rm, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { t } from '../shared/i18n';
import { RECOMMENDED_REMOTE_MODEL } from '../shared/provider';
import { cleanHighlights } from '../shared/highlights';
import { DEFAULT_NAME_TEMPLATE } from '../shared/name-template';
import type { SeenFiles } from '../shared/watch';
import { defaultLibrary } from './library';
import { decrypt, encrypt } from './vault';
import type { ChatMessage, DocumentCard, Highlight, Job, Library, PracticeSet, Project, Rates, RegionTranslation, Segment, Settings } from '../shared/types';

export const DEFAULT_SETTINGS: Settings = {
  uiLang: 'system',
  apiUrl: 'http://localhost:1234',
  provider: 'local',
  models: { ocr: 'unlimited-ocr', translate: 'translategemma-12b-it', polish: 'google/gemma-4-12b-qat' },
  remoteModels: { ocr: RECOMMENDED_REMOTE_MODEL, translate: RECOMMENDED_REMOTE_MODEL, polish: RECOMMENDED_REMOTE_MODEL },
  mode: 'fast',
  sourceLang: 'auto',
  targetLang: 'cs',
  notify: true,
  bell: true,
  autoCard: true,
  nameTemplate: DEFAULT_NAME_TEMPLATE,
  citation: { enabled: true, style: 'iso690' },
  unloadWhenIdle: true,
  theme: 'system',
  layoutPdf: true,
  keepFigures: true,
  rates: { ocrPerPage: 7, translatePerKChar: 25, fixPerSegment: 8 },
  remoteRates: { ocrPerPage: 6, translatePerKChar: 6, fixPerSegment: 3 },
  remoteCostFactors: {},
  currency: 'both',
  onboarded: false,
};

/** Jen známé položky sazeb; starší nastavení měla místo fixPerSegment polishPerKChar. */
const mergeRates = (base: Rates, saved?: Partial<Rates>): Rates => {
  const { ocrPerPage, translatePerKChar, fixPerSegment } = { ...base, ...saved };
  return { ocrPerPage, translatePerKChar, fixPerSegment };
};

/** Zašifrovaný soubor dokumentu: `<soubor>.tlk`; značka `.locked` v jeho složce = dokument je v zamčené složce. */
export const ENC = '.tlk';
export const LOCK_MARK = '.locked';

/** Soubor zamčeného dokumentu, ale trezor je zamčený (bez hesla nejde číst ani zapisovat). */
export class LockedError extends Error {
  constructor() {
    super(t('vault.locked'));
  }
}

const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';
const exists = (file: string) => access(file).then(() => true, () => false);

/** Soubory složky dokumentu (i v podsložkách, např. figures/), relativně, bez dočasných. */
async function listFiles(dir: string, sub = ''): Promise<string[]> {
  const entries = await readdir(path.join(dir, sub), { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const rel = path.join(sub, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else if (!e.name.endsWith('.tmp')) out.push(rel);
  }
  return out;
}

/** Nastavení, které má každá knihovna vlastní; ostatní (AI, vzhled, sazby) je společné celé aplikaci. */
export const LIBRARY_SETTINGS = ['targetLang', 'citation', 'autoCard', 'watchFolder', 'watchOn', 'nameTemplate', 'renameByTemplate', 'ownCompany'] as const;

/**
 * Úložiště jedné knihovny (`root` = userData/libraries/<id>): settings.json (jen LIBRARY_SETTINGS), library.json, library-chat.json, vault.json,
 * jobs/<id>/{job.json, segments.json, study.json, highlights.json, chat.json, card.json, vstup, výstup}, projects/<id>/{project.json, chat.json, practice.json}
 * a practice/<id složky>.json (procvičování složky).
 * Společné věci aplikace (settings.json, openrouter.key, dictionaries/) leží v `appRoot` = userData.
 */
export class Store {
  constructor(
    readonly root: string,
    readonly appRoot = root,
  ) {}

  /** Hlavní klíč odemčeného trezoru (jen v paměti). */
  private key?: Buffer;
  setKey = (key?: Buffer) => (this.key = key);
  get unlocked() {
    return !!this.key;
  }

  jobDir = (id: string) => path.join(this.root, 'jobs', id);

  /** Vazba šifry na místo souboru (dokument a název), stejná na všech systémech. */
  private aad = (file: string) => path.relative(this.root, file).split(path.sep).join('/');

  /** Obsah souboru; zašifrovaný se dešifruje v paměti (zamčený trezor = LockedError). */
  private async readBytes(file: string): Promise<Buffer> {
    try {
      const blob = await readFile(file + ENC);
      if (!this.key) throw new LockedError();
      return decrypt(this.key, blob, this.aad(file));
    } catch (e) {
      if (!missing(e)) throw e;
    }
    return readFile(file);
  }

  // Zápis přes dočasný soubor, aby pád uprostřed zápisu nezničil historii; v zamčeném dokumentu zašifrovaně.
  private async writeBytes(file: string, data: Buffer | string) {
    const dir = path.dirname(file);
    await mkdir(dir, { recursive: true });
    if (await this.inLockedJob(file)) {
      if (!this.key) throw new LockedError();
      const tmp = `${file}${ENC}.tmp`;
      await writeFile(tmp, encrypt(this.key, Buffer.from(data), this.aad(file)));
      await rename(tmp, file + ENC);
      await rm(file, { force: true });
      return;
    }
    const tmp = `${file}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  }

  /** Soubor patří dokumentu, jehož složka je označená jako zamčená. */
  private inLockedJob(file: string) {
    const rel = path.relative(path.join(this.root, 'jobs'), file).split(path.sep);
    return rel.length > 1 && !rel[0].startsWith('..') ? exists(path.join(this.root, 'jobs', rel[0], LOCK_MARK)) : Promise.resolve(false);
  }

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      return JSON.parse((await this.readBytes(file)).toString('utf8')) as T;
    } catch (e) {
      // Zamčený dokument nesmí tiše vrátit prázdná data – následný zápis by ho přepsal.
      if (e instanceof LockedError) throw e;
      return fallback;
    }
  }

  private writeJson = (file: string, data: unknown) => this.writeBytes(file, JSON.stringify(data, null, 1));

  /** Libovolný soubor dokumentu (originál, výstup, obrázek, vektory). */
  readJobFile = (id: string, name: string) => this.readBytes(path.join(this.jobDir(id), name));
  writeJobFile = (id: string, name: string, data: Buffer | string) => this.writeBytes(path.join(this.jobDir(id), name), data);
  jobFileExists = async (id: string, name: string) => {
    const file = path.join(this.jobDir(id), name);
    return (await exists(file)) || exists(file + ENC);
  };
  readInput = (job: Job) => this.readJobFile(job.id, `input${job.ext}`);

  isLockedJob = (id: string) => exists(path.join(this.jobDir(id), LOCK_MARK));

  /** Zašifruje dokument (idempotentní: dokončí i přerušené šifrování). Nejdřív značka, nešifrovaný soubor až po zápisu šifry. */
  async encryptJob(id: string) {
    if (!this.key) throw new LockedError();
    const dir = this.jobDir(id);
    await writeFile(path.join(dir, LOCK_MARK), '');
    for (const rel of await listFiles(dir)) {
      if (rel === LOCK_MARK || rel.endsWith(ENC)) continue;
      const file = path.join(dir, rel);
      const tmp = `${file}${ENC}.tmp`;
      await writeFile(tmp, encrypt(this.key, await readFile(file), this.aad(file)));
      await rename(tmp, file + ENC);
      await rm(file, { force: true });
    }
  }

  /** Dešifruje dokument natrvalo (přesun ze zamčené složky); značka zmizí až na konci. */
  async decryptJob(id: string) {
    if (!this.key) throw new LockedError();
    const dir = this.jobDir(id);
    for (const rel of await listFiles(dir)) {
      if (!rel.endsWith(ENC)) continue;
      const file = path.join(dir, rel.slice(0, -ENC.length));
      const tmp = `${file}.tmp`;
      await writeFile(tmp, decrypt(this.key, await readFile(file + ENC), this.aad(file)));
      await rename(tmp, file);
      await rm(file + ENC, { force: true });
    }
    await rm(path.join(dir, LOCK_MARK), { force: true });
  }

  /**
   * Úklid po pádu bez hesla: v zamčeném dokumentu, kde vedle šifry zůstal i nešifrovaný soubor, platí šifra
   * (zapisuje se přejmenováním, takže je vždy celá); dočasné soubory pryč. Zbylé nešifrované soubory dořeší encryptJob po odemčení.
   */
  async cleanupLocked() {
    const ids = await readdir(path.join(this.root, 'jobs')).catch(() => [] as string[]);
    for (const id of ids) {
      const dir = this.jobDir(id);
      if (!(await exists(path.join(dir, LOCK_MARK)))) continue;
      const files = await listFiles(dir);
      for (const rel of files) if (!rel.endsWith(ENC) && rel !== LOCK_MARK && files.includes(rel + ENC)) await rm(path.join(dir, rel), { force: true });
      for (const e of await readdir(dir).catch(() => [] as string[])) if (e.endsWith('.tmp')) await rm(path.join(dir, e), { force: true });
    }
  }

  /** Zamčené dokumenty, ve kterých zůstal nešifrovaný soubor (přerušené šifrování). */
  async lockedWithPlaintext(): Promise<string[]> {
    const ids = await readdir(path.join(this.root, 'jobs')).catch(() => [] as string[]);
    const out: string[] = [];
    for (const id of ids) {
      const dir = this.jobDir(id);
      if (!(await exists(path.join(dir, LOCK_MARK)))) continue;
      if ((await listFiles(dir)).some((rel) => rel !== LOCK_MARK && !rel.endsWith(ENC))) out.push(id);
    }
    return out;
  }

  private ownSettings = () => this.root !== this.appRoot;

  async settings(): Promise<Settings> {
    const global = await this.readJson<Partial<Settings>>(path.join(this.appRoot, 'settings.json'), {});
    const own = this.ownSettings() ? await this.readJson<Partial<Settings>>(path.join(this.root, 'settings.json'), {}) : {};
    const saved: Partial<Settings> = { ...global };
    // Chybějící hodnota knihovny = naposledy použitá (zůstává i ve společném souboru).
    for (const k of LIBRARY_SETTINGS) if (own[k] !== undefined) Object.assign(saved, { [k]: own[k] });
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      provider: saved.provider === 'openrouter' ? 'openrouter' : 'local',
      // Zrušené černobílé téma (a cokoli neznámého) se vrací k systémovému.
      theme: saved.theme === 'light' || saved.theme === 'dark' ? saved.theme : 'system',
      models: { ...DEFAULT_SETTINGS.models, ...saved.models },
      remoteModels: { ...DEFAULT_SETTINGS.remoteModels, ...saved.remoteModels },
      citation: { ...DEFAULT_SETTINGS.citation, ...saved.citation },
      rates: mergeRates(DEFAULT_SETTINGS.rates, saved.rates),
      remoteRates: mergeRates(DEFAULT_SETTINGS.remoteRates, saved.remoteRates),
      remoteCostFactors: { ...saved.remoteCostFactors },
      chatModels: saved.chatModels ? { ...saved.chatModels } : undefined,
      embedModels: saved.embedModels ? { ...saved.embedModels } : undefined,
    };
  }

  async saveSettings(settings: Settings) {
    await this.writeJson(path.join(this.appRoot, 'settings.json'), settings);
    if (this.ownSettings()) await this.writeJson(path.join(this.root, 'settings.json'), Object.fromEntries(LIBRARY_SETTINGS.map((k) => [k, settings[k]])));
  }

  /** Knihovna: složky a zařazení dokumentů (jen v datech aplikace, soubory se nepřesouvají). */
  async library(): Promise<Library> {
    const saved = await this.readJson<Partial<Library> | null>(path.join(this.root, 'library.json'), null);
    return saved?.folders
      ? { folders: saved.folders, assign: saved.assign ?? {}, ...(saved.questions?.length && { questions: saved.questions }), ...(saved.aiLog?.length && { aiLog: saved.aiLog }), ...(saved.recent?.length && { recent: saved.recent }), ...(saved.paid && Object.keys(saved.paid).length && { paid: saved.paid }), ...(saved.handedOver && Object.keys(saved.handedOver).length && { handedOver: saved.handedOver }), ...(saved.templateVersion && { templateVersion: saved.templateVersion }), ...(saved.rules?.length && { rules: saved.rules }), ...(saved.saved?.length && { saved: saved.saved }), ...(saved.links && Object.keys(saved.links).length && { links: saved.links }), ...(saved.rejectedLinks && Object.keys(saved.rejectedLinks).length && { rejectedLinks: saved.rejectedLinks }), ...(saved.ares && Object.keys(saved.ares).length && { ares: saved.ares }), ...(saved.compares && Object.keys(saved.compares).length && { compares: saved.compares }), ...(saved.hints && Object.keys(saved.hints).length && { hints: saved.hints }) }
      : defaultLibrary();
  }

  /** Soubory sledované složky, které už se zpracovaly (cesta → čas změny). */
  watchSeen = () => this.readJson<SeenFiles>(path.join(this.root, 'watch.json'), {});
  saveWatchSeen = (seen: SeenFiles) => this.writeJson(path.join(this.root, 'watch.json'), seen);

  saveLibrary = (library: Library) => this.writeJson(path.join(this.root, 'library.json'), library);

  private libraryLock: Promise<unknown> = Promise.resolve();

  /** Načíst, upravit a uložit knihovnu; změny jdou za sebou, ať AI a uživatel nepřepíšou jeden druhého. */
  updateLibrary<T>(change: (library: Library) => T): Promise<T> {
    const run = this.libraryLock.then(async () => {
      const library = await this.library();
      const result = change(library);
      await this.saveLibrary(library);
      return result;
    });
    this.libraryLock = run.catch(() => undefined);
    return run;
  }

  /** Úlohy od nejnovější; `trashed` = jen ty v koši, jinak bez nich. */
  async jobs(trashed = false): Promise<Job[]> {
    const dir = path.join(this.root, 'jobs');
    const ids = await readdir(dir).catch(() => [] as string[]);
    // Zamčené dokumenty se bez odemčeného trezoru nezobrazují (ani název).
    const jobs = await Promise.all(ids.map((id) => this.readJson<Job | null>(path.join(dir, id, 'job.json'), null).catch(() => null)));
    return jobs.filter((j): j is Job => j !== null && !!j.trashedAt === trashed).sort((a, b) => b.createdAt - a.createdAt);
  }

  job = (id: string) => this.readJson<Job | null>(path.join(this.jobDir(id), 'job.json'), null);
  saveJob = (job: Job) => this.writeJson(path.join(this.jobDir(job.id), 'job.json'), job);
  segments = (id: string) => this.readJson<Segment[]>(path.join(this.jobDir(id), 'segments.json'), []);
  saveSegments = (id: string, segments: Segment[]) => this.writeJson(path.join(this.jobDir(id), 'segments.json'), segments);
  regions = (id: string) => this.readJson<{ regions: RegionTranslation[] }>(path.join(this.jobDir(id), 'study.json'), { regions: [] }).then((s) => s.regions);
  saveRegions = (id: string, regions: RegionTranslation[]) => this.writeJson(path.join(this.jobDir(id), 'study.json'), { regions });
  highlights = (id: string) => this.readJson<unknown>(path.join(this.jobDir(id), 'highlights.json'), []).then(cleanHighlights);
  saveHighlights = (id: string, list: Highlight[]) => this.writeJson(path.join(this.jobDir(id), 'highlights.json'), cleanHighlights(list));
  chat = (id: string) => this.readJson<ChatMessage[]>(path.join(this.jobDir(id), 'chat.json'), []);
  saveChat = (id: string, messages: ChatMessage[]) => this.writeJson(path.join(this.jobDir(id), 'chat.json'), messages);
  libraryChat = () => this.readJson<ChatMessage[]>(path.join(this.root, 'library-chat.json'), []);
  saveLibraryChat = (messages: ChatMessage[]) => this.writeJson(path.join(this.root, 'library-chat.json'), messages);
  card = (id: string) => this.readJson<DocumentCard | null>(path.join(this.jobDir(id), 'card.json'), null);
  saveCard = (id: string, card: DocumentCard) => this.writeJson(path.join(this.jobDir(id), 'card.json'), card);
  inputPath = (job: Job) => path.join(this.jobDir(job.id), `input${job.ext}`);
  projectDir = (id: string) => path.join(this.root, 'projects', id);

  /** Projekty od naposledy upraveného. */
  async projects(): Promise<Project[]> {
    const ids = await readdir(path.join(this.root, 'projects')).catch(() => [] as string[]);
    const list = await Promise.all(ids.map((id) => this.project(id)));
    return list.filter((p): p is Project => p !== null).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  project = (id: string) => this.readJson<Project | null>(path.join(this.projectDir(id), 'project.json'), null);
  saveProject = (project: Project) => this.writeJson(path.join(this.projectDir(project.id), 'project.json'), project);
  projectChat = (id: string) => this.readJson<ChatMessage[]>(path.join(this.projectDir(id), 'chat.json'), []);
  saveProjectChat = (id: string, messages: ChatMessage[]) => this.writeJson(path.join(this.projectDir(id), 'chat.json'), messages);
  /** Procvičování: projekt ve své složce (smaže se s ním), složka knihovny v practice/. */
  private practiceFile = (scope: string) => {
    const id = path.basename(scope.slice(scope.indexOf(':') + 1));
    return scope.startsWith('project:') ? path.join(this.projectDir(id), 'practice.json') : path.join(this.root, 'practice', `${id}.json`);
  };
  practice = (scope: string) => this.readJson<PracticeSet | null>(this.practiceFile(scope), null);
  savePractice = (set: PracticeSet) => this.writeJson(this.practiceFile(set.scope), set);

  /** Všechny sady procvičování knihovny (složky i projekty). */
  async practiceSets(): Promise<PracticeSet[]> {
    const folders = (await readdir(path.join(this.root, 'practice')).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).map((f) => `folder:${f.slice(0, -5)}`);
    const projects = (await readdir(path.join(this.root, 'projects')).catch(() => [] as string[])).map((id) => `project:${id}`);
    const sets = await Promise.all([...folders, ...projects].map((scope) => this.practice(scope)));
    return sets.filter((s): s is PracticeSet => s !== null);
  }
  deleteProject = (id: string) => rm(this.projectDir(id), { recursive: true, force: true });
  deleteJob = (id: string) => rm(this.jobDir(id), { recursive: true, force: true });
}
