import { t } from '../shared/i18n';
import { folderName } from '../shared/folders';
import { isOnline } from '../shared/provider';
import type { DocumentCard, Job, Settings } from '../shared/types';
import { cardSample, parseCard } from './card';
import { readKey } from './keystore';
import { ask, connect, loadModel, type Llm } from './pipeline';
import { autoAssign } from './library';
import { cardPrompt } from './prompts';
import type { Store } from './store';

// Lokální model má kontext 16k tokenů; online model unese mnohem delší začátek dokumentu.
const LIMITS = { local: 12000, online: 40000 };
const CARD_TOKENS = 1500;

/** Vytvoří kartu dokumentu modelem „polish“, uloží ji a zařadí do složky; cena online dotazu se přičte k úloze. */
export async function makeCard(store: Store, job: Job, settings: Settings, changed?: () => void): Promise<DocumentCard> {
  const online = isOnline(settings);
  const sample = cardSample(await store.segments(job.id), LIMITS[online ? 'online' : 'local']);
  if (!sample) throw new Error(t('card.empty'));
  if (online && !(await readKey(store.root))) throw new Error(t('openrouter.noKey'));
  const llm: Llm = { job, settings, signal: new AbortController().signal, endpoint: await connect(settings, store.root) };
  await loadModel(llm, 'polish');
  const out = await ask(llm, 'polish', [{ role: 'user', content: cardPrompt(sample, job.targetLang, (await store.library()).folders.map(folderName)) }], CARD_TOKENS);
  const card = parseCard(out, job.targetLang);
  if (!card) throw new Error(t('card.unreadable'));
  await store.saveCard(job.id, card);
  await store.updateLibrary((library) => autoAssign(library, job.id, card.folder));
  changed?.();
  if (job.cost !== undefined) await store.saveJob(job);
  return card;
}
