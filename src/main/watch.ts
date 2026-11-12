import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Settings } from '../shared/types';
import { isImportable, isNewFile } from '../shared/watch';
import { hashFile } from './hash';
import type { Queue } from './queue';
import type { Store } from './store';

/** Počká na doznění změn (soubor se ještě kopíruje) a teprve pak složku projde. */
const DEBOUNCE_MS = 3000;

/** Sledovaná složka knihovny: nové soubory se přečtou bez překladu a zařadí (do Odkladiště, ne ručně). */
export class FolderWatch {
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private folder = '';
  private scanning = false;
  private again = false;

  constructor(
    private store: Store,
    private queue: Queue,
  ) {}

  /** Podle nastavení spustí nebo zastaví sledování; při spuštění doběhne soubory přidané mezitím. */
  apply(settings: Settings) {
    this.stop();
    if (!settings.watchOn || !settings.watchFolder) return;
    this.folder = settings.watchFolder;
    try {
      this.watcher = watch(this.folder, { recursive: true }, () => this.schedule());
      this.watcher.on('error', () => this.stop());
    } catch {
      return;
    }
    this.schedule();
  }

  stop() {
    clearTimeout(this.timer);
    this.watcher?.close();
    this.watcher = undefined;
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.scan(), DEBOUNCE_MS);
  }

  private async scan() {
    if (this.scanning) {
      this.again = true;
      return;
    }
    this.scanning = true;
    try {
      const settings = await this.store.settings();
      const seen = await this.store.watchSeen();
      const known = new Set([...(await this.store.jobs()), ...(await this.store.jobs(true))].flatMap((j) => (j.inputHash ? [j.inputHash] : [])));
      const names = await readdir(this.folder, { recursive: true }).catch(() => [] as string[]);
      for (const name of names.filter(isImportable)) {
        const file = path.join(this.folder, name);
        const info = await stat(file).catch(() => undefined);
        if (!info?.isFile() || !info.size || !isNewFile(seen, file, info.mtimeMs)) continue;
        const hash = await hashFile(file).catch(() => undefined);
        if (!hash) continue;
        // Shodný soubor už v knihovně je (i v koši): jen se zapamatuje. Selhání přidání se zkusí při příštím průchodu.
        const added = known.has(hash) || (await this.queue.add(file, { mode: settings.mode, sourceLang: 'auto', targetLang: settings.targetLang, provider: settings.provider, translate: false }).then(() => true, () => false));
        if (!added) continue;
        known.add(hash);
        seen[file] = Math.trunc(info.mtimeMs);
      }
      await this.store.saveWatchSeen(seen);
    } finally {
      this.scanning = false;
      if (this.again) {
        this.again = false;
        this.schedule();
      }
    }
  }
}
