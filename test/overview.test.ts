import { describe, expect, it } from 'vitest';
import { latestProjects, recentJobs, toSort } from '../src/shared/overview';

const folders = [
  { id: 'invoices', createdAt: 0 },
  { id: 'other', createdAt: 0 },
];

describe('toSort', () => {
  it('počítá nezařazené, Ostatní a dotazy AI bez dvojího započtení', () => {
    const library = {
      folders,
      assign: { a: { folder: 'invoices' }, b: { folder: 'other' }, c: { folder: 'smazana' } },
      questions: [
        { jobId: 'c', options: [], at: 0 },
        { jobId: 'zamcena', options: [], at: 0 },
        { jobId: 'a', options: [], at: 0 },
      ],
    };
    const r = toSort(['a', 'b', 'c', 'd'], library);
    expect(r.unsorted).toEqual(['c', 'd']);
    expect(r.other).toEqual(['b']);
    expect(r.questions).toEqual(['c', 'a']);
    expect(r.total).toBe(4);
  });

  it('prázdná knihovna = 0', () => {
    expect(toSort([], { folders: [], assign: {} }).total).toBe(0);
  });
});

describe('recentJobs', () => {
  const jobs = [
    { id: 'a', createdAt: 1 },
    { id: 'b', createdAt: 3 },
    { id: 'c', createdAt: 2 },
  ];

  it('drží pořadí naposledy otevřených a vynechá chybějící', () => {
    expect(recentJobs(['c', 'x', 'a', 'c'], jobs).map((j) => j.id)).toEqual(['c', 'a']);
  });

  it('bez otevřených vezme nejnovější přidané', () => {
    expect(recentJobs(undefined, jobs).map((j) => j.id)).toEqual(['b', 'c', 'a']);
    expect(recentJobs(['x'], jobs, 2).map((j) => j.id)).toEqual(['b', 'c']);
  });

  it('omezí počet', () => {
    expect(recentJobs(['a', 'b', 'c'], jobs, 2)).toHaveLength(2);
  });
});

describe('latestProjects', () => {
  it('nejnověji upravené první, nejvýš limit', () => {
    const ps = [1, 4, 2, 3].map((updatedAt) => ({ updatedAt }));
    expect(latestProjects(ps).map((p) => p.updatedAt)).toEqual([4, 3, 2]);
  });
});
