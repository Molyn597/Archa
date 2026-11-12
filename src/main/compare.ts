import { changeCount, changesText, diffContracts, isNewer, type Para } from '../shared/contract-diff';
import { t } from '../shared/i18n';
import { englishName } from '../shared/languages';
import { isOnline } from '../shared/provider';
import type { ChangeItem, ChangeSummary, CompareResult, Job, Settings } from '../shared/types';
import { readKey } from './keystore';
import { ask, connect, loadModel, type Llm } from './pipeline';
import { extractJsonObject } from './review';
import type { Store } from './store';

// Lokální model má kontext 16k tokenů; 20 000 znaků změn je zhruba 6k tokenů.
const LIMITS = { local: 20000, online: 80000 };
const SUMMARY_TOKENS = 1500;
const MAX_CHANGES = 8;

/** `side` = strana, za kterou se změny posuzují (vlastní firma); bez ní ta, která smlouvu podepisuje jako zákazník. */
export function changesPrompt(changes: string, target: string, side?: string) {
  const party = side ? `the party "${side}"` : 'the party that signs this contract as customer, tenant, buyer or client';
  return (
    'You compare two versions of a contract. Below are the textual differences from the OLDER version to the NEWER one, ' +
    'grouped by article: "– old / + new" is a changed passage, "+ text" was added, "– text" was removed. Return JSON only, without any other text:\n' +
    '{"summary": "...", "changes": [{"title": "...", "before": "...", "after": "...", "impact": "..."}]}\n' +
    'Rules: summary is 1–3 sentences about what the newer version changes overall. List at most 8 changes, the most important first ' +
    '(price, duration, notice, penalties, liability, obligations); merge small edits of one clause; ignore pure wording, typo or formatting edits. ' +
    'title max 8 words; before and after are short (what the older and the newer version says, "" when the clause is new or removed); ' +
    `impact is one sentence on what the change means for ${party}. All texts in ${englishName(target)}.` +
    `\n\nCHANGES:\n${changes}`
  );
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Shrnutí změn z odpovědi modelu; nečitelná odpověď = undefined. */
export function parseChangeSummary(answer: string): ChangeSummary | undefined {
  const d = extractJsonObject(answer);
  if (!d) return undefined;
  const changes = (Array.isArray(d.changes) ? (d.changes as Record<string, unknown>[]) : [])
    .map((c): ChangeItem => ({ title: str(c?.title), before: str(c?.before), after: str(c?.after), impact: str(c?.impact) }))
    .filter((c) => c.title)
    .slice(0, MAX_CHANGES);
  const summary = str(d.summary);
  return summary || changes.length ? { summary, changes } : undefined;
}

/** Odstavce dokumentu z původního textu (bez segmentů jen pro rozvržení, obrázků a prázdných). */
async function paragraphs(store: Store, id: string): Promise<Para[]> {
  return (await store.segments(id))
    .filter((s) => !s.layoutOnly && !s.figure && s.source.trim())
    .map((s) => ({ text: s.source, seg: s.id, ...(s.kind === 'heading' && { heading: true }) }));
}

async function side(store: Store, id: string) {
  const job = await store.job(id);
  if (!job) throw new Error(t('study.noJob'));
  return { job, card: await store.card(id) };
}

const cacheKey = (a: string, b: string) => [a, b].sort().join('|');
// Uložené shrnutí platí, dokud se ani jeden dokument znovu nezpracoval.
const stamp = (a: Job, b: Job) => [a, b].sort((x, y) => x.id.localeCompare(y.id)).map((j) => j.finishedAt ?? j.createdAt).join('|');

/** Porovnání dvou verzí; starší vlevo, pokud `keepOrder` neříká jinak. Uložené shrnutí AI se přidá, sedí-li směr. */
export async function compareDocs(store: Store, aId: string, bId: string, keepOrder = false): Promise<CompareResult> {
  let [a, b] = await Promise.all([side(store, aId), side(store, bId)]);
  if (!keepOrder && isNewer({ createdAt: a.job.createdAt, card: a.card }, { createdAt: b.job.createdAt, card: b.card })) [a, b] = [b, a];
  const sections = diffContracts(await paragraphs(store, a.job.id), await paragraphs(store, b.job.id));
  const cached = (await store.library()).compares?.[cacheKey(a.job.id, b.job.id)];
  const valid = cached && cached.from === a.job.id && cached.stamp === stamp(a.job, b.job);
  return { a, b, sections, ...(valid && { summary: cached.summary }) };
}

/** Shrnutí změn modelem „polish“ (A = starší); výsledek se uloží do knihovny. Bez změn se model nevolá. */
export async function summarizeChanges(store: Store, settings: Settings, aId: string, bId: string, force = false): Promise<ChangeSummary> {
  const { a, b, sections, summary } = await compareDocs(store, aId, bId, true);
  if (summary && !force) return summary;
  if (!changeCount(sections)) return { summary: t('compare.same'), changes: [] };
  const online = isOnline(settings);
  if (online && !(await readKey(store.appRoot))) throw new Error(t('openrouter.noKey'));
  const llm: Llm = { job: b.job, settings, signal: new AbortController().signal, endpoint: await connect(settings, store.appRoot) };
  await loadModel(llm, 'polish');
  const prompt = changesPrompt(changesText(sections, LIMITS[online ? 'online' : 'local']), settings.targetLang, settings.ownCompany?.name);
  const result = parseChangeSummary(await ask(llm, 'polish', [{ role: 'user', content: prompt }], SUMMARY_TOKENS));
  if (!result) throw new Error(t('compare.failed'));
  await store.updateLibrary((library) => void ((library.compares ??= {})[cacheKey(a.job.id, b.job.id)] = { from: a.job.id, stamp: stamp(a.job, b.job), summary: result }));
  if (b.job.cost !== undefined) await store.saveJob(b.job);
  return result;
}
