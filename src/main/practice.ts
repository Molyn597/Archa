import { randomUUID } from 'node:crypto';
import { docTitle } from '../shared/doc-title';
import { folderName, isLocked } from '../shared/folders';
import { t } from '../shared/i18n';
import { isoDay } from '../shared/invoices';
import { englishName } from '../shared/languages';
import { dueCount, dueItems, grade, shuffleOptions } from '../shared/practice';
import { isOnline } from '../shared/provider';
import type { DocumentCard, Job, Library, PracticeCard, PracticeDue, PracticeQuestion, PracticeSet, PracticeState, Project, Segment, Settings } from '../shared/types';
import { cardSample } from './card';
import { readKey } from './keystore';
import { libraryDocs } from './library-docs';
import { ask, connect, loadModel, type Llm } from './pipeline';
import { extractJsonObject } from './review';
import type { Store } from './store';

/** Nejvýš tolik zdrojů jde do jedné sady (nejnovější). */
export const MAX_SOURCES = 10;
// Celkový rozpočet textu zdrojů; dělí se rovným dílem.
const LIMITS = { local: 24000, online: 90000 };
const PRACTICE_TOKENS = 3500;
const EXPLAIN_TOKENS = 400;
const PASSAGE = 4000;
const MAX_CARDS = 15;
const MAX_QUESTIONS = 10;

interface ScopeDoc {
  job: Job;
  card?: DocumentCard;
}

const scopeId = (scope: string) => scope.slice(scope.indexOf(':') + 1);

/** Název rozsahu; undefined = složka nebo projekt už neexistuje, případně je složka zamčená. */
function scopeTitle(scope: string, library: Library, projects: Project[]): string | undefined {
  const id = scopeId(scope);
  if (scope.startsWith('project:')) return projects.find((p) => p.id === id)?.name;
  const f = library.folders.find((x) => x.id === id);
  return f && !isLocked(library.folders, f) ? folderName(f) : undefined;
}

/**
 * Zdroje rozsahu od nejnověji přidaného: dokumenty v podstromu složky, nebo zdroje projektu.
 * Bez zamčených, nehotových a smazaných dokumentů a bez faktur a smluv.
 */
async function scopeDocs(store: Store, scope: string): Promise<{ title: string; docs: ScopeDoc[] }> {
  const id = scopeId(scope);
  const library = await store.library();
  const project = scope.startsWith('project:') ? await store.project(id) : null;
  const title = scopeTitle(scope, library, project ? [project] : []);
  if (title === undefined) return { title: '', docs: [] };
  let jobs = await store.jobs();
  if (project) {
    const order = new Map(project.sources.map((s, i) => [s, i]));
    jobs = jobs.filter((j) => order.has(j.id)).sort((a, b) => order.get(b.id)! - order.get(a.id)!);
  }
  const docs = libraryDocs(jobs, {}, library, project ? undefined : id);
  const cards = await Promise.all(docs.map((d) => store.card(d.job.id).catch(() => null)));
  return {
    title,
    docs: docs.flatMap((d, i) => {
      const card = cards[i] ?? undefined;
      return card?.type === 'invoice' || card?.type === 'contract' ? [] : [{ job: d.job, card }];
    }),
  };
}

/** Uložená sada a zdroje rozsahu pro okno Procvičit (bez AI). */
export async function practiceState(store: Store, scope: string): Promise<PracticeState> {
  const { title, docs } = await scopeDocs(store, scope);
  const set = await store.practice(scope);
  const titles: Record<string, string> = Object.fromEntries(docs.map((d) => [d.job.id, docTitle(d.job, d.card)]));
  // Zdroj sady, který už v rozsahu není (přesunutý, smazaný), má mít u kartičky aspoň název.
  for (const id of set?.sources ?? []) {
    if (titles[id]) continue;
    const job = await store.job(id).catch(() => null);
    if (job) titles[id] = docTitle(job, await store.card(id).catch(() => null));
  }
  return { set, title, sources: docs.slice(0, MAX_SOURCES).map((d) => d.job.id), total: docs.length, titles };
}

