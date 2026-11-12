import { t } from '../shared/i18n';
import { openPaths } from '../shared/folders';
import { applyGaps } from '../shared/openalex';
import { isOnline } from '../shared/provider';
import type { ContractRisk, DocumentCard, Job, Placement, Settings } from '../shared/types';
import { cardSample, parseCard, parseFolderChoice } from './card';
import { readKey } from './keystore';
import { ask, connect, loadModel, type Llm } from './pipeline';
import { logPlacement, placeDoc, subfolderTarget } from './library';
import { samePath, scopedPath } from './organize';
import { ruleLines } from '../shared/rules';
import { cardPrompt, subfolderPrompt } from './prompts';
import { contractRisksPrompt, parseRisks } from './risks';
import type { Store } from './store';

// Lokální model má kontext 16k tokenů; online model unese mnohem delší začátek dokumentu.
const LIMITS = { local: 12000, online: 40000 };
// Smlouvu je třeba číst celou; 30 000 znaků je zhruba 9k tokenů, s promptem a odpovědí se vejde do 16k kontextu.
const RISK_LIMITS = { local: 30000, online: 120000 };
const CARD_TOKENS = 1500;
const CHOICE_TOKENS = 400;
const RISK_TOKENS = 1500;
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
  const library = await store.library();
  // Nepřeložený dokument (Nahrát): karta v jazyce uživatele, ne v jazyce dokumentu.
  const lang = job.translate === false ? settings.targetLang : job.targetLang;
  const out = await ask(llm, 'polish', [{ role: 'user', content: cardPrompt(sample, lang, openPaths(library.folders), ruleLines(library.rules)) }], CARD_TOKENS);
  const card = parseCard(out, lang);
  if (!card) throw new Error(t('card.unreadable'));
  if (job.biblioHint) card.biblio = applyGaps(card.biblio, job.biblioHint);
  await applyIsdoc(store, job, card);
  await refineFolder(llm, store, card, lang);
  // Kontrola rizik je navíc: když selže, karta vznikne i bez ní.
  if (card.type === 'contract') card.risks = await checkRisks(llm, store, job, settings, lang).catch(() => undefined);
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

/** Rizika smlouvy z celého textu (bez čísel stran); undefined, když text chybí nebo je odpověď modelu nečitelná. */
export async function checkRisks(llm: Llm, store: Store, job: Job, settings: Settings, lang: string): Promise<ContractRisk[] | undefined> {
  const text = cardSample(await store.segments(job.id), RISK_LIMITS[isOnline(settings) ? 'online' : 'local'], false);
  if (!text) return undefined;
  const out = await ask(llm, 'polish', [{ role: 'user', content: contractRisksPrompt(text, lang, settings.ownCompany?.name) }], RISK_TOKENS);
  return parseRisks(out, text);
}

/** Znovu zkontroluje rizika smlouvy ve stávající kartě a uloží je; příznak `edited` se nemění. */
export async function recheckRisks(store: Store, job: Job, settings: Settings): Promise<DocumentCard> {
  const card = await store.card(job.id);
  if (!card) throw new Error(t('risks.noCard'));
  if (isOnline(settings) && !(await readKey(store.appRoot))) throw new Error(t('openrouter.noKey'));
  const llm: Llm = { job, settings, signal: new AbortController().signal, endpoint: await connect(settings, store.appRoot) };
  await loadModel(llm, 'polish');
  const risks = await checkRisks(llm, store, job, settings, card.lang);
  if (!risks) throw new Error(t('risks.failed'));
  const updated = { ...card, risks };
  await store.saveCard(job.id, updated);
  if (job.cost !== undefined) await store.saveJob(job);
  return updated;
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

/** E-faktura ISDOC v příloze PDF: přesné údaje mají přednost před odhadem modelu. Selhání čtení se ignoruje. */
async function applyIsdoc(store: Store, job: Job, card: DocumentCard) {
  if (job.ext.toLowerCase() !== '.pdf') return;
  try {
    // Dynamicky: pdf.ts potřebuje electron, který testy refineFolder nemají.
    const { isdocFacts } = await import('./isdoc-pdf');
    const facts = await isdocFacts(job.id, await store.readInput(job));
    if (!facts) return;
    card.type = 'invoice';
    // Předmět od modelu shrnuje celou fakturu; ISDOC má jen popis první položky.
    card.facts = { ...card.facts, ...facts, ...(card.facts?.subject && { subject: card.facts.subject }) };
    card.factsFrom = 'isdoc';
  } catch {
    // karta se vytvoří i bez ISDOC
  }
}
