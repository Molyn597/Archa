import { t } from '../shared/i18n';
import { chatSettings, isOnline } from '../shared/provider';
import { openPaths } from '../shared/folders';
import type { ChatMessage, ChatModel, Job, Library, LibraryRef, Settings } from '../shared/types';
import { answer, type ChatHooks } from './chat';
import { dot, embedder, embedModelFor, loadIndex, rrf, type VectorIndex } from './embed';
import { ensurePath, matchFolder } from './library';
import { cardText, factsText, libraryDocs, type LibDoc } from './library-docs';
import { planOrganize, planSize } from './organize';
import { readKey } from './keystore';
import { ask, connect, loadModel, type Llm } from './pipeline';
import { LIBRARY_CHAT_SYSTEM, libraryRoutePrompt } from './prompts';
import { cleanCitations, formatPassages, passages, search, selectPassages, type Passage } from './rag';
import { extractJsonObject } from './review';
import type { Store } from './store';

// Lokálně 16k tokenů: katalog karet pro výběr dokumentů a nalezené úseky se vejdou každý zvlášť.
// `line` = nejdelší řádek katalogu (dlouhá shrnutí se zkrátí).
export const LIMITS = {
  local: { catalog: 24000, found: 20000, line: 260 },
  online: { catalog: 200000, found: 60000, line: 700 },
};
export type Limits = (typeof LIMITS)['local'];
const MAX_DOCS = 8;
/** Dokumenty, které se přiberou podle shody s kartou i bez výběru modelem. */
const CARD_HITS = 3;
const HITS = 40;
const HISTORY = 4;
const HISTORY_CHARS = 1500;
const ROUTE_TOKENS = 800;
const SHOWN = 6;
const KEYWORDS_SHOWN = 12;

export { cardText, factsText, libraryDocs, type LibDoc } from './library-docs';

/**
 * Pojistka nezávislá na modelu: příkaz nebo otázka na zařazení do složek („kam bys to zařadil“, „přesuň“, „roztřiď“,
 * „vytvoř podsložky“). Samotné slovo „složka“ nestačí – „co je ve složce Faktury?“ je dotaz.
 */
const ORGANIZE_RE =
  /(za[řr]a[dď]|p[řr]esu[nň]|p[řr]esunout|rozt[řr][ií][dď]|rozd[ěe]l.*slo[žz]k|kam\s+(?:to\s+|ho\s+|ji\s+|je\s+)?pat[řr]|vytvo[řr]\w*\s+(?:n[ěe]jak[éeou]\s+)?(?:pod)?slo[žz]k|\b(?:move|sort|organi[sz]e|file)\b.*\b(?:folder|this|it|documents?)\b|where\s+(?:would|should|does)\b.*\b(?:go|belong|put|file|move)\b)/i;
export const isOrganizeRequest = (question: string) => ORGANIZE_RE.test(question);

const SIMILAR = 40;

/**
 * Vektor dotazu a indexy dokumentů pro hledání podle významu; bez embedding modelu nebo bez jediného indexu undefined.
 * `cardRank` = pořadí dokumentů podle karty, `passageRank` = nejpodobnější úseky korpusu.
 */
export async function semantic(store: Store, settings: Settings, docs: LibDoc[], query: string) {
  const model = embedModelFor(settings);
  if (!model) return undefined;
  const indexes = new Map<string, VectorIndex>();
  for (const d of docs) {
    const index = await loadIndex(store, d.job.id, model);
    if (index) indexes.set(d.job.id, index);
  }
  if (!indexes.size) return undefined;
  const emb = await embedder(settings, store.root);
  if (!emb) return undefined;
  const [q] = await emb.embed([query], 'query');
  return {
    cardRank: () =>
      docs
        .flatMap((d, i) => {
          const card = indexes.get(d.job.id)?.card;
          return card ? [{ i, s: dot(q, card) }] : [];
        })
        .sort((a, b) => b.s - a.s)
        .map((e) => e.i),
    passageRank: (corpus: Corpus) => {
      const bySeg = new Map([...indexes].map(([job, index]) => [job, new Map(index.ids.map((id, k) => [id, index.vectors[k]]))]));
      const titleIds = new Set(corpus.titles.values());
      return corpus.items
        .flatMap((p) => {
          const ref = corpus.refs.get(p.id)!;
          const v = titleIds.has(p.id) ? undefined : bySeg.get(ref.jobId)?.get(ref.segment);
          return v ? [{ p, s: dot(q, v) }] : [];
        })
        .sort((a, b) => b.s - a.s)
        .slice(0, SIMILAR)
        .map((e) => e.p);
    },
  };
}

