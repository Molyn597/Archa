import { existsSync } from 'node:fs';
import { t } from '../shared/i18n';
import { isOnline } from '../shared/provider';
import type { Provider } from '../shared/types';
import { readKey } from './keystore';
import { lmsPath, serverUp } from './lmstudio';
import type { Store } from './store';

/** Proč zvolený poskytovatel zatím nejde použít (jinak null); bez zadaného se bere ten z nastavení. */
export async function notReadyReason(store: Store, provider?: Provider): Promise<string | null> {
  const settings = await store.settings();
  if (isOnline({ provider: provider ?? settings.provider })) return (await readKey(store.appRoot)) ? null : t('openrouter.noKey');
  return existsSync(lmsPath()) || (await serverUp(settings.apiUrl)) ? null : t('lmstudio.notInstalled');
}

/** Před zařazením úlohy: místo nevysvětlené chyby až v průběhu hned srozumitelná hláška. */
export async function assertReady(store: Store, provider?: Provider) {
  const reason = await notReadyReason(store, provider);
  if (reason) throw new Error(reason);
}
