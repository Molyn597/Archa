import { describe, expect, it } from 'vitest';
import { filterSources } from '../src/renderer/project-filter';
import type { DocumentCard, Job } from '../src/shared/types';

const job = (name: string) => ({ id: name, name }) as unknown as Job;
const card = (title: string, family: string, keywords: string[]) => ({ biblio: { title, authors: [{ family, given: 'Jan' }] }, keywords }) as unknown as DocumentCard;

describe('filterSources', () => {
  const items = [{ job: job('scan_01'), card: card('Dějiny státu', 'Novák', ['právo', 'historie']) }, { job: job('faktura'), card: null }];

  it('prázdný dotaz vrátí vše', () => expect(filterSources(items, ' ')).toHaveLength(2));
  it('hledá v názvu karty bez diakritiky', () => expect(filterSources(items, 'dejiny').map((i) => i.job.id)).toEqual(['scan_01']));
  it('hledá v autorovi a klíčových slovech, všechna slova musí sedět', () => {
    expect(filterSources(items, 'novak historie')).toHaveLength(1);
    expect(filterSources(items, 'novak faktura')).toHaveLength(0);
  });
  it('hledá v názvu souboru i bez karty', () => expect(filterSources(items, 'FAKT')).toHaveLength(1));
});