export function practicePrompt(sources: { title: string; text: string }[], lang: string) {
  return (
    'You prepare study material for a university student from the sources below. Return JSON only, without any other text:\n' +
    '{"cards": [{"front": "...", "back": "...", "source": 1, "page": 12}], "questions": [{"question": "...", "options": ["...", "...", "...", "..."], "answer": 0, "source": 1, "page": 12}]}\n' +
    `Rules: write 12 flashcards and 8 multiple-choice questions in ${englishName(lang)}. Cover the key concepts, definitions, distinctions, causes and consequences, authors' main claims and important numbers; spread them across all sources. ` +
    'A flashcard front is a short question or term (max 15 words); back is the answer in 1–2 sentences, understandable without the source. ' +
    'Each question has exactly 4 options of similar length and style, exactly one correct (answer = its index); wrong options must be plausible but clearly wrong according to the source, never "all of the above" or "none of the above". ' +
    'Use only facts stated in the sources; do not add outside knowledge. source is the number of the source [S1], [S2]…; page is the page from the nearest preceding [p. N] marker, or omit it when there is none.\n\n' +
    'SOURCES:\n' +
    sources.map((s, i) => `[S${i + 1}] ${s.title}\n${s.text}`).join('\n\n')
  );
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
// Čísla zdroje a strany modely občas pošlou jako text („2“, „S2“, „[S2]“).
const num = (v: unknown) => (typeof v === 'string' && /^\[?S?\d+\]?$/i.test(v.trim()) ? Number(v.replace(/\D/g, '')) : v);
const positive = (v: unknown) => {
  const n = num(v);
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined;
};
const list = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]).filter((x) => x && typeof x === 'object') : []);

/** Kartičky a otázky z odpovědi modelu; nepoužitelné položky se zahodí. Nic použitelného = undefined. */
export function parsePractice(answer: string, sourceIds: string[]): Pick<PracticeSet, 'cards' | 'questions'> | undefined {
  const d = extractJsonObject(answer);
  if (!d) return undefined;
  const source = (v: unknown) => sourceIds[(positive(v) ?? 0) - 1];
  const page = (v: unknown) => {
    const p = positive(v);
    return p === undefined ? {} : { page: p };
  };
  // Bez opakování (bez ohledu na velikost písmen), zvlášť pro kartičky a otázky.
  const unseen = () => {
    const seen = new Set<string>();
    return (text: string) => !seen.has(text.toLowerCase()) && !!seen.add(text.toLowerCase());
  };

  const cards: PracticeCard[] = [];
  const fresh = unseen();
  for (const c of list(d.cards)) {
    const front = str(c.front);
    const back = str(c.back);
    const src = source(c.source);
    if (!front || !back || !src || !fresh(front) || cards.length >= MAX_CARDS) continue;
    cards.push({ id: randomUUID(), front, back, source: src, ...page(c.page) });
  }

  const questions: PracticeQuestion[] = [];
  const freshQ = unseen();
  for (const q of list(d.questions)) {
    const question = str(q.question);
    const options = Array.isArray(q.options) ? q.options.map(str) : [];
    const answerIndex = num(q.answer);
    const src = source(q.source);
    const unique = new Set(options.map((o) => o.toLowerCase())).size === options.length && options.every(Boolean);
    const valid = options.length >= 3 && options.length <= 4 && unique && typeof answerIndex === 'number' && Number.isInteger(answerIndex) && answerIndex >= 0 && answerIndex < options.length;
    if (!question || !src || !valid || !freshQ(question) || questions.length >= MAX_QUESTIONS) continue;
    questions.push({ id: randomUUID(), question, ...shuffleOptions(options, answerIndex, question), source: src, ...page(q.page) });
  }
  return cards.length || questions.length ? { cards, questions } : undefined;
}

async function llmFor(store: Store, settings: Settings): Promise<Llm> {
  if (isOnline(settings) && !(await readKey(store.appRoot))) throw new Error(t('openrouter.noKey'));
  const llm: Llm = { job: { cost: 0 } as Job, settings, signal: new AbortController().signal, endpoint: await connect(settings, store.appRoot) };
  await loadModel(llm, 'polish');
  return llm;
}

