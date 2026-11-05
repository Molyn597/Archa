import type { UiLangSetting } from './i18n';

export type Mode = 'fast' | 'balanced' | 'quality';
/** picking = PDF je přečtené, čeká se na výběr odstavců k překladu. */
export type JobStatus = 'queued' | 'running' | 'picking' | 'done' | 'error' | 'cancelled';
export type Stage = 'prepare' | 'extract' | 'ocr' | 'tables' | 'context' | 'translate' | 'check' | 'fix' | 'write' | 'layout';
export type SegmentKind = 'heading' | 'paragraph' | 'list' | 'table';
export type Theme = 'system' | 'light' | 'dark';
/** V jaké měně ukazovat ceny online modelů. */
export type Currency = 'both' | 'czk' | 'usd';

/** Obdélník na stránce PDF v bodech viewportu pdf.js (scale 1, počátek vlevo nahoře). */
export interface Rect {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Délka zdroje v tomto obdélníku; podle ní se překlad dělí mezi obdélníky. */
  chars?: number;
  /** Plochy s původním textem [x, y, w, h] (úseky řádků); bez nich se překryje celý obdélník. */
  cover?: [number, number, number, number][];
}

/** Odkaz v textu segmentu (z anotace Link v PDF). */
export interface SegmentLink {
  /** Bez URL je to odkaz na místo v dokumentu (jen v PDF). */
  url?: string;
  /** Text odkazu v originálu. */
  source: string;
  /** Text odkazu přeložený zvlášť; podle něj se odkaz hledá v překladu. */
  target?: string;
  /** Klikací plochy originálu, u odkazu zalomeného přes řádek víc. */
  rects: Rect[];
}

export type DocType = 'article' | 'book' | 'chapter' | 'thesis' | 'report' | 'contract' | 'invoice' | 'manual' | 'letter' | 'law' | 'web' | 'other';
export interface Author {
  family: string;
  given: string;
}
/** Bibliografické údaje pro citace; chybějící = prázdný řetězec / undefined. */
export interface Biblio {
  authors: Author[];
  title: string;
  year?: string;
  /** Časopis, sborník nebo kniha, ve které dokument vyšel. */
  container?: string;
  publisher?: string;
  place?: string;
  edition?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  url?: string;
}
export interface DocumentCard {
  /** 3–5 vět v cílovém jazyce úlohy. */
  summary: string;
  type: DocType;
  /** Nejvýš 10 klíčových slov v cílovém jazyce. */
  keywords: string[];
  /** Návrh složky knihovny jako cesta „Studium / Články / Management“; chybějící úrovně může AI založit. */
  folder?: string;
  /** AI si návrhem složky není jistá (false) – zeptá se uživatele; chybí = jistá. */
  folderSure?: boolean;
  /** Další možné složky (cesty), když si AI není jistá. */
  folderOptions?: string[];
  biblio: Biblio;
  /** Jazyk shrnutí a klíčových slov. */
  lang: string;
  createdAt: number;
  /** Uživatel kartu ručně upravil – automaticky se už nepřepisuje. */
  edited?: boolean;
  /** Údaje z faktury nebo smlouvy pro přesné odpovědi chatu s knihovnou. */
  facts?: DocFacts;
}
/** Strukturované údaje faktury / smlouvy; jen to, co v dokumentu doslova stojí. Data jako RRRR-MM-DD. */
export interface DocFacts {
  /** Za co (předmět faktury / smlouvy), např. „nájem bytu“. */
  subject?: string;
  /** Dodavatel / vystavitel faktury. */
  supplier?: string;
  /** Odběratel / příjemce faktury. */
  customer?: string;
  /** Částka i s měnou, např. „12 500 Kč“. */
  amount?: string;
  issued?: string;
  due?: string;
  /** Zúčtovací období nebo doba trvání smlouvy. */
  period?: string;
  /** Smluvní strany. */
  parties?: string[];
  /** Výpovědní lhůta. */
  notice?: string;
}

