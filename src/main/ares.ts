import { parseAres } from '../shared/ares';
import { t } from '../shared/i18n';
import type { AresRecord } from '../shared/types';

const ARES_URL = 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/';

/** Dotaz do registru ARES; odchází jen IČO. `null` = IČO v registru není, nedostupnost sítě vyhodí chybu. */
export async function fetchAres(ico: string): Promise<AresRecord | null> {
  let res: Response;
  try {
    res = await fetch(ARES_URL + ico, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  } catch {
    throw new Error(t('ares.unavailable'));
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(t('ares.unavailable'));
  return parseAres(await res.json().catch(() => null)) ?? null;
}
