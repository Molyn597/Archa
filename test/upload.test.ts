import { describe, expect, it } from 'vitest';
import { bulkSavable, suggestion } from '../src/shared/upload';
import type { DocumentCard, Library } from '../src/shared/types';

const library = (over: Partial<Library> = {}): Library => ({
  folders: [
    { id: 'invoices', name: 'Faktury', createdAt: 0 },
    { id: 'in', name: 'Přijaté', createdAt: 0, parent: 'invoices' },
  ],
  assign: {},
  ...over,
});
const card = (over: Partial<DocumentCard> = {}) => ({ folder: 'Faktury / Přijaté', ...over }) as DocumentCard;

describe('suggestion', () => {
  it('zařazený dokument vrací cestu složky a jistotu z karty', () => {
    const s = suggestion(library({ assign: { a: { folder: 'in' } } }), 'a', card());
    expect(s).toEqual({ folder: 'in', path: 'Faktury / Přijaté', sure: true, confirmed: false });
  });

  it('ručně zařazený je potvrzený', () => {
    expect(suggestion(library({ assign: { a: { folder: 'in', manual: true } } }), 'a', card())?.confirmed).toBe(true);
  });

  it('otevřený dotaz = nejistý první návrh', () => {
    const lib = library({ questions: [{ jobId: 'a', options: ['Smlouvy', 'Ostatní'], at: 0 }] });
    expect(suggestion(lib, 'a', card())).toEqual({ path: 'Smlouvy', sure: false, confirmed: false });
  });

  it('bez zařazení a dotazu se vezme cesta z karty, bez karty nic', () => {
    expect(suggestion(library(), 'a', card())).toEqual({ path: 'Faktury / Přijaté', sure: false, confirmed: false });
    expect(suggestion(library(), 'a')).toBeUndefined();
  });

  it('hromadně jde uložit jen jistý, nepotvrzený a se složkou', () => {
    expect(bulkSavable(suggestion(library({ assign: { a: { folder: 'in' } } }), 'a', card()))).toBe(true);
    expect(bulkSavable(suggestion(library({ assign: { a: { folder: 'in', manual: true } } }), 'a', card()))).toBe(false);
    expect(bulkSavable(suggestion(library({ assign: { a: { folder: 'in' } } }), 'a', card({ folderSure: false })))).toBe(false);
    expect(bulkSavable(undefined)).toBe(false);
  });
});