export interface LibraryFolder {
  /** Výchozí složky: jejich klíč ('contracts', 'invoices', …); vlastní: náhodné id. */
  id: string;
  /** Vlastní název; bez hodnoty u výchozí složky = přeložený název z i18n. */
  name?: string;
  createdAt: number;
  /** F5: zamčená (šifrovaná) složka; chat s knihovnou ji ani její podsložky neprohledává. */
  locked?: boolean;
  /** Nadřazená složka; bez hodnoty = nejvyšší úroveň. */
  parent?: string;
}
export interface Library {
  folders: LibraryFolder[];
  /** Zařazení dokumentu: id složky; `manual` = uživatel ho přesunul ručně a AI ho už nepřesune. */
  assign: Record<string, { folder: string; manual?: boolean }>;
  /** Dokumenty, u kterých se AI ptá, kam je zařadit. */
  questions?: FolderQuestion[];
  /** Poslední automatická zařazení AI (nejnovější první), pro přehled s Vrátit. */
  aiLog?: Placement[];
}
/** Dotaz, kam zařadit dokument; možnosti jsou cesty složek (i dosud neexistujících). */
export interface FolderQuestion {
  jobId: string;
  options: string[];
  at: number;
}
/** Automatické zařazení AI (případně se založenými složkami); jde vrátit. */
export interface Placement {
  jobId: string;
  path: string;
  /** Založené složky od nejvyšší úrovně. */
  created: string[];
  /** Složka dokumentu před zařazením (bez = nezařazeno). */
  previous?: string;
  /** Cílová složka (id). */
  folder: string;
  at: number;
  /** Uživatel zařazení vrátil. */
  undone?: boolean;
}
/** Návrh sloučení dvou složek (id); `into` zůstane. */
export interface FolderMerge {
  from: string;
  into: string;
  reason?: string;
}
/** Návrh roztřídění: cesty složek s dokumenty a dotazy u nejistých dokumentů. */
export interface OrganizePlan {
  folders: { path: string; jobIds: string[] }[];
  questions: FolderQuestion[];
}
/** Dokument v knihovně se stejným originálem jako přidávaný soubor. */
export interface DuplicateMatch {
  id: string;
  name: string;
  trashed: boolean;
}

export interface LibraryState {
  library: Library;
  cards: Record<string, DocumentCard>;
}

export interface Segment {
  id: number;
  kind: SegmentKind;
  page?: number;
  source: string;
  translation?: string;
  polished?: string;
  /** Ruční úprava uživatele (fáze 2: překladová paměť). */
  edited?: string;
  rating?: 1 | -1;
  warning?: string;
  /** Umístění v PDF pro přeložené PDF se zachovaným vzhledem. */
  rects?: Rect[];
  /** Typická výška písma v bodech. */
  fontSize?: number;
  serif?: boolean;
  bold?: boolean;
  /** Řádky originálu jsou zarovnané na střed. */
  centered?: boolean;
  /** Jen pro přeložené PDF (zvýrazněný citát opakující větu z článku); jinde se nezobrazuje. */
  layoutOnly?: boolean;
  /** Text uvnitř grafu nebo schématu: nepřekládá se, v PDF zůstane původní, ve Wordu není. */
  figure?: boolean;
  /** Nevybraný k překladu: v PDF zůstane původní, ve Wordu není. */
  skipped?: boolean;
  /** Popisek tabulky/grafu: obsah se nepřekládá, vloží se jako výřez originálu (soubor ve složce úlohy). */
  snapshot?: FigureSnapshot;
  /** Text uvnitř výřezu originálu: nepřekládá se, v PDF zůstane původní, ve Wordu je jen obrázek. */
  inSnapshot?: boolean;
  links?: SegmentLink[];
}

/** Zpráva chatu s dokumentem. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  /** Segmenty (id), ze kterých odpověď vychází; čísla citací [n] v textu. */
  sources?: number[];
  /** Odpověď z celého dokumentu (vešel se do kontextu), jinak z vyhledaných úseků. */
  whole?: boolean;
  /** Počet úseků, které model dostal (jen při hledání). */
  found?: number;
  /** Kroky, kterými odpověď vznikla, a doba v ms. */
  steps?: string[];
  ms?: number;
  /** Zobrazovaný název modelu, který odpověděl. */
  model?: string;
  at: number;
  /** Chat s knihovnou: citace [n] → dokument a segment (jen citované). */
  refs?: LibraryRef[];
  /** Chat s knihovnou: počet dokumentů, ve kterých se hledalo. */
  docs?: number;
  /** Chat s knihovnou: návrh roztřídění k potvrzení (příkaz místo otázky). */
  plan?: OrganizePlan;
}

