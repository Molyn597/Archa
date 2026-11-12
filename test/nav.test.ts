import { describe, expect, it } from 'vitest';
import { isLiterature, navFor } from '../src/shared/nav';

const ids = (kind: Parameters<typeof navFor>[0]) => navFor(kind).map((e) => e.id);

describe('navFor', () => {
  it('Přehled a Nahrát jsou v každé knihovně první, Dokumenty v menu nejsou', () => {
    for (const kind of ['work', 'study', 'personal', 'general'] as const) {
      expect(ids(kind).slice(0, 2)).toEqual(['overview', 'upload']);
      expect(ids(kind)).not.toContain('history');
    }
  });

  it('práce má faktury, termíny a zakázky', () => {
    expect(ids('work')).toEqual(['overview', 'upload', 'invoices', 'deadlines', 'projects']);
    expect(navFor('work').at(-1)?.label).toBe('nav.jobs');
  });

  it('nepřevzatý typ se chová jako práce', () => {
    expect(navFor('general')).toEqual(navFor('work'));
  });

  it('studium má moje práce a termíny, bez faktur', () => {
    expect(ids('study')).toEqual(['overview', 'upload', 'projects', 'deadlines']);
    expect(navFor('study').find((e) => e.id === 'projects')?.label).toBe('nav.myWork');
  });

  it('osobní má jen termíny', () => {
    expect(ids('personal')).toEqual(['overview', 'upload', 'deadlines']);
  });
});

describe('isLiterature', () => {
  it('pozná články, knihy, kapitoly a práce', () => {
    for (const type of ['article', 'book', 'chapter', 'thesis'] as const) expect(isLiterature(type)).toBe(true);
  });
  it('ostatní typy a chybějící karta ne', () => {
    expect(isLiterature('invoice')).toBe(false);
    expect(isLiterature(undefined)).toBe(false);
  });
});
