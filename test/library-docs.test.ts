import { describe, expect, it } from 'vitest';
import { docFactsText, libraryDocs } from '../src/main/library-docs';
import type { DocumentCard, Job, Library } from '../src/shared/types';

const job = (id: string) => ({ id, name: id, ext: '.pdf', status: 'done' }) as Job;
const card = (type: DocumentCard['type']) => ({ type, summary: 's', keywords: [], biblio: { authors: [], title: '' }, facts: { due: '2026-10-29' } }) as unknown as DocumentCard;
const library: Library = { folders: [], assign: {}, paid: { a: Date.UTC(2026, 10, 5, 12) } };

describe('docFactsText', () => {
  it('u faktury přidá stav úhrady, u jiných typů ne', () => {
    const [paid, unpaid, contract] = libraryDocs([job('a'), job('b'), job('c')], { a: card('invoice'), b: card('invoice'), c: card('contract') }, library);
    expect(docFactsText(paid)).toBe('due: 2026-10-29; paid: yes (2026-11-05)');
    expect(docFactsText(unpaid)).toBe('due: 2026-10-29; paid: no');
    expect(docFactsText(contract)).toBe('due: 2026-10-29');
  });

  it('u smlouvy přidá spočítaný konec a poslední den pro výpověď', () => {
    const c = { ...card('contract'), facts: { validTo: '2099-12-31', notice: '3 měsíce' } } as DocumentCard;
    const [doc] = libraryDocs([job('c')], { c }, library);
    expect(docFactsText(doc)).toBe('validTo: 2099-12-31; notice: 3 měsíce; last day to give notice: 2099-09-30; current end: 2099-12-31');
  });
});
