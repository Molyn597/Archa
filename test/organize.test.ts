import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/pipeline', () => ({}));
vi.mock('../src/main/keystore', () => ({}));

const { answerQuestion, applyPlan, ensurePath, logPlacement, placeDoc, placementActive, undoPlacement } = await import('../src/main/library');
const { parsePlan, planSize, scopedPath } = await import('../src/main/organize');
const { parseCard } = await import('../src/main/card');
import type { Job, Library } from '../src/shared/types';

const lib = (): Library => ({
  folders: [{ id: 'study', createdAt: 0 }, { id: 'other', createdAt: 0 }],
  assign: {},
});
let n = 0;
const newId = () => `n${++n}`;

describe('ensurePath', () => {
  it('najde existující cestu podle názvu i klíče, bez create nic nezaloží', () => {
    const library = lib();
    expect(ensurePath(library, 'studium', false)).toEqual({ id: 'study', created: [] });
    expect(ensurePath(library, 'Studium / Články', false)).toEqual({ created: [] });
    expect(library.folders).toHaveLength(2);
  });

  it('s create založí chybějící úrovně pod existující složkou', () => {
    n = 0;
    const library = lib();
    expect(ensurePath(library, 'Studium / Články / Management', true, newId)).toEqual({ id: 'n2', created: ['n1', 'n2'] });
    expect(library.folders.find((f) => f.id === 'n2')).toMatchObject({ name: 'Management', parent: 'n1' });
    expect(ensurePath(library, 'studium > clanky', true, newId)).toEqual({ id: 'n1', created: [] });
  });
});

describe('placeDoc', () => {
  it('jistý návrh nové cesty: složky založí, zařadí a vrátí Placement', () => {
    n = 0;
    const library = lib();
    const placed = placeDoc(library, 'a', { folder: 'Studium / Články / Management' }, newId);
    expect(placed).toEqual({ jobId: 'a', path: 'Studium / Články / Management', folder: 'n2', created: ['n1', 'n2'], at: expect.any(Number) });
    expect(library.assign.a).toEqual({ folder: 'n2' });
  });

  it('existující složka: zařadí bez zakládání; stejné zařazení podruhé nic nevrátí', () => {
    const library = lib();
    expect(placeDoc(library, 'a', { folder: 'Studium' })).toMatchObject({ folder: 'study', path: 'Studium', created: [] });
    expect(library.assign.a).toEqual({ folder: 'study' });
    expect(placeDoc(library, 'a', { folder: 'Studium' })).toBeUndefined();
  });

  it('nejistý návrh: dotaz, dokument zůstane, nic se nezaloží', () => {
    const library = lib();
    library.assign.a = { folder: 'other' };
    expect(placeDoc(library, 'a', { folder: 'Studium / Ekonomie', folderSure: false, folderOptions: ['Studium / Management'] })).toBeUndefined();
    expect(library.assign.a).toEqual({ folder: 'other' });
    expect(library.questions).toEqual([{ jobId: 'a', options: ['Studium / Ekonomie', 'Studium / Management'], at: expect.any(Number) }]);
    expect(library.folders).toHaveLength(2);
  });

  it('ruční zařazení nechá být', () => {
    const library = lib();
    library.assign.a = { folder: 'other', manual: true };
    expect(placeDoc(library, 'a', { folder: 'Studium / Nové' })).toBeUndefined();
    expect(library.assign.a).toEqual({ folder: 'other', manual: true });
  });

  it('bez návrhu do Ostatní', () => {
    const library = lib();
    placeDoc(library, 'a', {});
    expect(library.assign.a).toEqual({ folder: 'other' });
  });
});

describe('undoPlacement', () => {
  it('vrátí dokument a smaže prázdné založené složky', () => {
    n = 0;
    const library = lib();
    library.assign.a = { folder: 'other' };
    const placed = placeDoc(library, 'a', { folder: 'Studium / Články / Management' }, newId)!;
    undoPlacement(library, placed);
    expect(library.assign.a).toEqual({ folder: 'other' });
    expect(library.folders.map((f) => f.id)).toEqual(['study', 'other']);
  });

  it('složku, kterou mezitím použil jiný dokument, nechá', () => {
    n = 0;
    const library = lib();
    const placed = placeDoc(library, 'a', { folder: 'Studium / Články / Management' }, newId)!;
    library.assign.b = { folder: 'n1' };
    undoPlacement(library, placed);
    expect(library.assign.a).toBeUndefined();
    expect(library.folders.map((f) => f.id)).toEqual(['study', 'other', 'n1']);
  });

  it('dokument přesunutý mezitím ručně nevrací', () => {
    n = 0;
    const library = lib();
    const placed = placeDoc(library, 'a', { folder: 'Studium / X' }, newId)!;
    library.assign.a = { folder: 'other', manual: true };
    undoPlacement(library, placed);
    expect(library.assign.a).toEqual({ folder: 'other', manual: true });
    expect(library.folders.map((f) => f.id)).toEqual(['study', 'other']);
  });
});

