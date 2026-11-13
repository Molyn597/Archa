/** Složka dat starší verze aplikace (TransLatte) a značka po převzetí v nové složce. */
export const OLD_USER_DATA = 'TransLatte';
export const MIGRATED_MARK = 'migrated-from-translatte.json';

export interface UserDataState {
  oldExists: boolean;
  /** Stará aplikace právě běží (živý zámek v její složce). */
  oldRunning: boolean;
  /** Nová složka existuje a není prázdná (prázdnou zakládá Electron ještě před spuštěním aplikace). */
  newExists: boolean;
  /** Nová složka už obsahuje dokumenty nebo projekty. */
  newHasDocs: boolean;
  /** Převzetí už jednou proběhlo (značka v nové složce). */
  migrated: boolean;
}

export type UserDataStep =
  | { step: 'skip'; reason: 'custom' | 'no-old' | 'migrated' | 'new-has-docs' | 'old-running' }
  | { step: 'move' }
  /** Nová složka existuje bez dokumentů (jen data prohlížeče nebo prázdná knihovna): odsune se stranou, nic se nesmaže. */
  | { step: 'move-aside' };

export function userDataStep(s: UserDataState): UserDataStep {
  if (!s.oldExists) return { step: 'skip', reason: 'no-old' };
  if (s.migrated) return { step: 'skip', reason: 'migrated' };
  if (s.newHasDocs) return { step: 'skip', reason: 'new-has-docs' };
  if (s.oldRunning) return { step: 'skip', reason: 'old-running' };
  return s.newExists ? { step: 'move-aside' } : { step: 'move' };
}
