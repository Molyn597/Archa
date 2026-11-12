import type { Store } from './store';

const CNB_URL = 'https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt';
const MAX_CACHED = 300;

/** Kurz měny z denního kurzovního lístku ČNB („USA|dolar|1|USD|21,834“), přepočtený na 1 jednotku. */
export function parseCnb(text: string, code: string): number | undefined {
  const line = text.split('\n').find((l) => l.split('|')[3] === code);
  if (!line) return undefined;
  const [, , amount, , rate] = line.split('|');
  const value = Number(rate.replace(',', '.')) / Number(amount);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Lístek ČNB k datu RRRR-MM-DD (bez data dnešní); o víkendu a svátku platí poslední pracovní den. */
async function fetchRate(code: string, date?: string): Promise<number | undefined> {
  const [y, m, d] = date?.split('-') ?? [];
  const res = await fetch(date ? `${CNB_URL}?date=${d}.${m}.${y}` : CNB_URL, { signal: AbortSignal.timeout(5000) });
  return res.ok ? parseCnb(await res.text(), code) : undefined;
}

/** Kurz USD se stahuje nejvýš jednou denně; bez internetu zůstane poslední uložený. */
export async function usdCzk(store: Store): Promise<number | undefined> {
  const settings = await store.settings();
  if (settings.usdCzk?.date === today()) return settings.usdCzk.rate;
  try {
    const rate = await fetchRate('USD');
    if (rate) {
      await store.saveSettings({ ...(await store.settings()), usdCzk: { rate, date: today() } });
      return rate;
    }
  } catch {
    // Offline: použije se poslední známý kurz.
  }
  return settings.usdCzk?.rate;
}

/** Kurz měny k datu (odchází jen datum); kurz minulého dne se nemění, proto se ukládá napořád. Bez internetu undefined. */
export async function cnbRate(store: Store, code: string, date: string): Promise<number | undefined> {
  if (!/^[A-Z]{3}$/.test(code) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  if (code === 'CZK') return 1;
  const key = `${date}|${code}`;
  const cached = (await store.settings()).fxRates?.[key];
  if (cached) return cached;
  try {
    const rate = await fetchRate(code, date);
    if (rate) {
      const settings = await store.settings();
      const rates = Object.entries({ ...settings.fxRates, [key]: rate }).slice(-MAX_CACHED);
      await store.saveSettings({ ...settings, fxRates: Object.fromEntries(rates) });
    }
    return rate;
  } catch {
    return undefined;
  }
}