describe('answerQuestion / applyPlan', () => {
  it('odpověď založí cestu, zařadí ručně a dotaz smaže', () => {
    n = 0;
    const library = lib();
    library.questions = [{ jobId: 'a', options: ['Studium / Ekonomie'], at: 0 }];
    answerQuestion(library, 'a', 'Studium / Ekonomie', newId);
    expect(library.assign.a).toEqual({ folder: 'n1', manual: true });
    expect(library.questions).toBeUndefined();
  });

  it('odpověď „nechat“ jen smaže dotaz', () => {
    const library = lib();
    library.questions = [{ jobId: 'a', options: ['X'], at: 0 }];
    answerQuestion(library, 'a', null);
    expect(library.questions).toBeUndefined();
    expect(library.assign.a).toBeUndefined();
  });

  it('návrh založí složky, zařadí ručně a uloží dotazy', () => {
    n = 0;
    const library = lib();
    applyPlan(library, { folders: [{ path: 'Studium / Management', jobIds: ['a', 'b'] }, { path: 'Prázdná', jobIds: [] }], questions: [{ jobId: 'c', options: ['Studium'], at: 1 }] }, newId);
    expect(library.assign).toEqual({ a: { folder: 'n1', manual: true }, b: { folder: 'n1', manual: true } });
    expect(library.folders).toHaveLength(3);
    expect(library.questions).toEqual([{ jobId: 'c', options: ['Studium'], at: 1 }]);
  });
});

describe('parsePlan', () => {
  const docs = ['a', 'b', 'c', 'd'].map((id, i) => ({ job: { id, name: id, ext: '.pdf' } as Job, folder: i === 3 ? 'Studium / Management' : 'Studium' }));

  it('doplní rozsah, sloučí cesty, dokument jen jednou a bez přesunu tam, kde už je', () => {
    const plan = parsePlan(
      '{"folders": [{"path": "Management", "docs": [1, 4]}, {"path": "Studium / management", "docs": [2, 1]}, {"path": "Ekonomie", "docs": [9]}], "questions": [{"doc": 1, "options": ["X"]}, {"doc": 3, "options": ["Ekonomie", "ekonomie", "Studium / Politika"]}]}',
      docs,
      'Studium',
    );
    expect(plan.folders).toEqual([{ path: 'Studium / Management', jobIds: ['a', 'b'] }]);
    expect(plan.questions).toEqual([{ jobId: 'c', options: ['Studium / Ekonomie', 'Studium / Politika'], at: expect.any(Number) }]);
    expect(planSize(plan)).toBe(3);
  });

  it('nečitelná odpověď = prázdný návrh', () => {
    expect(parsePlan('nic', docs, '')).toEqual({ folders: [], questions: [] });
  });

  it('scopedPath', () => {
    expect(scopedPath('Management', 'Studium / Články')).toBe('Studium / Články / Management');
    expect(scopedPath('studium/články/X', 'Studium / Články')).toBe('studium / články / X');
    expect(scopedPath('X', '')).toBe('X');
  });
});

describe('karta: jistota složky', () => {
  const base = { summary: 'S.', type: 'article', keywords: [], biblio: { authors: [], title: '' } };
  it('folderSure false s možnostmi', () => {
    const card = parseCard(JSON.stringify({ ...base, folder: 'A', folderSure: false, folderOptions: ['B', ' ', 'C', 'D'] }), 'cs')!;
    expect(card).toMatchObject({ folder: 'A', folderSure: false, folderOptions: ['B', 'C'] });
  });
  it('jistá karta nemá folderSure', () => {
    expect(parseCard(JSON.stringify({ ...base, folder: 'A', folderSure: true }), 'cs')!.folderSure).toBeUndefined();
  });
});

describe('přehled „Zařadila AI“', () => {
  it('nejnovější první, starší záznam dokumentu nahradí, Vrátit ho označí', () => {
    n = 0;
    const library = lib();
    const first = placeDoc(library, 'a', { folder: 'Studium' }, newId)!;
    logPlacement(library, first);
    const second = placeDoc(library, 'b', { folder: 'Studium / Nová' }, newId)!;
    logPlacement(library, second);
    const again = placeDoc(library, 'a', { folder: 'Ostatní' }, newId)!;
    logPlacement(library, again);
    expect(library.aiLog!.map((e) => e.jobId)).toEqual(['a', 'b']);
    expect(placementActive(library, second)).toBe(true);
    undoPlacement(library, second);
    expect(library.aiLog![1].undone).toBe(true);
    expect(placementActive(library, second)).toBe(false);
  });

  it('ruční přesun zařazení zneplatní', () => {
    const library = lib();
    const p = placeDoc(library, 'a', { folder: 'Studium' })!;
    library.assign.a = { folder: 'study', manual: true };
    expect(placementActive(library, p)).toBe(false);
  });
});
