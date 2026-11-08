import { describe, expect, it } from 'vitest';
import { docSubtitle, docTitle } from '../src/shared/doc-title';
import type { DocFacts, DocumentCard, Job } from '../src/shared/types';

const job = { name: 'scan_2026__03', ext: '.pdf' } as Job;
const card = (type: DocumentCard['type'], extra: Partial<DocumentCard> = {}, facts: DocFacts = {}) =>
  ({ type, summary: '', keywords: [], biblio: { authors: [], title: '' }, facts, ...extra }) as DocumentCard;

describe('docTitle', () => {
  it('faktura s číslem', () => {
    expect(docTitle(job, card('invoice', {}, { number: '2026001' }))).toBe('Faktura 2026001');
  });

  it('faktura bez čísla se chová jako ostatní', () => {
    expect(docTitle(job, card('invoice'))).toBe('scan 2026 03');
  });

  it('smlouva: předmět', () => {
    expect(docTitle(job, card('contract', {}, { subject: 'Nájem kanceláře' }))).toBe('Nájem kanceláře');
  });

  it('ostatní: název z bibliografie, jinak soubor', () => {
    expect(docTitle(job, card('article', { biblio: { authors: [], title: 'Řízení změn' } }))).toBe('Řízení změn');
    expect(docTitle(job, card('article'))).toBe('scan 2026 03');
    expect(docTitle(job)).toBe('scan 2026 03');
  });
});

describe('docSubtitle', () => {
  it('faktura: dodavatel · předmět', () => {
    expect(docSubtitle(job, card('invoice', {}, { supplier: 'ACME', subject: 'hosting' }))).toBe('ACME · hosting');
    expect(docSubtitle(job, card('invoice', {}, { supplier: 'ACME' }))).toBe('ACME');
  });

  it('smlouva: první strana · platnost do', () => {
    const s = docSubtitle(job, card('contract', {}, { parties: ['Foo s.r.o.', 'Bar a.s.'], validTo: '2027-03-31' }));
    expect(s).toBe('Foo s.r.o. · platnost do 31. 3. 2027');
    expect(docSubtitle(job, card('contract', {}, { parties: ['Foo s.r.o.'] }))).toBe('Foo s.r.o.');
  });

  it('ostatní: první věta shrnutí, dlouhá se zkrátí', () => {
    expect(docSubtitle(job, card('article', { summary: 'Krátká věta. Druhá věta.' }))).toBe('Krátká věta.');
    const long = docSubtitle(job, card('article', { summary: `${'slovo '.repeat(30)}konec.` }));
    expect(long.length).toBeLessThanOrEqual(81);
    expect(long.endsWith('…')).toBe(true);
  });

  it('bez karty prázdný', () => {
    expect(docSubtitle(job)).toBe('');
  });
});