/** Vytvoří sadu kartiček a kvízu modelem „polish“ z nejvýš 10 nejnovějších zdrojů rozsahu a uloží ji (stará sada i postup zmizí). */
export async function buildPractice(store: Store, settings: Settings, scope: string): Promise<PracticeState> {
  const used = (await scopeDocs(store, scope)).docs.slice(0, MAX_SOURCES);
  const per = Math.floor(LIMITS[isOnline(settings) ? 'online' : 'local'] / Math.max(used.length, 1));
  const texts = await Promise.all(used.map(async (d) => ({ id: d.job.id, title: docTitle(d.job, d.card), text: cardSample(await store.segments(d.job.id), per, true) })));
  const sources = texts.filter((s) => s.text);
  if (!sources.length) throw new Error(t('practice.noSources'));
  const llm = await llmFor(store, settings);
  const out = await ask(llm, 'polish', [{ role: 'user', content: practicePrompt(sources, settings.targetLang) }], PRACTICE_TOKENS);
  const parsed = parsePractice(out, sources.map((s) => s.id));
  if (!parsed) throw new Error(t('practice.unreadable'));
  await store.savePractice({ scope, sources: used.map((d) => d.job.id), createdAt: Date.now(), ...parsed });
  return practiceState(store, scope);
}

let lock: Promise<unknown> = Promise.resolve();

/** Načíst, upravit a uložit sadu; změny jdou za sebou, ať se rychlé hodnocení nepřepíše. */
function updateSet(store: Store, scope: string, change: (set: PracticeSet) => void): Promise<PracticeSet> {
  const run = lock.then(async () => {
    const set = await store.practice(scope);
    if (!set) throw new Error(t('practice.missing'));
    change(set);
    await store.savePractice(set);
    return set;
  });
  lock = run.catch(() => undefined);
  return run;
}

/** Umím / neumím u kartičky nebo kvízové otázky (špatná odpověď = neumím). */
export const gradePractice = (store: Store, scope: string, itemId: string, known: boolean, today = isoDay()) =>
  updateSet(store, scope, (set) => {
    const item = [...set.cards, ...set.questions].find((i) => i.id === itemId);
    if (item) item.review = grade(item.review, known, today);
  });

/** Text zdroje kolem strany otázky (±1 strana), bez strany začátek dokumentu; nejvýš 4000 znaků. */
export function passageFor(segments: Segment[], page?: number) {
  const near = page === undefined ? [] : segments.filter((s) => s.page !== undefined && Math.abs(s.page - page) <= 1);
  return cardSample(near, PASSAGE, false) || cardSample(segments, PASSAGE, false);
}

export function explainPrompt(q: PracticeQuestion, chosen: number, passage: string, lang: string) {
  const wrong = chosen !== q.answer && q.options[chosen] !== undefined;
  return (
    `A student answered this quiz question. Explain in 2–3 sentences in ${englishName(lang)} why the correct answer is right${wrong ? ' and why their answer is wrong' : ''}, using only the source passage below. Plain text, no lists.\n` +
    `Question: ${q.question}\n` +
    `Correct answer: ${q.options[q.answer]}${wrong ? `\nStudent's answer: ${q.options[chosen]}` : ''}\n\n` +
    `SOURCE PASSAGE:\n${passage}`
  );
}

/** Vysvětlení odpovědi od AI; uložené v otázce se vrací bez modelu. */
export async function explainQuestion(store: Store, settings: Settings, scope: string, id: string, chosen: number): Promise<string> {
  const q = (await store.practice(scope))?.questions.find((x) => x.id === id);
  if (!q) throw new Error(t('practice.missing'));
  // Vysvětlení se liší podle zvolené odpovědi; uložené platí jen pro tutéž.
  if (q.explain && (q.explainFor ?? q.answer) === chosen) return q.explain;
  const passage = passageFor(await store.segments(q.source), q.page);
  const llm = await llmFor(store, settings);
  const text = (await ask(llm, 'polish', [{ role: 'user', content: explainPrompt(q, chosen, passage, settings.targetLang) }], EXPLAIN_TOKENS)).trim();
  if (!text) throw new Error(t('practice.explainFailed'));
  await updateSet(store, scope, (set) => {
    const x = set.questions.find((x) => x.id === id);
    if (x) Object.assign(x, { explain: text, explainFor: chosen });
  });
  return text;
}

/** Kartičky k zopakování dnes v knihovně; rozsahy s nejvíc kartičkami první, smazané a zamčené se vynechají. */
export async function practiceDue(store: Store, today = isoDay()): Promise<PracticeDue> {
  const [sets, library, projects] = await Promise.all([store.practiceSets(), store.library(), store.projects()]);
  const live = sets.flatMap((set) => {
    const title = scopeTitle(set.scope, library, projects);
    return title === undefined ? [] : [{ set, title }];
  });
  const scopes = live
    .map(({ set, title }) => ({ scope: set.scope, title, count: dueItems(set, today).length }))
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count);
  return { total: dueCount(live.map((l) => l.set), today), scopes };
}