const tree = (library: Library) => openPaths(library.folders);

const cardItems = (docs: LibDoc[]): Passage[] => docs.map((d, i) => ({ id: i, heading: false, text: '', search: cardText(d) }));

/** Indexy dokumentů, jejichž karta nejlépe odpovídá dotazu (BM25), nejlepší první. */
export const cardHits = (docs: LibDoc[], query: string, limit: number) => search(cardItems(docs), query, limit).map((p) => p.id);

/**
 * Dokumenty do katalogu pro model: všechny, když se vejdou; jinak nejdřív shody s kartou,
 * pak nejnovější, dokud nedojde limit znaků. Vrací indexy do `docs`.
 */
export function catalogDocs(docs: LibDoc[], query: string, limit: Limits): number[] {
  const order = [...new Set([...cardHits(docs, query, docs.length), ...docs.keys()])];
  const out: number[] = [];
  let chars = 0;
  for (const i of order) {
    const len = cardText(docs[i], limit.line).length + 6;
    if (chars + len > limit.catalog) break;
    out.push(i);
    chars += len;
  }
  return out;
}

export const formatCatalog = (docs: LibDoc[], shown: number[], limit: Limits) => shown.map((i, k) => `[${k + 1}] ${cardText(docs[i], limit.line)}`).join('\n');

export interface Route {
  /** Pořadí v katalogu (od 0), nejlepší první. */
  docs: number[];
  terms: string[];
  clarify: string;
  /** Příkaz roztřídit dokumenty místo otázky. */
  organize: boolean;
  /** U příkazu: cesta složky, kterou třídit („“ = celá knihovna). */
  scope: string;
}

/** Výběr modelu z JSONu; id „3“, „D3“, „[3]“ i čísla, mimo katalog se zahodí. */
export function parseRoute(text: string, count: number): Route {
  const d = extractJsonObject(text);
  if (!d) return { docs: [], terms: [], clarify: '', organize: false, scope: '' };
  const docs = (Array.isArray(d.docs) ? d.docs : [])
    .map((v) => Number(String(v).replace(/\D/g, '')) - 1)
    .filter((i) => Number.isInteger(i) && i >= 0 && i < count);
  const terms = (Array.isArray(d.terms) ? d.terms : []).filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
  const text_ = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return { docs: [...new Set(docs)], terms: [...new Set(terms)], clarify: text_(d.clarify), organize: text_(d.action).toLowerCase() === 'organize', scope: text_(d.scope) };
}

/** Úseky více dokumentů s jedním číslováním; každý dokument začíná úsekem s názvem a fakty z karty. */
export interface Corpus {
  items: Passage[];
  refs: Map<number, LibraryRef>;
  /** Úvodní úsek dokumentu podle jobId. */
  titles: Map<string, number>;
}

export function buildCorpus(parts: { doc: LibDoc; items: Passage[] }[]): Corpus {
  const items: Passage[] = [];
  const refs = new Map<number, LibraryRef>();
  const titles = new Map<string, number>();
  let n = 1;
  for (const { doc, items: own } of parts) {
    const { job, card } = doc;
    const facts = factsText(card?.facts);
    const label = [`Document: ${job.name}${job.ext}`, doc.folder && `folder: ${doc.folder}`, card && `type: ${card.type}`, facts && `facts: ${facts}`].filter(Boolean).join(' — ');
    // Nadpis zastaví hledání nejbližšího nadpisu (selectPassages) na hranici dokumentu.
    items.push({ id: n, heading: true, text: label, search: cardText(doc) });
    refs.set(n, { n, jobId: job.id, segment: own[0]?.id ?? 0, page: own[0]?.page });
    titles.set(job.id, n++);
    for (const p of own) {
      items.push({ ...p, id: n });
      refs.set(n, { n, jobId: job.id, segment: p.id, page: p.page });
      n++;
    }
  }
  return { items, refs, titles };
}