/** Odkaz citace chatu s knihovnou. */
export interface LibraryRef {
  n: number;
  jobId: string;
  /** Segment, na který se dokument otevře. */
  segment: number;
  page?: number;
}

/** Průběh odpovědi chatu (main → renderer). */
export interface ChatProgress {
  jobId: string;
  step: string;
  tags?: string[];
}

export interface ChatDelta {
  jobId: string;
  content?: string;
  reasoning?: string;
}

/** Model zvolený pro chat s dokumentem; bez něj role polish aktivního poskytovatele. */
export interface ChatModel {
  provider: Provider;
  model: string;
  /** Zobrazovaný název (jinak id). */
  name?: string;
}

export interface FigureSnapshot {
  /** Cesta relativně ke složce úlohy, např. figures/12.png. */
  file: string;
  /** Obrázek před popiskem (graf s popiskem pod ním) nebo za ním (tabulka s popiskem nad ní). */
  position: 'before' | 'after';
  /** Velikost výřezu v bodech PDF. */
  width: number;
  height: number;
}

export interface Progress {
  stage: Stage;
  done: number;
  total: number;
  /** Odhad zbývajících sekund pro celou úlohu. */
  eta?: number;
}

export interface Job {
  id: string;
  /** V koši od (ms); po TRASH_DAYS se smaže natrvalo. */
  trashedAt?: number;
  /** SHA-256 originálu (hex) pro hlídání duplicit; u starších dokumentů se doplní dodatečně. */
  inputHash?: string;
  name: string;
  ext: string;
  mode: Mode;
  sourceLang: string;
  targetLang: string;
  status: JobStatus;
  /** Vybrané stránky PDF, např. „1-8“; prázdné = všechny. */
  pageRange?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  pages?: number;
  chars?: number;
  warnings: number;
  progress?: Progress;
  /** Název výstupního souboru ve složce úlohy. */
  output?: string;
  /** Přeložené PDF se zachovaným vzhledem ve složce úlohy. */
  outputPdf?: string;
  /** Doba jednotlivých fází v sekundách. */
  timings?: Partial<Record<Stage, number>>;
  /** Kontext dokumentu (jen režim Kvalitní). */
  context?: DocumentContext;
  /** Poznámky k celé úloze, např. přeskočená kontrola pravopisu. */
  notes?: string[];
  /** Po přečtení PDF počkat na výběr odstavců. */
  pickParagraphs?: boolean;
  /** Tabulky a grafy s popiskem ponechat jako výřez originálu. */
  keepFigures?: boolean;
  /** Další běh pokračuje z uložených segmentů a přeloží jen vybrané nepřeložené. */
  resume?: boolean;
  /** Poskytovatel modelů, který úlohu zpracoval (bez hodnoty = lokální). */
  provider?: Provider;
  /** Modely, které úlohu zpracovaly (pro zobrazení). */
  models?: Models;
  /** Cena za online modely v USD (součet za úlohu i překlady oblastí). */
  cost?: number;
  /** Odhad ceny po přečtení dokumentu (USD, s koeficientem) a bez něj pro zpřesnění koeficientu. */
  costEstimate?: number;
  costBase?: number;
}

export interface DocumentContext {
  topic: string;
  domain: string;
  author: string;
  authorGender: 'female' | 'male' | 'unknown';
  audience: string;
  /** Termíny dokumentu, `target` je v cílovém jazyce. */
  terms: GlossaryEntry[];
}

export interface JobOptions {
  mode: Mode;
  sourceLang: string;
  targetLang: string;
  pageRange?: string;
  pickParagraphs?: boolean;
  keepFigures?: boolean;
  /** Bez hodnoty = podle nastavení v okamžiku spuštění. */
  provider?: Provider;
}

/** Oblast stránky přeložená na vyžádání (study.json ve složce úlohy). */
export interface RegionTranslation {
  page: number;
  /** Výřez [x0, y0, x1, y1] v poměru ke stránce (0–1). */
  crop: [number, number, number, number];
  text: string;
  createdAt: number;
}

export interface GlossaryEntry {
  source: string;
  target: string;
}

export type Provider = 'local' | 'openrouter';

export interface Models {
  ocr: string;
  translate: string;
  polish: string;
}

/** Průměrné rychlosti pro odhad zbývajícího času (sekundy). */
export interface Rates {
  ocrPerPage: number;
  translatePerKChar: number;
  fixPerSegment: number;
}

