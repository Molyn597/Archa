import { describe, expect, it } from 'vitest';
import { isLiterature, navFor } from '../src/shared/nav';

const ids = (kind: Parameters<typeof navFor>[0]) => navFor(kind).map((e) => e.id);

describe('navFor', () => {
  it('Přehled a Dokumenty jsou v každé knihovně první', () => {
    for (const kind of ['work', 'study', 'personal', 'general'] as const) expect(ids(kind).slice(0, 2)).toEqual(['overview', 'history']);
  });

  it('práce má faktury, termíny a zakázky', () => {
    expect(ids('work')).toEqual(['overview', 'history', 'invoices', 'deadlines', 'projects']);
    expect(navFor('work').at(-1)?.label).toBe('nav.orders');
  });

  it('osobní a obecná mají faktury, termíny a projekty', () => {
    for (const kind of ['personal', 'general'] as const) {
      expect(ids(kind)).toEqual(['overview', 'history', 'invoices', 'deadlines', 'projects']);
      expect(navFor(kind).at(-1)?.label).toBe('nav.projects');
    }
  });

  it('studium má literaturu a práce, bez faktur a termínů', () => {
    expect(ids('study')).toEqual(['overview', 'history', 'literature', 'projects']);
    expect(navFor('study').at(-1)?.label).toBe('nav.works');
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
