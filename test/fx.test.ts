import { describe, expect, it } from 'vitest';
import { parseCnb } from '../src/main/fx';

const text = '27.10.2026 #207\nzemě|měna|množství|kód|kurz\nAustrálie|dolar|1|AUD|15,354\nEMU|euro|1|EUR|24,350\nUSA|dolar|1|USD|21,834\nJaponsko|jen|100|JPY|14,321\n';

describe('kurz ČNB', () => {
  it('najde měnu a přepočte na 1 jednotku', () => {
    expect(parseCnb(text, 'USD')).toBeCloseTo(21.834);
    expect(parseCnb(text, 'EUR')).toBeCloseTo(24.35);
    expect(parseCnb(text, 'JPY')).toBeCloseTo(0.14321);
    expect(parseCnb(text.replace('1|USD', '100|USD'), 'USD')).toBeCloseTo(0.21834);
  });

  it('neznámá měna nebo prázdný text', () => {
    expect(parseCnb(text, 'XYZ')).toBeUndefined();
    expect(parseCnb('nic', 'EUR')).toBeUndefined();
  });
});