/** Styl citací při kopírování úryvků. */
export type CitationStyle = 'iso690' | 'apa7';

export interface Settings {
  /** Jazyk rozhraní aplikace (ne překladu). */
  uiLang: UiLangSetting;
  apiUrl: string;
  provider: Provider;
  /** Modely lokálního LM Studia. */
  models: Models;
  /** Modely OpenRouter (id z jejich katalogu). */
  remoteModels: Models;
  mode: Mode;
  sourceLang: string;
  targetLang: string;
  notify: boolean;
  /** Po dokončení překladu vytvořit kartu dokumentu (shrnutí, klíčová slova, bibliografie). */
  autoCard: boolean;
  /** Kopírování úryvků a odpovědí chatu s citací. */
  citation: { enabled: boolean; style: CitationStyle };
  unloadWhenIdle: boolean;
  /** Modely chatu s dokumentem; bez hodnoty se bere role polish (automaticky). */
  chatModels?: { local?: string; remote?: string };
  /** Modely pro hledání podle významu (embeddingy); bez hodnoty se hledá jen podle slov. */
  embedModels?: { local?: string; remote?: string };
  theme: Theme;
  /** U PDF vytvořit i přeložené PDF se zachovaným vzhledem. */
  layoutPdf: boolean;
  /** Výchozí stav volby „Tabulky a grafy z originálu“ na úvodní stránce. */
  keepFigures: boolean;
  rates: Rates;
  /** Rychlosti online modelů (odhad času se u nich počítá zvlášť). */
  remoteRates: Rates;
  /** Opravné koeficienty odhadu ceny podle sady modelů (skutečná / odhadnutá cena). */
  remoteCostFactors: Record<string, number>;
  currency: Currency;
  /** Poslední kurz USD → CZK z ČNB (pro ceny i v korunách). */
  usdCzk?: { rate: number; date: string };
  /** Uvítací průvodce už proběhl (chybějící hodnota = ještě ne). */
  onboarded?: boolean;
  /** Kdy naposledy proběhla kontrola aktualizací (ms). */
  lastUpdateCheck?: number;
}

export interface UpdateAsset {
  name: string;
  url: string;
  size: number;
}

export interface UpdateCheck {
  current: string;
  /** `notes`: popis vydání (prostý text, zkrácený). */
  latest?: { version: string; url: string; notes: string };
  newer: boolean;
  /** Podařilo se zjistit nejnovější verzi. */
  ok: boolean;
}

export interface UpdateProgress {
  received: number;
  total: number;
}

/** Výsledek stažení aktualizace: `windows` = instalátor se spustil a aplikace se ukončí, `mac` = otevřen DMG, nahrazení udělá uživatel. */
export type UpdateResult = { ok: true; platform: 'windows' | 'mac' } | { ok: false; error: string; url?: string };

export interface LmStatus {
  /** Bez hodnoty = lokální. */
  provider?: Provider;
  online: boolean;
  cli: boolean;
  /** Jen OpenRouter: je uložený API klíč. */
  hasKey?: boolean;
  models: { key: string; name: string; vision: boolean; sizeBytes: number; price?: ModelPrice; context?: number }[];
  /** Jen OpenRouter: čas stažení katalogu (ms). */
  catalogAt?: number;
  missing: (keyof Models)[];
}

/** Co o souboru zjistí hlavní proces před přidáním úlohy (pro odhad ceny). */
export type FileInfo = { kind: 'pdf'; pages: number } | { kind: 'text'; chars: number } | { kind: 'docx' };

/** Cena modelu v USD za milion tokenů. */
export interface ModelPrice {
  input: number;
  output: number;
}

export type OutputKind = 'docx' | 'pdf';

export interface JobDetail {
  job: Job;
  segments: Segment[];
}

