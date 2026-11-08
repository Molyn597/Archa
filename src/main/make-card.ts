import { t } from '../shared/i18n';
import { openPaths } from '../shared/folders';
import { isOnline } from '../shared/provider';
import type { DocumentCard, Job, Placement, Settings } from '../shared/types';
import { cardSample, parseCard, parseFolderChoice } from './card';
import { readKey } from './keystore';
import { ask, connect, loadModel, type Llm } from './pipeline';
import { logPlacement, placeDoc, subfolderTarget } from './library';
import { samePath, scopedPath } from './organize';
import { cardPrompt, subfolderPrompt } from './prompts';
import type { Store } from './store';

// Lokální model má kontext 16k tokenů; online model unese mnohem delší začátek dokumentu.
const LIMITS = { local: 12000, online: 40000 };
const CARD_TOKENS = 1500;
const CHOICE_TOKENS = 400;
/** Nejvýš tolik úrovní podsložek se doptává (Články → Management → Řízení výkonu). */
const REFINE_ROUNDS = 2;

/**
 * Vytvoří kartu dokumentu modelem „polish“, uloží ji a zařadí do složky (případně založí novou, viz placeDoc);
 * cena online dotazu se přičte k úloze. `changed` dostane zařazení, při kterém vznikly složky.
 */
export async function makeCard(store: Store, job: Job, settings: Settings, changed?: (placed?: Placement) => void): Promise<DocumentCard> {
  const online = isOnline(settings);
  const sample = cardSample(await store.segments(job.id), LIMITS[online ? 'online' : 'local']);
  if (!sample) throw new Error(t('card.empty'));
  if (online && !(await readKey(store.appRoot))) throw new Error(t('openrouter.noKey'));
  const llm: Llm = { job, settings, signal: new AbortController().signal, endpoint: await connect(settings, store.appRoot) };
  await loadModel(llm, 'polish');
  const out = await ask(llm, 'polish', [{ role: 'user', content: cardPrompt(sample, job.targetLang, openPaths((await store.library()).folders)) }], CARD_TOKENS);
  const card = parseCard(out, job.targetLang);
  if (!card) throw new Error(t('card.unreadable'));
  await refineFolder(llm, store, card, job.targetLang);
  await store.saveCard(job.id, card);
  const placed = await store.updateLibrary((library) => {
    const p = placeDoc(library, job.id, card);
    if (p) logPlacement(library, p);
    return p;
  });
  changed?.(placed);
  if (job.cost !== undefined) await store.saveJob(job);
  return card;
}

/**
 * Navržená složka má podsložky: model se doptá, do které dokument patří (nebo jakou novou pod ní založit),
 * aby dokument neležel mezi podsložkami. Trvá-li model na nadřazené složce, uživatel dostane dotaz s podsložkami.
 */
export async function refineFolder(llm: Llm, store: Store, card: DocumentCard, lang: string) {
  for (let round = 0; round < REFINE_ROUNDS && card.folder && card.folderSure !== false; round++) {
    const target = subfolderTarget(await store.library(), card.folder);
    if (!target) return;
    const choice = parseFolderChoice(await ask(llm, 'polish', [{ role: 'user', content: subfolderPrompt(card.summary, card.keywords, target.path, target.children, lang) }], CHOICE_TOKENS));
    const folder = choice && scopedPath(choice.folder!, target.path);
    if (!folder || samePath(folder, target.path)) {
      Object.assign(card, { folder: target.children[0], folderSure: false, folderOptions: target.children.slice(1, 3) });
      return;
    }
    card.folder = folder;
    if (choice.folderSure === false) Object.assign(card, { folderSure: false, folderOptions: (choice.folderOptions ?? []).map((o) => scopedPath(o, target.path)) });
  }
}