/**
 * Nejlepší úseky přes všechny dokumenty do limitu; u každého dokumentu s úsekem i jeho úvod (název, fakta).
 * `force` = dokumenty, jejichž úvod se přidá i bez zásahu (vybral je model podle karty).
 * `hits` = počet skutečných zásahů v textu (bez úvodů).
 */
export function pickPassages(corpus: Corpus, query: string, maxChars: number, force: string[] = [], similar: Passage[] = []): { chosen: Passage[]; hits: number } {
  const titleIds = new Set(corpus.titles.values());
  const words = search(corpus.items, query, HITS);
  // Hybridní pořadí: zásahy podle slov (BM25) a podle významu (embeddingy) spojené přes RRF.
  const found = similar.length ? rrf([words, similar], (p) => p.id).slice(0, HITS) : words;
  const chosen = new Map(selectPassages(corpus.items, found, maxChars).map((p) => [p.id, p]));
  // Zásah podle slov rozhoduje, zda hledat ve všech dokumentech (podle významu se „najde“ vždy něco).
  const wordIds = new Set(words.map((p) => p.id));
  const hits = [...chosen.keys()].filter((id) => !titleIds.has(id) && wordIds.has(id)).length;
  const jobs = new Set([...[...chosen.keys()].map((id) => corpus.refs.get(id)!.jobId), ...force]);
  const index = new Map(corpus.items.map((p, i) => [p.id, i]));
  for (const job of jobs) {
    const id = corpus.titles.get(job);
    if (id !== undefined && !chosen.has(id)) chosen.set(id, corpus.items[index.get(id)!]);
  }
  return { chosen: [...chosen.values()].sort((a, b) => index.get(a.id)! - index.get(b.id)!), hits };
}

/**
 * Odpověď z celé knihovny. Model nejdřív podle karet vybere dokumenty a navrhne hledací slova,
 * BM25 pak hledá v plném textu vybraných; bez zásahu se hledá ve všech. Když nic, žádost o upřesnění.
 */
