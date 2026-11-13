import { cpSync, existsSync, readdirSync, readlinkSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MIGRATED_MARK, userDataStep, type UserDataStep } from '../shared/user-data-migration';

// Synchronní schválně: musí doběhnout dřív, než cokoli (zámek jedné instance, Chromium) sáhne do userData.

const entries = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** Dokumenty nebo projekty ve staré struktuře (přímo v kořeni) i v knihovnách (libraries/<id>). */
const hasDocs = (root: string) =>
  [root, ...entries(path.join(root, 'libraries')).map((id) => path.join(root, 'libraries', id))].some(
    (dir) => entries(path.join(dir, 'jobs')).length > 0 || entries(path.join(dir, 'projects')).length > 0,
  );

/** Chromium drží v SingletonLock odkaz „počítač-pid“ (macOS, Linux); na Windows běh prozradí až selhání přesunu. */
function isRunning(dir: string) {
  let pid: number;
  try {
    pid = Number(readlinkSync(path.join(dir, 'SingletonLock')).split('-').pop());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type MigrationResult = UserDataStep | { step: 'done'; method: 'rename' | 'copy'; aside?: string } | { step: 'failed'; error: string };

/**
 * Převezme data starší verze: přejmenuje celou složku (atomicky, nic se nekopíruje ani nepřepisuje).
 * Na jiném svazku zkopíruje a starou složku nechá. Neprázdnou novou složku bez dokumentů jen odsune stranou.
 */
export function migrateUserData(oldDir: string, newDir: string, custom: boolean): MigrationResult {
  // Vlastní složka (vývoj, testy): na starou se vůbec nesahá.
  if (custom) return { step: 'skip', reason: 'custom' };
  const plan = userDataStep({
    oldExists: existsSync(oldDir),
    oldRunning: isRunning(oldDir),
    newExists: entries(newDir).length > 0,
    newHasDocs: hasDocs(newDir),
    migrated: existsSync(path.join(newDir, MIGRATED_MARK)),
  });
  if (plan.step === 'skip') return plan;
  const aside = plan.step === 'move-aside' ? `${newDir}-pred-prevzetim-${Date.now()}` : undefined;
  try {
    if (aside) renameSync(newDir, aside);
    else if (existsSync(newDir)) rmdirSync(newDir);
    let method: 'rename' | 'copy' = 'rename';
    try {
      renameSync(oldDir, newDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      // Přes dočasnou složku, aby po přerušení nezůstala napůl zkopírovaná data jako hotová.
      const part = `${newDir}.part`;
      rmSync(part, { recursive: true, force: true });
      cpSync(oldDir, part, { recursive: true, verbatimSymlinks: true });
      renameSync(part, newDir);
      method = 'copy';
    }
    writeFileSync(path.join(newDir, MIGRATED_MARK), JSON.stringify({ from: oldDir, at: new Date().toISOString(), method, ...(aside ? { aside } : {}) }));
    return { step: 'done', method, ...(aside ? { aside } : {}) };
  } catch (e) {
    // Data zůstala ve staré složce; odsunutá nová se vrátí na místo a příští start to zkusí znovu.
    if (aside && !existsSync(newDir)) {
      try {
        renameSync(aside, newDir);
      } catch {
        /* zůstane odsunutá, nic se neztratí */
      }
    }
    return { step: 'failed', error: (e as Error).message };
  }
}
