import type { Gap, OpenAlexWork } from './openalex';
import type { DiffSection } from './contract-diff';
import type { Deadline } from './deadlines';
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
  /** Údaje faktury byly přečtené přesně z přílohy ISDOC (ne odhadem modelu). */
  factsFrom?: 'isdoc';
  /** Rizika smlouvy z kontroly modelem; undefined = ještě nekontrolováno, [] = nic neobvyklého nenalezeno. */
  risks?: ContractRisk[];
}
export type RiskSeverity = 'high' | 'medium' | 'low';

/** Neobvyklé nebo nevýhodné ujednání ve smlouvě; `quote` je doslovná citace z dokumentu. */
export interface ContractRisk {
  severity: RiskSeverity;
  title: string;
  quote: string;
  why: string;
  tip?: string;
}
/** Strukturované údaje faktury / smlouvy; jen to, co v dokumentu doslova stojí. Data jako RRRR-MM-DD. */
export interface DocFacts {
  /** Za co (předmět faktury / smlouvy), např. „nájem bytu“. */
  subject?: string;
  /** Dodavatel / vystavitel faktury. */
  supplier?: string;
  /** Odběratel / příjemce faktury. */
  customer?: string;
  /** Celkem k úhradě i s měnou, např. „12 500 Kč“. */
  amount?: string;
  issued?: string;
  due?: string;
  /** Faktura: číslo faktury, variabilní symbol. */
  number?: string;
  vs?: string;
  /** IČO a DIČ dodavatele / odběratele. */
  supplierId?: string;
  supplierVat?: string;
  customerId?: string;
  customerVat?: string;
  /** Základ daně a DPH i s měnou. */
  net?: string;
  vat?: string;
  /** Smlouva: platnost od / do (RRRR-MM-DD), automatické prodloužení, sankce, rozhodné právo. */
  validFrom?: string;
  validTo?: string;
  autoRenewal?: string;
  penalty?: string;
  law?: string;
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
  /** Naposledy otevřené dokumenty (nejnovější první), pro Přehled. */
  recent?: string[];
  /** Zaplacené faktury: id dokumentu → čas označení. */
  paid?: Record<string, number>;
  /** Verze šablon složek, podle které byla knihovna naposledy upravena (viz `alignToTemplate`). */
  templateVersion?: number;
  /** Trvale skryté nabídky (např. přesun článků do Studia: uživatel zvolil Nechat). */
  hints?: { studyKept?: boolean };
  /** Pravidla naučená z ručních oprav zařazení (nejnovější první, nejvýš ~50); jdou jako příklady do promptu zařazování. */
  rules?: FolderRule[];
  /** Uložená hledání ve filtru Dokumentů (nejnovější první). */
  saved?: SavedSearch[];
  /** Potvrzené vazby mezi dokumenty (obousměrně): id → související id. */
  links?: Record<string, string[]>;
  /** Odmítnuté návrhy souvisejících dokumentů (obousměrně), znovu se nenabízejí. */
  rejectedLinks?: Record<string, string[]>;
  /** Ověření v ARES podle IČO (poslední výsledek s datem). */
  ares?: Record<string, AresEntry>;
  /** Shrnutí změn mezi verzemi smlouvy od AI; klíč = seřazená dvojice id „a|b“. */
  compares?: Record<string, CompareCache>;
}
/** Změna mezi verzemi smlouvy ve shrnutí od AI. */
export interface ChangeItem {
  title: string;
  before: string;
  after: string;
  impact: string;
}
export interface ChangeSummary {
  summary: string;
  changes: ChangeItem[];
}
/** Uložené shrnutí; platí jen pro stejný směr (`from` = starší verze) a stejné verze dokumentů (`stamp`). */
export interface CompareCache {
  from: string;
  stamp: string;
  summary: ChangeSummary;
}
/** Porovnání dvou verzí smlouvy: A vlevo (starší), B vpravo; `summary` = uložené shrnutí AI, je-li. */
export interface CompareResult {
  a: { job: Job; card: DocumentCard | null };
  b: { job: Job; card: DocumentCard | null };
  sections: DiffSection[];
  summary?: ChangeSummary;
}
/** Údaje o subjektu z ARES. */
export interface AresRecord {
  ico: string;
  name: string;
  /** Celá textová adresa sídla. */
  address: string;
  city: string;
  zip: string;
  vat?: string;
}
/** Výsledek dotazu do ARES; `record: null` = IČO v ARES není. */
export interface AresEntry {
  /** RRRR-MM-DD. */
  date: string;
  record: AresRecord | null;
}
/** Dokument související s otevřeným: potvrzený, nebo návrh k potvrzení. */
export interface RelatedDoc {
  id: string;
  title: string;
  type?: DocType;
  /** Návrh: stejná protistrana (jméno) nebo podobný obsah. */
  reason?: { kind: 'party'; party: string } | { kind: 'similar' };
}
/** Souvislosti dokumentu pro informační sloupec detailu. */
export interface DocLinks {
  suggestions: RelatedDoc[];
  linked: RelatedDoc[];
  /** Termíny jen tohoto dokumentu (splatnost, konec smlouvy, výpovědní lhůta). */
  deadlines: Deadline[];
  /** Projekty (zakázky, práce), kde je dokument zdrojem. */
  projects: { id: string; name: string }[];
  /** Složka knihovny, ve které dokument leží (bez zařazení = Odkladiště). */
  folder?: { id: string; path: string };
}
/** Uložené hledání: dotaz a případně složka, ve které se hledalo. */
export interface SavedSearch {
  name: string;
  query: string;
  /** Výběr ve stromu Dokumentů (id složky nebo zvláštní položky), bez hodnoty = všude. */
  folder?: string;
}
/** „Dokumenty tohoto dodavatele (nebo s tímto slovem) patří do této cesty.“ */
export interface FolderRule {
  by: 'party' | 'keyword';
  match: string;
  path: string;
  at: number;
}
/** Typ knihovny: určuje šablonu složek nové knihovny; `general` = převzatá data ze starší verze. */
export type LibraryKind = 'work' | 'study' | 'personal' | 'general';
/** Oddělená knihovna (vlastní data, trezor a část nastavení) v userData/libraries/<id>. */
export interface LibraryInfo {
  id: string;
  /** Vlastní název; bez hodnoty = přeložený název typu. */
  name?: string;
  kind: LibraryKind;
  createdAt: number;
}
/** Seznam knihoven (userData/libraries.json). */
export interface Libraries {
  current: string;
  list: LibraryInfo[];
  /** Uživatel už prošel výběrem knihoven (první spuštění nebo převzetí starších dat). */
  setupDone?: boolean;
}
/** Volby přesunu dokumentů do jiné knihovny. */
export interface MoveOptions {
  /** V cíli vytvoří (nebo použije) stejné složky jako ve zdroji; ve zdroji pak odstraní složky, které přesunem osiřely. */
  keepFolders?: boolean;
  /** Přesouvaná složka: cesta v cíli začíná jí (nadřazené se nezakládají) a ve zdroji se odstraní, pokud je prázdná. */
  fromFolder?: string;
  /** Projekty, které se přesunou do cíle (celé, i s chatem); jejich zdroje musí být mezi přesouvanými dokumenty. */
  projectIds?: string[];
  /** Návrh složek v cíli (název nebo cesta; první existující vyhraje). Bez nich se použije návrh z karty dokumentu. */
  folders?: string[];
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
/** Stav opakování (Leitner): přihrádka 0–5 a den, kdy se má položka znovu ukázat (RRRR-MM-DD). */
export interface Review {
  box: number;
  due: string;
}
/** Kartička k procvičení; `source` = id dokumentu, `page` = strana ve zdroji. */
export interface PracticeCard {
  id: string;
  front: string;
  back: string;
  source: string;
  page?: number;
  review?: Review;
}
/** Kvízová otázka s jednou správnou možností (`answer` = index); `explain` = uložené vysvětlení od AI k odpovědi `explainFor`. */
export interface PracticeQuestion {
  id: string;
  question: string;
  options: string[];
  answer: number;
  source: string;
  page?: number;
  explain?: string;
  explainFor?: number;
  review?: Review;
}
/** Kartičky a kvíz pro složku nebo projekt (`scope` = 'folder:<id>' | 'project:<id>'); `sources` = dokumenty, ze kterých vznikly. */
export interface PracticeSet {
  scope: string;
  sources: string[];
  createdAt: number;
  cards: PracticeCard[];
  questions: PracticeQuestion[];
}
/** Procvičování pro okno: uložená sada (nebo null), název rozsahu, dostupné zdroje a jejich názvy. */
export interface PracticeState {
  set: PracticeSet | null;
  title: string;
  /** Zdroje, ze kterých by se sada vytvořila teď (nejvýš 10). */
  sources: string[];
  /** Kolik zdrojů je v rozsahu celkem (víc než 10 = použije se 10 nejnovějších). */
  total: number;
  /** Názvy dokumentů sady i aktuálních zdrojů (id → název). */
  titles: Record<string, string>;
}
/** Kolik kartiček je dnes k zopakování, celkem a po rozsazích. */
export interface PracticeDue {
  total: number;
  scopes: { scope: string; title: string; count: number }[];
}
/** Návrh roztřídění: cesty složek s dokumenty a dotazy u nejistých dokumentů. */
export interface OrganizePlan {
  folders: { path: string; jobIds: string[] }[];
  questions: FolderQuestion[];
}
/** Druh projektu; určuje šablonu osnovy a popisky (literatura × podklady). */
export type ProjectKind = 'seminar' | 'bachelor' | 'master' | 'dissertation' | 'work' | 'other';
/** Projekt (práce, zakázka…): vybrané dokumenty knihovny napříč složkami, zadání, osnova a poznámky. */
export interface Project {
  id: string;
  name: string;
  kind: ProjectKind;
  /** Zadání práce / zakázky (volný text). */
  assignment: string;
  /** Osnova, řádek = bod; odsazení = podbod. */
  outline: string;
  notes: string;
  /** Dokumenty (id úloh) v pořadí přidání; soubory se nekopírují. */
  sources: string[];
  style: CitationStyle;
  /** Jazyk citací seznamu literatury (české „a kol.“, „s.“ × anglické „et al.“, „p.“); bez hodnoty podle jazyka aplikace. */
  citeLang?: 'cs' | 'en';
  /** Termín odevzdání RRRR-MM-DD. */
  deadline?: string;
  createdAt: number;
  updatedAt: number;
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
  /** Z `JobOptions.translate`: `false` = bez překladu. */
  translate?: boolean;
  /** Údaje z OpenAlex (`JobOptions.biblioHint`) pro kartu. */
  biblioHint?: Biblio;
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
  /** `false` = soubor se jen přečte, popíše a zařadí; text se přenese bez překladu (cílový jazyk = rozpoznaný zdrojový). */
  translate?: boolean;
  /** Údaje z OpenAlex: doplní prázdná pole karty, až vznikne. */
  biblioHint?: Biblio;
}

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';
/** Zvýraznění textu v dokumentu s volitelnou poznámkou (highlights.json ve složce úlohy; u zamčeného šifrovaně). */
export interface Highlight {
  id: string;
  /** Originál nebo překlad. */
  side: 'source' | 'target';
  /** První a poslední segment výběru. */
  from: number;
  to: number;
  /** Označený text; podle něj se zvýraznění v segmentech dohledá (pozice se mezi zobrazeními liší). */
  quote: string;
  /** Začátek výběru v textu prvního segmentu (znaky bez mezer) – rozliší opakovaný citát. */
  hint: number;
  page?: number;
  color: HighlightColor;
  note?: string;
  createdAt: number;
  updatedAt: number;
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

/** Moje firma (název, IČO, DIČ); stačí vyplnit jedno. */
export interface OwnCompany {
  name: string;
  id: string;
  vat: string;
}

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
  /** Tečka a seznam novinek pod zvonkem v horní liště. */
  bell: boolean;
  /** Po dokončení překladu vytvořit kartu dokumentu (shrnutí, klíčová slova, bibliografie). */
  autoCard: boolean;
  /** Sledovaná složka na disku: nové soubory se samy přečtou a padnou do Odkladiště. */
  watchFolder?: string;
  watchOn?: boolean;
  /** Šablona názvu dokumentu z karty (`{datum} {dodavatel} {typ} {cislo}`) a zda se používá. */
  nameTemplate: string;
  renameByTemplate?: boolean;
  /** Moje firma: podle ní se u faktur pozná příjem (jsem dodavatel) a výdaj. */
  ownCompany?: OwnCompany;
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
  /** Kurzy ČNB k datu: „RRRR-MM-DD|EUR“ → kurz za 1 jednotku. */
  fxRates?: Record<string, number>;
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

export type OutputKind = 'docx' | 'pdf' | 'input';

export interface JobDetail {
  job: Job;
  segments: Segment[];
}

export interface Api {
  platform: string;
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
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
  /** Kurz ČNB k datu (RRRR-MM-DD) pro měnu (např. EUR) v Kč za 1 jednotku; bez internetu nebo bez měny undefined. */
  fxRate(code: string, date: string): Promise<number | undefined>;
  /** Ověření IČO v ARES; `refresh` = zeptat se online (odejde jen IČO), jinak jen uložený výsledek. */
  aresLookup(ico: string, refresh: boolean): Promise<AresEntry | undefined>;
  /** Související dokumenty (potvrzené a návrhy podle vektorů a protistrany), termíny a projekty dokumentu. */
  /** Hledání v OpenAlex; odchází jen hledaný text. */
  openalexSearch(q: string): Promise<OpenAlexWork[]>;
  /** Stáhne volně dostupné PDF do Odkladiště (bez zpracování modelem); s `projectId` i do zdrojů projektu. Vrací id úlohy. */
  openalexAdd(work: OpenAlexWork, projectId?: string): Promise<string>;
  /** Dohledá dokument v OpenAlex (DOI, jinak název) a vrátí, co v kartě chybí; nenalezeno = undefined. */
  openalexLookup(id: string): Promise<{ work: OpenAlexWork; gaps: Gap[] } | undefined>;
  /** Otevře v prohlížeči https odkaz z výsledků OpenAlex. */
  openWeb(url: string): Promise<void>;
  docLinks(id: string): Promise<DocLinks>;
  /** Potvrdí (`true`), nebo odmítne či zruší (`false`) vazbu mezi dokumenty. */
  linkDocs(id: string, other: string, linked: boolean): Promise<void>;
  /** Velikost původního souboru dokumentu v bajtech. */
  jobFileSize(id: string): Promise<number | undefined>;
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
  /** Výběr složky; vrací všechny podporované soubory v ní i v podsložkách (prázdné při zrušení). */
  pickFolder(): Promise<string[]>;
  /** Výběr jedné složky na disku (null = zrušeno). */
  pickDirectory(): Promise<string | null>;
  pathForFile(file: File): string;
  addJobs(paths: string[], options: JobOptions): Promise<string[]>;
  listJobs(): Promise<Job[]>;
  getJob(id: string): Promise<JobDetail | null>;
  readInput(id: string): Promise<Uint8Array | null>;
  /** Výřez tabulky/grafu z originálu jako data URL. */
  jobFigure(id: string, file: string): Promise<string>;
  readOutputPdf(id: string): Promise<Uint8Array | null>;
  cancelJob(id: string): Promise<void>;
  retryJob(id: string, mode: Mode, targetLang?: string): Promise<void>;
  /** Přeloží existující dokument na místě (stejná úloha, složka a karta). */
  translateJob(id: string, mode: Mode, targetLang: string): Promise<void>;
  relayoutJob(id: string): Promise<void>;
  /** Přeloží vybrané segmenty (id) úlohy čekající na výběr nebo hotové; ostatní nepřeložené se přeskočí. */
  translateSegments(id: string, ids: number[]): Promise<void>;
  jobRegions(id: string): Promise<RegionTranslation[]>;
  /** `replaces` = původní výřez, který se po úspěchu nahradí (a nevrátí se uložený překlad). */
  translateRegion(id: string, page: number, crop: RegionTranslation['crop'], replaces?: RegionTranslation['crop']): Promise<RegionTranslation>;
  deleteRegion(id: string, page: number, crop: RegionTranslation['crop']): Promise<void>;
  jobHighlights(id: string): Promise<Highlight[]>;
  /** Uloží celý seznam zvýraznění dokumentu. */
  saveHighlights(id: string, list: Highlight[]): Promise<void>;
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
  /** Znovu zkontroluje rizika smlouvy modelem a uloží je do karty. */
  checkRisks(id: string): Promise<DocumentCard>;
  /** Uložená sada kartiček a kvízu pro rozsah (bez AI). */
  practiceSet(scope: string): Promise<PracticeState>;
  /** Vytvoří (nebo znovu vytvoří) sadu modelem ze zdrojů rozsahu. */
  buildPractice(scope: string): Promise<PracticeState>;
  /** Zapíše odpověď na kartičku nebo otázku (umím / neumím) a vrátí sadu. */
  gradePractice(scope: string, itemId: string, known: boolean): Promise<PracticeSet>;
  /** Vysvětlení odpovědi kvízu od AI; uložené se vrací bez modelu. */
  explainQuestion(scope: string, id: string, chosen: number): Promise<string>;
  /** Kartičky k zopakování dnes v aktuální knihovně. */
  practiceDue(): Promise<PracticeDue>;
  /** Porovná text dvou verzí smlouvy; starší jde vlevo, `keepOrder` = nechat pořadí (Prohodit). */
  compareDocs(aId: string, bId: string, keepOrder?: boolean): Promise<CompareResult>;
  /** Shrnutí změn od AI (jen na klik); uložené se vrací bez modelu, `force` = vytvořit znovu. */
  summarizeChanges(aId: string, bId: string, force?: boolean): Promise<ChangeSummary>;
  /** Uloží ručně upravenou kartu (označí ji jako `edited`). */
  saveCard(id: string, card: DocumentCard): Promise<void>;
  /** Přesune dokument do koše (zařazení do složky zůstane pro obnovení). */
  deleteJob(id: string): Promise<void>;
  /** Projekty od naposledy upraveného. */
  listProjects(): Promise<Project[]>;
  /** Nový projekt ze šablony druhu (osnova, citační styl z nastavení). */
  createProject(name: string, kind: ProjectKind): Promise<Project>;
  /** Uloží projekt (zadání, osnova, poznámky, zdroje…); vrací uložený s novým `updatedAt`. */
  saveProject(project: Project): Promise<Project>;
  /** Smaže projekt natrvalo; dokumenty v knihovně zůstanou. */
  deleteProject(id: string): Promise<void>;
  /** Historie chatu projektu. */
  projectChat(id: string): Promise<ChatMessage[]>;
  /** Otázka nebo žádost o návrh textu jen nad zdroji projektu; odpověď s citacemi [n] → dokument a strana (`refs`). */
  askProject(id: string, question: string, model?: ChatModel): Promise<ChatMessage>;
  clearProjectChat(id: string): Promise<void>;
  /** Přidá dokumenty do projektu (bez duplicit). */
  addToProject(id: string, jobIds: string[]): Promise<Project>;
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
  /** Dokument otevřen v aplikaci (seznam naposledy otevřených na Přehledu). */
  jobOpened(id: string): Promise<void>;
  libraries(): Promise<Libraries>;
  /** Přepne knihovnu; okno se pak načte znovu. Během překladu vyhodí chybu. */
  switchLibrary(id: string): Promise<void>;
  setupLibraries(kinds: LibraryKind[], opts: { subjects?: string[]; keep?: LibraryKind }): Promise<Libraries>;
  /** Založí knihovnu se šablonou a přepne na ni. */
  createLibrary(kind: LibraryKind, name?: string, subjects?: string[], stay?: boolean): Promise<LibraryInfo>;
  renameLibrary(id: string, name: string): Promise<Libraries>;
  /** Změní typ knihovny a upraví její složky podle šablony (prázdné nepoužité výchozí pryč, chybějící doplní); dokumenty se nemění. */
  setLibraryKind(id: string, kind: LibraryKind): Promise<Libraries>;
  /** Přesune dokumenty do jiné knihovny (celé složky, ověřená kopie, pak smazání zdroje); vrací počet. Zamčené a zpracovávané odmítne. */
  moveToLibrary(jobIds: string[], targetId: string, opts?: MoveOptions): Promise<number>;
  /** Trvale skryje nabídku přesunu studijních věcí do Studia v této knihovně. */
  keepStudy(): Promise<void>;
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
  /** Odebere naučené pravidlo zařazení (id z `ruleId`). */
  removeFolderRule(id: string): Promise<void>;
  /** Uloží hledání do knihovny (stejný název přepíše) / odebere ho podle názvu. */
  saveSearch(search: SavedSearch): Promise<void>;
  removeSavedSearch(name: string): Promise<void>;
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
  /** Označí faktury jako zaplacené / nezaplacené. */
  setInvoicesPaid(ids: string[], paid: boolean): Promise<void>;
  /** Uloží faktury (aktuálně filtrované) do .xlsx nebo .csv; vrátí cestu, nebo null při zrušení dialogu. */
  exportInvoices(ids: string[], format: 'xlsx' | 'csv'): Promise<string | null>;
  onLibraryChanged(handler: () => void): void;
  onLibraryProgress(handler: (p: { done: number; total: number }) => void): void;
  openOutput(id: string, kind?: OutputKind): Promise<void>;
  revealOutput(id: string): Promise<void>;
  saveOutputAs(id: string): Promise<void>;
  /** Uloží Word přes systémový dialog; vrátí cestu, nebo null při zrušení. */
  saveWord(id: string, which: 'original' | 'translation'): Promise<string | null>;
  onJobUpdate(handler: (job: Job) => void): void;
  onJobRemoved(handler: (id: string) => void): void;
  onChatProgress(handler: (p: ChatProgress) => void): void;
  onChatDelta(handler: (d: ChatDelta) => void): void;
  /** Klik na notifikaci otevře detail úlohy. */
  onOpenJob(handler: (id: string) => void): void;
}