export interface Api {
  platform: string;
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  getGlossary(): Promise<GlossaryEntry[]>;
  saveGlossary(entries: GlossaryEntry[]): Promise<void>;
  lmStatus(provider?: Provider): Promise<LmStatus>;
  /** Znovu stáhne katalog OpenRouter mimo mezipaměť. */
  refreshCatalog(): Promise<void>;
  /** API klíč OpenRouter žije jen v hlavním procesu; do okna se nikdy nevrací. */
  hasApiKey(): Promise<boolean>;
  setApiKey(key: string): Promise<void>;
  clearApiKey(): Promise<void>;
  /** Rozsah souborů pro odhad ceny; nečitelný soubor se vynechá. */
  /** Ve stejném pořadí jako `paths`; nečitelný soubor = null. */
  fileInfo(paths: string[]): Promise<(FileInfo | null)[]>;
  /** Ke každému souboru dokumenty se stejným originálem (i v koši). */
  checkDuplicates(paths: string[]): Promise<DuplicateMatch[][]>;
  usdCzk(): Promise<number | undefined>;
  appVersion(): Promise<string>;
  /** `auto`: automatická kontrola, nejvýš jednou denně. */
  checkUpdate(auto?: boolean): Promise<UpdateCheck>;
  /** Stáhne instalátor nejnovější verze do Stažených a spustí ho (průběh přes onUpdateProgress). */
  downloadUpdate(): Promise<UpdateResult>;
  quitApp(): Promise<void>;
  onUpdateProgress(handler: (p: UpdateProgress) => void): void;
  /** Otevře v prohlížeči jen adresy na github.com. */
  openUrl(url: string): Promise<void>;
  pickFiles(): Promise<string[]>;
  pathForFile(file: File): string;
  addJobs(paths: string[], options: JobOptions): Promise<void>;
  listJobs(): Promise<Job[]>;
  getJob(id: string): Promise<JobDetail | null>;
  readInput(id: string): Promise<Uint8Array | null>;
  /** Výřez tabulky/grafu z originálu jako data URL. */
  jobFigure(id: string, file: string): Promise<string>;
  readOutputPdf(id: string): Promise<Uint8Array | null>;
  cancelJob(id: string): Promise<void>;
  retryJob(id: string, mode: Mode): Promise<void>;
  relayoutJob(id: string): Promise<void>;
  /** Přeloží vybrané segmenty (id) úlohy čekající na výběr nebo hotové; ostatní nepřeložené se přeskočí. */
  translateSegments(id: string, ids: number[]): Promise<void>;
  jobRegions(id: string): Promise<RegionTranslation[]>;
  /** `replaces` = původní výřez, který se po úspěchu nahradí (a nevrátí se uložený překlad). */
  translateRegion(id: string, page: number, crop: RegionTranslation['crop'], replaces?: RegionTranslation['crop']): Promise<RegionTranslation>;
  deleteRegion(id: string, page: number, crop: RegionTranslation['crop']): Promise<void>;
  jobChat(id: string): Promise<ChatMessage[]>;
  /** Odpověď na dotaz k dokumentu; otázka i odpověď se uloží do historie. */
  askDocument(id: string, question: string, model?: ChatModel): Promise<ChatMessage>;
  libraryChat(): Promise<ChatMessage[]>;
  /**
   * Dotaz na celou knihovnu (nebo jen složku `folder`); `focus` = dokumenty, na které se uživatel v Knihovně dívá
   * („toto“). Průběh chodí jako chat-progress s jobId LIBRARY_CHAT (shared/folders).
   */
  askLibrary(question: string, model?: ChatModel, folder?: string, focus?: string[]): Promise<ChatMessage>;
  clearLibraryChat(): Promise<void>;
  clearChat(id: string): Promise<void>;
  getCard(id: string): Promise<DocumentCard | null>;
  /** Vytvoří (nebo znovu vytvoří) kartu dokumentu pomocí modelu. */
  makeCard(id: string): Promise<DocumentCard>;
  /** Uloží ručně upravenou kartu (označí ji jako `edited`). */
  saveCard(id: string, card: DocumentCard): Promise<void>;
  /** Přesune dokument do koše (zařazení do složky zůstane pro obnovení). */
  deleteJob(id: string): Promise<void>;
  /** Nechá `keep`, ostatní do koše; ponechaný bez složky převezme složku odstraněného. */
  dedupe(keep: string, drop: string[]): Promise<void>;
  /** Dokumenty v koši, od naposledy smazaného. */
  trashList(): Promise<Job[]>;
  restoreJobs(ids: string[]): Promise<void>;
  /** Smaže natrvalo (soubory i data); nevratné. */
  purgeJobs(ids: string[]): Promise<void>;
  emptyTrash(): Promise<void>;
  onTrashChanged(handler: () => void): void;
  /** Trezor zamčených složek: existuje (nastavené heslo) a je odemčený. */
  vaultStatus(): Promise<{ exists: boolean; unlocked: boolean }>;
  /** Nastaví heslo trezoru (jen poprvé) a odemkne ho. */
  vaultCreate(password: string): Promise<void>;
  /** Odemkne trezor; špatné heslo = chyba. */
  vaultUnlock(password: string): Promise<void>;
  vaultLock(): Promise<void>;
  vaultChangePassword(oldPassword: string, newPassword: string): Promise<void>;
  /** Aktivita uživatele (posouvá automatické zamčení). */
  vaultPing(): Promise<void>;
  /** Zamkne složku (zašifruje ji i podsložky), `false` = zámek natrvalo zruší (dešifruje); vyžaduje odemčený trezor. */
  lockFolder(id: string, locked: boolean): Promise<void>;
  onVaultChanged(handler: () => void): void;
  libraryState(): Promise<LibraryState>;
  /** Nová složka, s `parent` jako podsložka. */
  createFolder(name: string, parent?: string): Promise<LibraryFolder>;
  /** Přesune složku pod jinou (`null` = nejvyšší úroveň); do vlastní podsložky nejde. */
  moveFolder(id: string, parent: string | null): Promise<void>;
  /** Odpověď na dotaz, kam dokument patří; `null` = nechat, jak je. Vybraná cesta se případně založí. */
  answerFolder(jobId: string, path: string | null): Promise<void>;
  /** Vrátí zařazení, při kterém AI založila složky (prázdné založené složky smaže). */
  undoPlacement(placement: Placement): Promise<void>;
  /** Návrh podsložek a zařazení pro složku (`null` = celá knihovna); nic nemění. */
  organizeFolder(folderId: string | null, model?: ChatModel): Promise<OrganizePlan>;
  /** Provede potvrzený návrh: založí složky a zařadí dokumenty (jako ruční zařazení). */
  applyPlan(plan: OrganizePlan): Promise<void>;
  /** Embedding modely poskytovatele (lokálně stažené v LM Studiu, online katalog OpenRouteru). */
  embedModels(provider: Provider): Promise<{ key: string; name: string; price?: ModelPrice }[]>;
  /** Kolik hotových dokumentů nemá index aktivního embedding modelu (`model` undefined = model není zvolený). */
  indexStatus(): Promise<{ model?: string; total: number; missing: number }>;
  /** Vytvoří chybějící indexy; průběh přes onIndexProgress. */
  buildIndexes(): Promise<void>;
  onIndexProgress(handler: (p: { done: number; total: number }) => void): void;
  /** Sloučí složku do jiné (dokumenty i podsložky); do vlastní podsložky nejde. */
  mergeFolders(from: string, into: string): Promise<void>;
  /** Návrhy sloučení podobných složek (podle názvů a modelem i synonyma); nic nemění. */
  suggestMerges(model?: ChatModel): Promise<FolderMerge[]>;
  /** AI zařadila dokument a založila přitom složky (nabídnout Vrátit). */
  onLibraryPlaced(handler: (p: Placement) => void): void;
  renameFolder(id: string, name: string): Promise<void>;
  /** Dokumenty složky přejdou mezi nezařazené, soubory zůstanou. */
  deleteFolder(id: string): Promise<void>;
  /** Ruční zařazení; `null` = mezi nezařazené. */
  moveToFolder(jobIds: string[], folderId: string | null): Promise<void>;
  /** Vytvoří karty hotovým dokumentům, které je nemají; chyby jednotlivých dokumentů neskončí celé. */
  makeMissingCards(): Promise<void>;
  /** Znovu vytvoří karty faktur a smluv, které nejsou upravené ručně a nemají fakta. */
  fillFacts(): Promise<void>;
  onLibraryChanged(handler: () => void): void;
  onLibraryProgress(handler: (p: { done: number; total: number }) => void): void;
  openOutput(id: string, kind?: OutputKind): Promise<void>;
  revealOutput(id: string): Promise<void>;
  saveOutputAs(id: string): Promise<void>;
  onJobUpdate(handler: (job: Job) => void): void;
  onJobRemoved(handler: (id: string) => void): void;
  onChatProgress(handler: (p: ChatProgress) => void): void;
  onChatDelta(handler: (d: ChatDelta) => void): void;
  /** Klik na notifikaci otevře detail úlohy. */
  onOpenJob(handler: (id: string) => void): void;
}
