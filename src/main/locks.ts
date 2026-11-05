import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Library } from '../shared/types';
import { shouldBeLocked } from './library';
import type { Store } from './store';

const jobIds = (store: Store) => readdir(path.join(store.root, 'jobs')).catch(() => [] as string[]);

/** Dokumenty, jejichž šifrování neodpovídá složce (zašifrovat / dešifrovat). */
export async function lockTransitions(store: Store, library: Library): Promise<{ id: string; lock: boolean }[]> {
  const out: { id: string; lock: boolean }[] = [];
  for (const id of await jobIds(store)) {
    const want = shouldBeLocked(library, id);
    if (want !== (await store.isLockedJob(id))) out.push({ id, lock: want });
  }
  return out;
}

/** Srovná šifrování dokumentů se složkami a dokončí přerušené šifrování; vyžaduje odemčený trezor. */
export async function syncLocks(store: Store, library: Library) {
  for (const { id, lock } of await lockTransitions(store, library)) await (lock ? store.encryptJob(id) : store.decryptJob(id));
  for (const id of await store.lockedWithPlaintext()) if (shouldBeLocked(library, id)) await store.encryptJob(id);
}
