import { describe, expect, it } from 'vitest';
import { isTranslation, overallFraction, recentTranslations } from '../src/shared/translations';

const job = (extra: Partial<Parameters<typeof isTranslation>[0]> = {}) => ({ sourceLang: 'en', targetLang: 'cs', status: 'done' as const, createdAt: 1, ...extra });

describe('isTranslation', () => {
  it('nahrání bez překladu a stejný jazyk nejsou překlad', () => {
    expect(isTranslation(job())).toBe(true);
    expect(isTranslation(job({ translate: false }))).toBe(false);
    expect(isTranslation(job({ targetLang: 'en' }))).toBe(false);
  });

  it('rozpoznání jazyka (auto) a neúspěšný překlad se počítají, zrušené a smazané ne', () => {
    expect(isTranslation(job({ sourceLang: 'auto' }))).toBe(true);
    expect(isTranslation(job({ status: 'error' }))).toBe(true);
    expect(isTranslation(job({ status: 'cancelled' }))).toBe(false);
    expect(isTranslation(job({ trashedAt: 5 }))).toBe(false);
  });
});

describe('recentTranslations', () => {
  it('nejnovější první a nejvýš limit', () => {
    const jobs = [job({ createdAt: 1 }), job({ createdAt: 3 }), job({ createdAt: 2, translate: false }), job({ createdAt: 2 })];
    expect(recentTranslations(jobs).map((j) => j.createdAt)).toEqual([3, 2, 1]);
    expect(recentTranslations(jobs, 2)).toHaveLength(2);
  });
});

describe('overallFraction', () => {
  it('průměr známých, bez známých null', () => {
    expect(overallFraction([0.5, 1, null])).toBe(0.75);
    expect(overallFraction([null])).toBeNull();
    expect(overallFraction([])).toBeNull();
  });
});
