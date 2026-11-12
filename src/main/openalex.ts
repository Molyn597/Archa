import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { t } from '../shared/i18n';
import { bestMatch, doiUrl, fillGaps, searchUrl, titleUrl, toBiblio, toWork, toWorks, type Gap, type OpenAlexWork } from '../shared/openalex';
import { addSources } from '../shared/projects';
import type { Biblio } from '../shared/types';
import type { Queue } from './queue';
import type { Store } from './store';

const MAX_PDF = 50 * 1024 * 1024;

/** JSON z OpenAlex; odchází jen adresa s hledaným textem. `null` = 404 (DOI v databázi není). */
async function getJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  } catch {
    throw new Error(t('openalex.unavailable'));
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(t('openalex.unavailable'));
  return res.json().catch(() => {
    throw new Error(t('openalex.unavailable'));
  });
}

export async function searchWorks(q: string): Promise<OpenAlexWork[]> {
  return q.trim() ? toWorks(await getJson(searchUrl(q))) : [];
}

/** Dohledá práci k údajům karty: nejdřív podle DOI, jinak podle názvu s kontrolou shody. */
export async function lookupWork(biblio: Biblio): Promise<OpenAlexWork | undefined> {
  if (biblio.doi?.trim()) {
    const found = toWork(await getJson(doiUrl(biblio.doi)));
    if (found) return found;
  }
  return biblio.title?.trim() ? bestMatch(biblio.title, toWorks(await getJson(titleUrl(biblio.title)))) : undefined;
}

export async function lookupForCard(biblio: Biblio): Promise<{ work: OpenAlexWork; gaps: Gap[] } | undefined> {
  const work = await lookupWork(biblio);
  return work && { work, gaps: fillGaps(biblio, toBiblio(work)) };
}

/** Stáhne PDF; vyhodí chybu, když to PDF není, je příliš velké nebo se nestáhlo. */
export async function downloadPdf(url: string): Promise<Buffer> {
  const fail = () => new Error(t('openalex.pdfFailed'));
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
  } catch {
    throw fail();
  }
  if (!res.ok || !res.body || Number(res.headers.get('content-length')) > MAX_PDF) throw fail();
  // Server nemusí velikost poslat: čte se po kusech a nad limit se stahování přeruší.
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_PDF) throw fail();
      chunks.push(chunk);
    }
  } catch {
    throw fail();
  }
  const body = Buffer.concat(chunks);
  const isPdf = res.headers.get('content-type')?.toLowerCase().includes('application/pdf') || body.subarray(0, 5).toString('latin1') === '%PDF-';
  if (!isPdf || !body.length || body.length > MAX_PDF) throw fail();
  return body;
}

const fileName = (title: string) => `${title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'article'}.pdf`;

/**
 * Přidá volně dostupné PDF do knihovny jako sledovaná složka (bez překladu, do Odkladiště); fronta soubor
 * zkopíruje, dočasný se hned smaže. Údaje z OpenAlex se uloží k úloze a doplní prázdná pole karty.
 */
export async function addFromOpenAlex(store: Store, queue: Queue, work: OpenAlexWork, projectId?: string): Promise<string> {
  if (!work.pdfUrl) throw new Error(t('openalex.pdfFailed'));
  const pdf = await downloadPdf(work.pdfUrl);
  const settings = await store.settings();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'translatte-oa-'));
  try {
    const file = path.join(dir, fileName(work.title));
    await writeFile(file, pdf);
    const id = await queue.add(file, { mode: settings.mode, sourceLang: 'auto', targetLang: settings.targetLang, provider: settings.provider, translate: false, biblioHint: toBiblio(work) });
    if (projectId) {
      const project = await store.project(projectId);
      if (project) {
        addSources(project, [id]);
        project.updatedAt = Date.now();
        await store.saveProject(project);
      }
    }
    return id;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
