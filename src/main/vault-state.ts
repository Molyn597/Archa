import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { syncLocks } from './locks';
import type { Store } from './store';
import { wipeTempCopies } from './temp-open';
import { createVault, openVault, rewrapVault, type VaultMeta } from './vault';

/** Po tolika minutách nečinnosti se trezor sám zamkne. */
export const IDLE_MINUTES = 15;

/** Stav trezoru v hlavním procesu: hlavní klíč jen v paměti (předaný Store), zamčení maže dočasné kopie. */
export class VaultState {
  private lastActivity = Date.now();
  private timer?: NodeJS.Timeout;

  constructor(
    private store: Store,
    private changed: () => void,
  ) {}

  private file = () => path.join(this.store.root, 'vault.json');

  private async meta(): Promise<VaultMeta | undefined> {
    try {
      return JSON.parse(await readFile(this.file(), 'utf8')) as VaultMeta;
    } catch {
      return undefined;
    }
  }

  private async saveMeta(meta: VaultMeta) {
    const tmp = `${this.file()}.tmp`;
    await writeFile(tmp, JSON.stringify(meta));
    await rename(tmp, this.file());
  }

  async status() {
    return { exists: !!(await this.meta()), unlocked: this.store.unlocked };
  }

  /** Nový trezor (jen když žádný není) – rovnou odemčený. */
  async create(password: string) {
    if (await this.meta()) throw new Error('Vault already exists');
    const { meta, key } = await createVault(password);
    await this.saveMeta(meta);
    await this.open(key);
  }

  async unlock(password: string) {
    const meta = await this.meta();
    if (!meta) throw new Error('No vault');
    await this.open(await openVault(meta, password));
  }

  private async open(key: Buffer) {
    this.store.setKey(key);
    this.touch();
    this.timer ??= setInterval(() => {
      if (this.store.unlocked && Date.now() - this.lastActivity > IDLE_MINUTES * 60_000) void this.lock();
    }, 30_000);
    // Dokončí přerušené šifrování a srovná dokumenty se složkami.
    await syncLocks(this.store, await this.store.library());
    this.changed();
  }

  async lock() {
    if (!this.store.unlocked) return;
    this.store.setKey(undefined);
    await wipeTempCopies();
    this.changed();
  }

  async changePassword(oldPassword: string, newPassword: string) {
    const meta = await this.meta();
    if (!meta) throw new Error('No vault');
    await this.saveMeta(await rewrapVault(meta, oldPassword, newPassword));
  }

  /** Konec používání (přepnutí knihovny): zamknout a zastavit hlídání nečinnosti. */
  async dispose() {
    await this.lock();
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Aktivita uživatele (posouvá automatické zamčení). */
  touch = () => (this.lastActivity = Date.now());
}
