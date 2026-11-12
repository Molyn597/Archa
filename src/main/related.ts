import { docTitle } from '../shared/doc-title';
import { folderPath } from '../shared/folders';
import { counterparties, meanVector, suggestRelated } from '../shared/related';
import { deadlines } from '../shared/deadlines';
import { isoDay } from '../shared/invoices';
import type { DocLinks, RelatedDoc } from '../shared/types';
import { indexModel, loadIndex } from './embed';
import { shouldBeLocked } from './library';
import type { Store } from './store';

/**
 * Souvislosti dokumentu: potvrzené a navržené související dokumenty, termíny a projekty.
 * Zamčené dokumenty se nenabízejí; bez indexu se hledá jen podle protistrany.
 */
export async function docLinks(store: Store, id: string): Promise<DocLinks> {
  const [jobs, library, settings, model] = await Promise.all([store.jobs(), store.library(), store.settings(), indexModel(store, id)]);
  const open = jobs.filter((j) => j.id === id || !shouldBeLocked(library, j.id));
  const cards = new Map(await Promise.all(open.map(async (j) => [j.id, await store.card(j.id)] as const)));
  const items = await Promise.all(
    open.map(async (j) => {
      const index = model ? await loadIndex(store, j.id, model) : undefined;
      const vectors = index?.vectors.length ? index.vectors : index?.card ? [index.card] : [];
      return { id: j.id, vector: meanVector(vectors), parties: counterparties(cards.get(j.id), settings.ownCompany) };
    }),
  );
  const self = items.find((i) => i.id === id);
  const job = open.find((j) => j.id === id);
  if (!self || !job) return { suggestions: [], linked: [], deadlines: [], projects: [] };
  const doc = (docId: string, reason?: RelatedDoc['reason']): RelatedDoc => {
    const [job, card] = [open.find((j) => j.id === docId)!, cards.get(docId)];
    return { id: docId, title: docTitle(job, card), ...(card && { type: card.type }), ...(reason && { reason }) };
  };
  const linked = (library.links?.[id] ?? []).filter((l) => open.some((j) => j.id === l));
  const skip = new Set([...linked, ...(library.rejectedLinks?.[id] ?? [])]);
  const projects = (await store.projects()).filter((p) => p.sources.includes(id)).map((p) => ({ id: p.id, name: p.name }));
  const folder = library.folders.find((f) => f.id === library.assign[id]?.folder);
  return {
    suggestions: suggestRelated(self, items, skip).map((s) => doc(s.id, s.reason)),
    linked: linked.map((l) => doc(l)),
    deadlines: deadlines({ jobs: [job], cards: { [id]: cards.get(id) }, paid: library.paid, projects: [], today: isoDay() }),
    projects,
    ...(folder && { folder: { id: folder.id, path: folderPath(library.folders, folder) } }),
  };
}
