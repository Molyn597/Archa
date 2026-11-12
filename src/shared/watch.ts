/** Přípony souborů, které aplikace umí přečíst (import složky i sledovaná složka). */
export const IMPORT_EXTS = ['.pdf', '.docx', '.txt', '.md'];

/** Podporovaný soubor; skryté a zámkové soubory Wordu (`~$…`) se přeskočí. */
export function isImportable(file: string): boolean {
  const name = file.split(/[\\/]/).pop() ?? '';
  const ext = /\.[^.]+$/.exec(name)?.[0].toLowerCase() ?? '';
  return IMPORT_EXTS.includes(ext) && !name.startsWith('.') && !name.startsWith('~$');
}

/** Zpracované soubory sledované složky: cesta → čas změny (ms). */
export type SeenFiles = Record<string, number>;

/** Soubor je nový nebo od posledního zpracování změněný. */
export const isNewFile = (seen: SeenFiles, file: string, mtimeMs: number) => seen[file] !== Math.trunc(mtimeMs);
