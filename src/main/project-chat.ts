import { t } from '../shared/i18n';
import { kindName } from '../shared/projects';
import { chatSettings, isOnline } from '../shared/provider';
import type { ChatMessage, ChatModel, Job, Project, Settings } from '../shared/types';
import { answer, type ChatHooks } from './chat';
import { readKey } from './keystore';
import { buildCorpus, LIMITS, pickPassages, semantic } from './library-chat';
import { libraryDocs } from './library-docs';
import { connect, loadModel, type Llm } from './pipeline';
import { projectChatSystem } from './prompts';
import { cleanCitations, formatPassages, passages } from './rag';
import type { Store } from './store';

const HISTORY = 6;
const HISTORY_CHARS = 2000;
const ASSIGNMENT_QUERY = 600;

/**
 * Odpověď jen ze zdrojů projektu (bez zamčených). Projekt má zdrojů málo, proto se hledá ve všech najednou bez výběru
 * dokumentů modelem; když dotaz (např. „napiš úvod“) nic nenajde, zkusí se hledat i podle zadání.
 */
export async function askProject(store: Store, base: Settings, project: Project, question: string, model?: ChatModel, hooks?: ChatHooks): Promise<ChatMessage> {
  const started = Date.now();
  const steps: string[] = [];
  const step = (text: string, tags?: string[]) => {
    steps.push(tags?.length ? `${text}: ${tags.join(', ')}` : text);
    hooks?.step(text, tags);
  };
  const settings = chatSettings(base, model);
  const online = isOnline(settings);
  const wanted = new Set(project.sources);
  const jobs = (await store.jobs()).filter((j) => wanted.has(j.id));
  const cards = Object.fromEntries(await Promise.all(jobs.map(async (j) => [j.id, await store.card(j.id)] as const)));
  const docs = libraryDocs(jobs, cards, await store.library());
  if (!docs.length) throw new Error(t('projectChat.empty'));
  if (online && !(await readKey(store.root))) throw new Error(t('openrouter.noKey'));
  const history = await store.projectChat(project.id);
  const llm: Llm = { job: { cost: 0 } as Job, settings, signal: new AbortController().signal, endpoint: await connect(settings, store.root) };
  const limit = LIMITS[online ? 'online' : 'local'];
  if (!online) step(t('chat.stepLoad', { model: model?.name ?? settings.models.polish }));
  await loadModel(llm, 'polish');

  step(t('projectChat.stepSources', { count: docs.length }));
  const parts = [];
  for (const doc of docs) parts.push({ doc, items: passages(await store.segments(doc.job.id)) });
  const corpus = buildCorpus(parts);
  const previous = history.filter((m) => m.role === 'user').at(-1)?.text ?? '';
  const query = `${question} ${previous}`.trim();
  const vec = await semantic(store, settings, docs, query).catch(() => undefined);
  if (vec) step(t('libraryChat.stepSemantic'));
  let found = pickPassages(corpus, query, limit.found, [], vec?.passageRank(corpus) ?? []);
  if (!found.hits && !vec && project.assignment.trim()) found = pickPassages(corpus, `${question} ${project.assignment.slice(0, ASSIGNMENT_QUERY)}`, limit.found);
  const { chosen } = found;

  const save = async (reply: ChatMessage) => {
    await store.saveProjectChat(project.id, [...history, { role: 'user', text: question, at: Date.now() }, reply]);
    return reply;
  };
  const meta = { steps, docs: docs.length, model: model?.name ?? model?.model };
  if (!chosen.length) return save({ role: 'assistant', text: t('projectChat.notFound'), sources: [], refs: [], ...meta, ms: Date.now() - started, at: Date.now() });
  step(t('libraryChat.stepFound', { n: chosen.length, docs: new Set(chosen.map((p) => corpus.refs.get(p.id)!.jobId)).size }));

  const system = projectChatSystem(kindName(project.kind), project.name, project.assignment, project.outline) + formatPassages(chosen);
  const recent = history.slice(-HISTORY).map((m) => ({ role: m.role, content: m.text.slice(0, HISTORY_CHARS) }));
  step(t('chat.stepWrite'));
  const raw = await answer(llm, [{ role: 'system' as const, content: system }, ...recent, { role: 'user' as const, content: question }], hooks);
  const { text, sources } = cleanCitations(raw, new Set(chosen.map((p) => p.id)));
  return save({ role: 'assistant', text: text || t('chat.noAnswer'), sources, refs: sources.map((n) => corpus.refs.get(n)!), found: chosen.length, ...meta, ms: Date.now() - started, at: Date.now() });
}
