import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Job } from '../shared/types';
import { LockedError, type Store } from './store';

export const hashBytes = (data: Buffer) => createHash('sha256').update(data).digest('hex');

export const hashFile = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });

/** Doplní otisk dokumentům bez něj (i v koši). Zamčené se bez odemčeného trezoru vůbec nenačtou; vrací doplněné. */
export async function fillHashes(store: Store): Promise<Job[]> {
  const done: Job[] = [];
  for (const job of [...(await store.jobs()), ...(await store.jobs(true))]) {
    // Běžící úlohu si fronta ukládá sama, zápis by jí přepsal stav.
    if (job.inputHash || job.status === 'running' || job.status === 'queued') continue;
    try {
      job.inputHash = hashBytes(await store.readInput(job));
      await store.saveJob(job);
      done.push(job);
    } catch (e) {
      // Chybějící originál nebo zamčený trezor: zkusí se příště.
      if (!(e instanceof LockedError) && (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return done;
}
