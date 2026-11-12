import { describe, expect, it } from 'vitest';
import { applyTemplate, DEFAULT_NAME_TEMPLATE } from '../src/shared/name-template';
import type { DocumentCard } from '../src/shared/types';

const card = (over: Partial<DocumentCard> = {}): DocumentCard => ({
  summary: '',
  type: 'invoice',
  keywords: [],
  biblio: { authors: [], title: '' },
  lang: 'cs',
  createdAt: 0,
  facts: { issued: '2026-03-04', supplier: 'Elektro Vltava, a.s.', number: '2026/015' },
  ...over,
});

describe('applyTemplate', () => {
  it('doplní údaje z karty a vyřadí znaky nepovolené v názvu souboru', () => {
    expect(applyTemplate(card(), DEFAULT_NAME_TEMPLATE)).toBe('2026-03-04 Elektro Vltava, a.s. Faktura 2026 015');
  });

  it('prázdné hodnoty vynechá bez zbylých oddělovačů, anglické značky fungují také', () => {
    expect(applyTemplate(card({ facts: { supplier: 'ACME' } }), '{date} - {party} - {number}')).toBe('ACME');
    expect(applyTemplate(card({ type: 'other', facts: undefined }), '{typ}')).toBe('');
  });

  it('neznámá značka se vynechá a název se zkrátí', () => {
    expect(applyTemplate(card(), '{nic}{cislo}')).toBe('2026 015');
    expect(applyTemplate(card({ biblio: { authors: [], title: 'x'.repeat(300) } }), '{nazev}')).toHaveLength(120);
  });
});
