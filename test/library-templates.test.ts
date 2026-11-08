import { describe, expect, it } from 'vitest';
import { cs } from '../src/shared/i18n/cs';
import { en } from '../src/shared/i18n/en';
import { parseSubjects, templateLibrary } from '../src/shared/library-templates';
import type { LibraryKind } from '../src/shared/types';

const KINDS: LibraryKind[] = ['work', 'study', 'personal', 'general'];

describe('templateLibrary', () => {
  it.each(KINDS)('%s: unikátní id, existující rodiče, složka other, přeložené názvy', (kind) => {
    const { folders, assign } = templateLibrary(kind, ['Ekonomie', 'Právo']);
    const ids = folders.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('other');
    expect(assign).toEqual({});
    for (const f of folders) {
      if (f.parent) expect(ids).toContain(f.parent);
      if (!f.name) {
        expect(cs).toHaveProperty(`folder.${f.id}`);
        expect(en).toHaveProperty(`folder.${f.id}`);
      }
    }
  });

  it('studium: předměty jsou složky nejvyšší úrovně s vlastním názvem', () => {
    const { folders } = templateLibrary('study', ['  Ekonomie ', '', 'ekonomie', 'Právo']);
    expect(folders.filter((f) => f.name).map((f) => f.name)).toEqual(['Ekonomie', 'Právo']);
    expect(folders.every((f) => !f.parent)).toBe(true);
    expect(folders.some((f) => f.id === 'subjects')).toBe(false);
  });

  it('studium bez předmětů má složku subjects', () => {
    expect(templateLibrary('study', [' ']).folders.map((f) => f.id)).toContain('subjects');
    expect(templateLibrary('study').folders.map((f) => f.id)).toEqual(['subjects', 'articles', 'schedule', 'other']);
  });

  it('práce má podsložky faktur a smluv', () => {
    const { folders } = templateLibrary('work');
    expect(folders.filter((f) => f.parent === 'invoices')).toHaveLength(4);
    expect(folders.filter((f) => f.parent === 'contracts')).toHaveLength(4);
  });
});

describe('parseSubjects', () => {
  it('dělí čárkou, středníkem i novým řádkem', () => {
    expect(parseSubjects('A, B;C\nD')).toEqual(['A', 'B', 'C', 'D']);
  });
  it('ořízne, vyhodí prázdné a duplicity bez ohledu na velikost písmen', () => {
    expect(parseSubjects(' Právo ,, právo ; ')).toEqual(['Právo']);
    expect(parseSubjects('')).toEqual([]);
  });
});
