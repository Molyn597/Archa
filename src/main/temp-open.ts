import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Dočasné nešifrované kopie zamčených dokumentů otevřené v jiné aplikaci (Word, Náhled). */
const dirs = new Set<string>();

export async function tempCopy(name: string, data: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'translatte-'));
  dirs.add(dir);
  const file = path.join(dir, path.basename(name));
  await writeFile(file, data);
  return file;
}

/** Smaže všechny dočasné kopie (při zamčení trezoru a ukončení aplikace). */
export async function wipeTempCopies() {
  await Promise.all([...dirs].map((d) => rm(d, { recursive: true, force: true })));
  dirs.clear();
}