export async function askLibrary(
  store: Store,
  base: Settings,
  question: string,
  model?: ChatModel,
  folder?: string,
  focus: string[] = [],
  hooks?: ChatHooks,
): Promise<ChatMessage> {
  const started = Date.now();
  const steps: string[] = [];
  const step = (text: string, tags?: string[]) => {
    steps.push(tags?.length ? `${text}: ${tags.join(', ')}` : text);
    hooks?.step(text, tags);
  };
  const settings = chatSettings(base, model);
  const online = isOnline(settings);
  const jobs = await store.jobs();
  const cards = Object.fromEntries(await Promise.all(jobs.map(async (j) => [j.id, await store.card(j.id)] as const)));
  const library = await store.library();
  const docs = libraryDocs(jobs, cards, library, folder);
  if (!docs.length) throw new Error(t('libraryChat.empty'));
  if (online && !(await readKey(store.root))) throw new Error(t('openrouter.noKey'));
  const history = await store.libraryChat();
  // Cena online dotazů se u knihovny k žádné úloze nepřičítá.
  const llm: Llm = { job: { cost: 0 } as Job, settings, signal: new AbortController().signal, endpoint: await connect(settings, store.root) };
  const limit = LIMITS[online ? 'online' : 'local'];
  if (!online) step(t('chat.stepLoad', { model: model?.name ?? settings.models.polish }));
  await loadModel(llm, 'polish');

  const previous = history.filter((m) => m.role === 'user').at(-1)?.text ?? '';
  step(t('libraryChat.stepCatalog', { count: docs.length }));
  // Dokumenty, na které se uživatel dívá („toto“), jsou v katalogu vždy a první.
  const focused = docs.flatMap((d, i) => (focus.includes(d.job.id) ? [i] : []));
  const shown = [...new Set([...focused, ...catalogDocs(docs, `${question} ${previous}`, limit)])];
  const langs = [...new Set(docs.flatMap((d) => [d.job.sourceLang, d.job.targetLang]).filter((l) => l && l !== 'auto'))];
  const routed = parseRoute(
    await ask(llm, 'polish', [{ role: 'user', content: libraryRoutePrompt(question, formatCatalog(docs, shown, limit), langs, previous, tree(library), focused.map((_, k) => k + 1)) }], ROUTE_TOKENS),
    shown.length,
  );
  const save = async (reply: ChatMessage) => {
    await store.saveLibraryChat([...history, { role: 'user', text: question, at: Date.now() }, reply]);
    return reply;
  };

  if (routed.organize || isOrganizeRequest(question)) {
    // Příkaz: návrh roztřídění k potvrzení v chatu, nic se nemění.
    // Konkrétní dokumenty („kam bys zařadil tento článek“): jen ty, cesta kdekoli ve stromu. Jinak celá složka.
    const fromRoute = routed.scope ? [] : routed.docs.map((k) => docs[shown[k]]);
    const named = fromRoute.length || routed.scope ? fromRoute : focused.map((i) => docs[i]);
    const scopeId = named.length ? undefined : (folder ?? (routed.scope ? (ensurePath(library, routed.scope, false).id ?? matchFolder(library, routed.scope)) : undefined));
    const targets = named.length ? named : scopeId === folder ? docs : libraryDocs(jobs, cards, library, scopeId);
    step(t('organize.step'));
    const plan = await planOrganize(llm, library, targets, scopeId ?? null, previous ? `${previous}\n${question}` : question);
    const size = planSize(plan);
    return save({
      role: 'assistant',
      text: size ? t('organize.proposal', { count: size }) : t('organize.nothing'),
      ...(size && { plan }),
      steps,
      docs: docs.length,
      model: model?.name ?? model?.model,
      ms: Date.now() - started,
      at: Date.now(),
    });
  }
  const routeDocs = routed.docs.map((k) => shown[k]);
  const query = `${question} ${previous} ${routed.terms.join(' ')}`;
  if (routed.terms.length) step(t('chat.stepTerms'), routed.terms.slice(0, KEYWORDS_SHOWN));
  // Hledání podle významu, když má aktivní embedding model index aspoň u jednoho dokumentu.
  const vec = await semantic(store, settings, docs, `${question} ${previous}`.trim()).catch(() => undefined);
  if (vec) step(t('libraryChat.stepSemantic'));
  const byCard = vec ? rrf([cardHits(docs, query, docs.length), vec.cardRank()], (i) => i) : cardHits(docs, query, CARD_HITS);
  const picked = [...new Set([...routeDocs, ...focused, ...byCard.slice(0, CARD_HITS)])].slice(0, MAX_DOCS);
  if (picked.length) step(t('libraryChat.stepDocs'), picked.slice(0, SHOWN).map((i) => docs[i].job.name));

  const segments = new Map<string, Passage[]>();
  const gather = async (indexes: number[]) => {
    const parts = [];
    for (const i of indexes) {
      const id = docs[i].job.id;
      if (!segments.has(id)) segments.set(id, passages(await store.segments(id)));
      parts.push({ doc: docs[i], items: segments.get(id)! });
    }
    const corpus = buildCorpus(parts);
    return { corpus, ...pickPassages(corpus, query, limit.found, routeDocs.map((i) => docs[i].job.id), vec?.passageRank(corpus) ?? []) };
  };
  let found = await gather(picked);
  let searched = picked.length;
  if (!found.hits && docs.length > picked.length) {
    step(t('libraryChat.stepAll'));
    found = await gather([...docs.keys()]);
    searched = docs.length;
  }
  const { corpus, chosen } = found;
  const meta = { steps, docs: searched, model: model?.name ?? model?.model };
  if (!chosen.length) {
    return save({ role: 'assistant', text: routed.clarify || t('libraryChat.notFound'), sources: [], refs: [], ...meta, ms: Date.now() - started, at: Date.now() });
  }
  const docCount = new Set(chosen.map((p) => corpus.refs.get(p.id)!.jobId)).size;
  step(t('libraryChat.stepFound', { n: chosen.length, docs: docCount }));

  const recent = history.slice(-HISTORY).map((m) => ({ role: m.role, content: m.text.slice(0, HISTORY_CHARS) }));
  const messages = [{ role: 'system' as const, content: LIBRARY_CHAT_SYSTEM + formatPassages(chosen) }, ...recent, { role: 'user' as const, content: question }];
  step(t('chat.stepWrite'));
  const raw = await answer(llm, messages, hooks);
  const { text, sources } = cleanCitations(raw, new Set(chosen.map((p) => p.id)));
  return save({
    role: 'assistant',
    text: text || t('chat.noAnswer'),
    sources,
    refs: sources.map((n) => corpus.refs.get(n)!),
    found: chosen.length,
    ...meta,
    ms: Date.now() - started,
    at: Date.now(),
  });
}
