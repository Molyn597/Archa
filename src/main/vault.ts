import { createCipheriv, createDecipheriv, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Trezor zamčených složek. Z hesla se scryptem odvodí klíč (KEK), kterým je zašifrovaný náhodný hlavní klíč (DEK);
 * soubory se šifrují hlavním klíčem (AES-256-GCM). Heslo se nikam neukládá – bez něj nejde data obnovit.
 */

export const MAGIC = Buffer.from('TLK1');
const IV = 12;
const TAG = 16;
const KEY = 32;
const MIN_PASSWORD = 8;

export interface KdfParams {
  N: number;
  r: number;
  p: number;
}
// ~0,3–0,5 s a 128 MB paměti na odvození: hádání hesla hrubou silou je drahé.
export const DEFAULT_KDF: KdfParams = { N: 2 ** 17, r: 8, p: 1 };

export interface VaultMeta {
  v: 1;
  kdf: KdfParams;
  salt: string;
  /** Hlavní klíč zašifrovaný klíčem z hesla (MAGIC | iv | tag | ct), base64. */
  key: string;
}

export class WrongPasswordError extends Error {}
export class TamperedError extends Error {}

function deriveKey(password: string, salt: Buffer, kdf: KdfParams): Promise<Buffer> {
  const options: ScryptOptions = { ...kdf, maxmem: 256 * kdf.N * kdf.r + 1024 * 1024 };
  return new Promise((resolve, reject) => scrypt(password.normalize('NFC'), salt, KEY, options, (err, key) => (err ? reject(err) : resolve(key))));
}

/** Zašifruje data; `aad` váže výsledek na místo (dokument a soubor), takže ho nejde podstrčit jinam. */
export function encrypt(key: Buffer, data: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ct]);
}

export function decrypt(key: Buffer, blob: Buffer, aad: string): Buffer {
  if (blob.length < MAGIC.length + IV + TAG || !timingSafeEqual(blob.subarray(0, MAGIC.length), MAGIC)) throw new TamperedError('Not a TransLatte encrypted file');
  const iv = blob.subarray(MAGIC.length, MAGIC.length + IV);
  const tag = blob.subarray(MAGIC.length + IV, MAGIC.length + IV + TAG);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(blob.subarray(MAGIC.length + IV + TAG)), decipher.final()]);
  } catch {
    throw new TamperedError('Encrypted file is damaged or belongs elsewhere');
  }
}

export const passwordOk = (password: string) => password.length >= MIN_PASSWORD;

/** Nový trezor: náhodný hlavní klíč zašifrovaný klíčem z hesla. */
export async function createVault(password: string, kdf = DEFAULT_KDF): Promise<{ meta: VaultMeta; key: Buffer }> {
  const salt = randomBytes(16);
  const key = randomBytes(KEY);
  const kek = await deriveKey(password, salt, kdf);
  return { meta: { v: 1, kdf, salt: salt.toString('base64'), key: encrypt(kek, key, 'vault').toString('base64') }, key };
}

/** Hlavní klíč z hesla; špatné heslo = WrongPasswordError (GCM nesouhlasí). */
export async function openVault(meta: VaultMeta, password: string): Promise<Buffer> {
  const kek = await deriveKey(password, Buffer.from(meta.salt, 'base64'), meta.kdf);
  try {
    return decrypt(kek, Buffer.from(meta.key, 'base64'), 'vault');
  } catch {
    throw new WrongPasswordError('Wrong password');
  }
}

/** Nové heslo: stejný hlavní klíč, jen znovu zašifrovaný (dokumenty se nepřešifrovávají). */
export async function rewrapVault(meta: VaultMeta, oldPassword: string, newPassword: string): Promise<VaultMeta> {
  const key = await openVault(meta, oldPassword);
  const salt = randomBytes(16);
  const kek = await deriveKey(newPassword, salt, meta.kdf);
  return { ...meta, salt: salt.toString('base64'), key: encrypt(kek, key, 'vault').toString('base64') };
}
