import { isOnline } from '../shared/provider';
import type { DocumentCard, Settings } from '../shared/types';
import { readKey } from './keystore';
import { EMBED_ID, embeddings, ensureEmbedModel } from './lmstudio';
import { connect } from './pipeline';
import type { Endpoint } from './provider';
import { passages, type Passage } from './rag';
import type { Store } from './store';

const BATCH = 32;
/** Delší úsek se zkrátí; embedding modely mají kontext řádově 512–8000 tokenů. */
const MAX_CHARS = 2000;
/** Kratší úseky (čísla stránek, popisky) se neindexují. */
const MIN_CHARS = 15;

/** Embedding model aktivního poskytovatele; bez něj se hledá jen podle slov. */
export const embedModelFor = (settings: Settings) => (isOnline(settings) ? settings.embedModels?.remote : settings.embedModels?.local) || undefined;

/** Předpona podle rodiny modelu: e5 a nomic rozlišují dotaz a text, ostatní ne. */
export function embedPrefix(model: string, kind: 'query' | 'passage') {
  const m = model.toLowerCase();
  if (m.includes('e5')) return kind === 'query' ? 'query: ' : 'passage: ';
  if (m.includes('nomic')) return kind === 'query' ? 'search_query: ' : 'search_document: ';
  return '';
}

export function normalize(v: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(v);
  const len = Math.hypot(...out) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= len;
  return out;
}

export const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/** Klient embeddingů pro jedno nastavení (lokálně se model načte jednou). */
export interface Embedder {
  model: string;
  embed(texts: string[], kind: 'query' | 'passage', signal?: AbortSignal): Promise<Float32Array[]>;
}

export async function embedder(settings: Settings, root: string, onCost?: (usd: number) => void): Promise<Embedder | undefined> {
  const model = embedModelFor(settings);
  if (!model) return undefined;
  const online = isOnline(settings);
  if (online && !(await readKey(root))) return undefined;
  const endpoint: Endpoint = await connect(settings, root);
  if (!online) await ensureEmbedModel(model);
  const name = online ? model : EMBED_ID;
  return {
    model,
    async embed(texts, kind, signal) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH).map((t) => embedPrefix(model, kind) + t.slice(0, MAX_CHARS));
        for (const v of await embeddings(endpoint, name, batch, signal, onCost)) out.push(normalize(v));
      }
      return out;
    },
  };
}

/** Index dokumentu: vektory úseků (podle id segmentu) a karty. */
export interface VectorIndex {
  model: string;
  ids: number[];
  vectors: Float32Array[];
  card?: Float32Array;
}

interface IndexMeta {
  model: string;
  dims: number;
  ids: number[];
  card: boolean;
}


/** Text karty pro vektor: shrnutí a klíčová slova (výběr dokumentů podle významu). */
export const cardEmbedText = (name: string, card: DocumentCard) => [name, card.biblio.title, card.summary, card.keywords.join(', ')].filter(Boolean).join('\n');

export const indexable = (items: Passage[]) => items.filter((p) => p.text.trim().length >= MIN_CHARS);

export async function saveIndex(store: Store, id: string, index: VectorIndex) {
  const dims = index.vectors[0]?.length ?? index.card?.length ?? 0;
  const rows = [...index.vectors, ...(index.card ? [index.card] : [])];
  const bin = new Float32Array(rows.length * dims);
  rows.forEach((v, i) => bin.set(v, i * dims));
  await store.writeJobFile(id, 'vectors.bin', Buffer.from(bin.buffer));
  const meta: IndexMeta = { model: index.model, dims, ids: index.ids, card: !!index.card };
  await store.writeJobFile(id, 'vectors.json', JSON.stringify(meta));
}

/** Index dokumentu, pokud existuje a vznikl modelem `model`. */
export async function loadIndex(store: Store, id: string, model?: string): Promise<VectorIndex | undefined> {
  try {
    const meta = JSON.parse((await store.readJobFile(id, 'vectors.json')).toString('utf8')) as IndexMeta;
    if (model && meta.model !== model) return undefined;
    const buf = await store.readJobFile(id, 'vectors.bin');
    const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const row = (i: number) => all.slice(i * meta.dims, (i + 1) * meta.dims);
    return { model: meta.model, ids: meta.ids, vectors: meta.ids.map((_, i) => row(i)), ...(meta.card && { card: row(meta.ids.length) }) };
  } catch {
    return undefined;
  }
}

export async function indexModel(store: Store, id: string): Promise<string | undefined> {
  try {
    return (JSON.parse((await store.readJobFile(id, 'vectors.json')).toString('utf8')) as IndexMeta).model;
  } catch {
    return undefined;
  }
}

/** Vytvoří (přepíše) index dokumentu. */
export async function buildIndex(store: Store, jobId: string, name: string, emb: Embedder, signal?: AbortSignal) {
  const items = indexable(passages(await store.segments(jobId)));
  const card = await store.card(jobId);
  const vectors = await emb.embed(items.map((p) => p.text), 'passage', signal);
  const [cardVec] = card ? await emb.embed([cardEmbedText(name, card)], 'passage', signal) : [];
  await saveIndex(store, jobId, { model: emb.model, ids: items.map((p) => p.id), vectors, ...(cardVec && { card: cardVec }) });
}

/**
 * Reciprocal Rank Fusion: spojí několik pořadí (nejlepší první) do jednoho; `k` tlumí vliv prvních míst.
 * Klíč položky určuje `key`.
 */
export function rrf<T>(lists: T[][], key: (item: T) => string | number, k = 60): T[] {
  const score = new Map<string | number, { item: T; score: number }>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const id = key(item);
      const e = score.get(id) ?? { item, score: 0 };
      e.score += 1 / (k + rank + 1);
      score.set(id, e);
    });
  }
  return [...score.values()].sort((a, b) => b.score - a.score).map((e) => e.item);
}
