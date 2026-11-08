import { describe, expect, it } from 'vitest';
import { cs } from '../src/shared/i18n/cs';
import { en } from '../src/shared/i18n/en';
import { alignToTemplate, docCountByFolder, parseSubjects, TEMPLATE_VERSION, templateLibrary } from '../src/shared/library-templates';
import type { Library, LibraryFolder, LibraryKind } from '../src/shared/types';

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

  it('práce: bez podsložek, v pořadí šablony', () => {
    const { folders } = templateLibrary('work');
    expect(folders.map((f) => f.id)).toEqual(['contracts', 'invoices', 'hr', 'manuals', 'official', 'internal-docs', 'other']);
    expect(folders.some((f) => f.parent)).toBe(false);
    expect(folders.map((f) => f.createdAt)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('nová knihovna má aktuální templateVersion, převzatá ne', () => {
    expect(templateLibrary('work').templateVersion).toBe(TEMPLATE_VERSION);
    expect(templateLibrary('general').templateVersion).toBeUndefined();
  });
});

const lib = (folders: LibraryFolder[], assign: Library['assign'] = {}): Library => ({ folders, assign });
const f = (id: string, extra: Partial<LibraryFolder> = {}): LibraryFolder => ({ id, createdAt: 0, ...extra });
const ids = (l: Library) => l.folders.map((x) => x.id);

describe('alignToTemplate', () => {
  it('práce: smaže prázdné staré podsložky a prohlášení, doplní hr, srovná pořadí', () => {
    const old = lib([f('invoices'), f('invoices-rent', { parent: 'invoices' }), f('contracts'), f('contracts-partners', { parent: 'contracts' }), f('declarations'), f('internal-docs'), f('other')]);
    const r = alignToTemplate(old, 'work');
    expect(ids(r.library)).toEqual(['contracts', 'invoices', 'hr', 'manuals', 'official', 'internal-docs', 'other']);
    expect(r.removed.sort()).toEqual(['contracts-partners', 'declarations', 'invoices-rent']);
    expect(r.added).toEqual(['hr', 'manuals', 'official']);
    expect(r.library.templateVersion).toBe(TEMPLATE_VERSION);
    expect(old.folders).toHaveLength(7);
  });

  it('složka s dokumentem zůstane, včetně rodiče; podsložka bez dokumentů pryč', () => {
    const old = lib([f('invoices'), f('invoices-rent', { parent: 'invoices' }), f('invoices-internal', { parent: 'invoices' })], { d1: { folder: 'invoices-rent' } });
    const r = alignToTemplate(old, 'work');
    expect(ids(r.library)).toContain('invoices-rent');
    expect(ids(r.library)).not.toContain('invoices-internal');
  });

  it('vlastní složka a podstrom s vlastní podsložkou nebo zámkem zůstanou', () => {
    const old = lib([f('declarations'), f('custom-1', { name: 'Moje', parent: 'declarations' }), f('invoices-rent', { locked: true }), f('contracts-rent')]);
    const r = alignToTemplate(old, 'work');
    expect(ids(r.library)).toEqual(expect.arrayContaining(['declarations', 'custom-1', 'invoices-rent']));
    expect(ids(r.library)).not.toContain('contracts-rent');
  });

  it('vlastní složky jsou před Ostatní', () => {
    const r = alignToTemplate(lib([f('other'), f('abc', { name: 'Vlastní' })]), 'work');
    expect(ids(r.library).slice(-2)).toEqual(['abc', 'other']);
  });

  it('studium: předměty zůstanou, články a rozvrh se doplní, nepoužité výchozí pryč', () => {
    const old = lib([f('s1', { name: 'Právo' }), f('contracts'), f('invoices'), f('study'), f('other')], { d: { folder: 'study' } });
    const r = alignToTemplate(old, 'study');
    expect(ids(r.library)).toEqual(['s1', 'study', 'other', 'articles', 'schedule']);
  });

  it('general se nemění', () => {
    const old = lib([f('contracts')]);
    expect(alignToTemplate(old, 'general').library).toBe(old);
  });

  it('počty dokumentů lze předat zvlášť, výchozí z assign', () => {
    const old = lib([f('study'), f('other')], { d: { folder: 'study' } });
    expect(docCountByFolder(old)).toEqual({ study: 1 });
    expect(ids(alignToTemplate(old, 'work', {}).library)).not.toContain('study');
    expect(ids(alignToTemplate(old, 'work').library)).toContain('study');
  });

  it('je idempotentní', () => {
    const once = alignToTemplate(lib([f('declarations'), f('other')]), 'work').library;
    expect(alignToTemplate(once, 'work').library).toEqual(once);
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

describe('alignToTemplate – stejný název', () => {
  it('nepřidá složku šablony, kterou uživatel má pod stejným názvem jinde', () => {
    const library = { folders: [{ id: 'x1', name: 'Články', createdAt: 0, parent: 'y' }, { id: 'y', name: 'Škola', createdAt: 0 }], assign: {} };
    const r = alignToTemplate(library, 'study');
    expect(r.added).not.toContain('articles');
    expect(r.library.folders.some((f) => f.id === 'articles')).toBe(false);
  });
});
