import { fold, folderPath, openPaths } from '../shared/folders';
import { getLang, t } from '../shared/i18n';
import { chatSettings, isOnline } from '../shared/provider';
import type { ChatModel, Job, Library, OrganizePlan, Settings } from '../shared/types';
import { readKey } from './keystore';
import { pathParts } from './library';
import { cardText, libraryDocs, type LibDoc } from './library-docs';
import { ask, connect, loadModel, type Llm } from './pipeline';
import { organizePrompt } from './prompts';
import { extractJsonObject } from './review';
import type { Store } from './store';

// Katalog pro návrh: lokálně se vejde do 16k tokenů i s odpovědí, online výrazně víc.
const LIMITS = { local: { chars: 22000, line: 220 }, online: { chars: 160000, line: 600 } };
const PLAN_TOKENS = 2500;
const MAX_OPTIONS = 3;

export const samePath = (a: string, b: string) => fold(pathParts(a).join('/')) === fold(pathParts(b).join('/'));

/** Cesta v rozsahu `scope`: relativní cestu („Management“) doplní o rozsah. */
export function scopedPath(path: string, scope: string): string {
  const parts = pathParts(path);
  const prefix = pathParts(scope);
  if (!parts.length) return '';
  if (prefix.length && !samePath(parts.slice(0, prefix.length).join('/'), scope)) parts.unshift(...prefix);
  return parts.join(' / ');
}

/**
 * Návrh z JSONu modelu: dokumenty podle čísla v katalogu, každý nejvýš jednou, bez přesunů do složky,
 * ve které už je; stejné cesty se sloučí. Dotazy jen u dokumentů, které nejsou ve složkách.
 */
export function parsePlan(text: string, docs: LibDoc[], scope: string): OrganizePlan {
  const d = extractJsonObject(text);
  const plan: OrganizePlan = { folders: [], questions: [] };
  if (!d) return plan;
  const docOf = (v: unknown) => docs[Number(String(v).replace(/\D/g, '')) - 1];
  const used = new Set<string>();
  for (const raw of Array.isArray(d.folders) ? d.folders : []) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const path = typeof r.path === 'string' ? scopedPath(r.path, scope) : '';
    if (!path) continue;
    const jobIds = (Array.isArray(r.docs) ? r.docs : [])
      .map(docOf)
      .filter((doc): doc is LibDoc => !!doc && !used.has(doc.job.id) && !(doc.folder && samePath(doc.folder, path)))
      .map((doc) => (used.add(doc.job.id), doc.job.id));
    if (!jobIds.length) continue;
    const same = plan.folders.find((f) => samePath(f.path, path));
    if (same) same.jobIds.push(...jobIds);
    else plan.folders.push({ path, jobIds });
  }
  for (const raw of Array.isArray(d.questions) ? d.questions : []) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const doc = docOf(r.doc);
    if (!doc || used.has(doc.job.id)) continue;
    const options: string[] = [];
    for (const o of Array.isArray(r.options) ? r.options : []) {
      const path = typeof o === 'string' ? scopedPath(o, scope) : '';
      if (path && !options.some((x) => samePath(x, path))) options.push(path);
    }
    if (!options.length) continue;
    used.add(doc.job.id);
    plan.questions.push({ jobId: doc.job.id, options: options.slice(0, MAX_OPTIONS), at: Date.now() });
  }
  return plan;
}

export const planSize = (plan: OrganizePlan) => plan.folders.reduce((n, f) => n + f.jobIds.length, 0) + plan.questions.length;

/** Návrh roztřídění `docs` (v rozsahu složky `scopeId`) modelem; nic nemění. */
export async function planOrganize(llm: Llm, library: Library, docs: LibDoc[], scopeId: string | null, instruction?: string): Promise<OrganizePlan> {
  if (!docs.length) return { folders: [], questions: [] };
  const limit = LIMITS[isOnline(llm.settings) ? 'online' : 'local'];
  const scopeFolder = scopeId ? library.folders.find((f) => f.id === scopeId) : undefined;
  const scope = scopeFolder ? folderPath(library.folders, scopeFolder) : '';
  const lines: string[] = [];
  let chars = 0;
  for (const [i, doc] of docs.entries()) {
    const line = `[${i + 1}] ${cardText(doc, limit.line)}`;
    if (chars + line.length > limit.chars) break;
    lines.push(line);
    chars += line.length + 1;
  }
  const tree = openPaths(library.folders);
  const out = await ask(llm, 'polish', [{ role: 'user', content: organizePrompt(tree, scope, lines.join('\n'), getLang(), instruction) }], PLAN_TOKENS);
  return parsePlan(out, docs.slice(0, lines.length), scope);
}

/** Návrh pro složku (nebo celou knihovnu) mimo chat – nabídka u přeplněné složky. */
export async function organizeFolder(store: Store, base: Settings, folderId: string | null, model?: ChatModel): Promise<OrganizePlan> {
  const settings = chatSettings(base, model);
  if (isOnline(settings) && !(await readKey(store.root))) throw new Error(t('openrouter.noKey'));
  const jobs = await store.jobs();
  const cards = Object.fromEntries(await Promise.all(jobs.map(async (j) => [j.id, await store.card(j.id)] as const)));
  const library = await store.library();
  const docs = libraryDocs(jobs, cards, library, folderId ?? undefined);
  // Cena online dotazu se k žádné úloze nepřičítá.
  const llm: Llm = { job: { cost: 0 } as Job, settings, signal: new AbortController().signal, endpoint: await connect(settings, store.root) };
  await loadModel(llm, 'polish');
  return planOrganize(llm, library, docs, folderId);
}
