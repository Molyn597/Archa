import { describe, expect, it } from 'vitest';
import type { RegionTranslation } from '../src/shared/types';
import { findRegion, moveCrop, resizeCrop, normalizeCrop, overlap, pendingSegments } from '../src/shared/regions';

const region = (page: number, crop: RegionTranslation['crop']): RegionTranslation => ({
  page,
  crop,
  text: 'x',
  createdAt: 0,
});

describe('overlap', () => {
  it('shodné výřezy = 1', () => expect(overlap([0.1, 0.1, 0.5, 0.5], [0.1, 0.1, 0.5, 0.5])).toBe(1));
  it('disjunktní výřezy = 0', () => expect(overlap([0, 0, 0.2, 0.2], [0.5, 0.5, 0.9, 0.9])).toBe(0));
  it('částečný překryv: průnik / sjednocení', () =>
    expect(overlap([0, 0, 0.5, 0.5], [0.25, 0, 0.75, 0.5])).toBeCloseTo(1 / 3));
});

describe('findRegion', () => {
  const regions = [region(1, [0.1, 0.1, 0.5, 0.5])];

  it('najde oblast na stejné stránce při malém posunu', () => {
    expect(findRegion(regions, 1, [0.101, 0.1, 0.501, 0.5])).toBe(regions[0]);
  });
  it('nenajde na jiné stránce ani při stejném výřezu', () => {
    expect(findRegion(regions, 2, [0.1, 0.1, 0.5, 0.5])).toBeUndefined();
  });
  it('nenajde při větším posunu', () => {
    expect(findRegion(regions, 1, [0.2, 0.1, 0.6, 0.5])).toBeUndefined();
  });
});

describe('normalizeCrop', () => {
  it('prohodí obrácené souřadnice', () => expect(normalizeCrop([0.5, 0.6, 0.1, 0.2])).toEqual([0.1, 0.2, 0.5, 0.6]));
  it('ořízne na 0–1', () => expect(normalizeCrop([-0.2, 0.3, 1.4, 1.1])).toEqual([0, 0.3, 1, 1]));
});

describe('pendingSegments', () => {
  it('vrátí jen segmenty bez skipped a bez translation', () => {
    const segments = [
      { id: 1 },
      { id: 2, translation: 'hotovo' },
      { id: 3, skipped: true },
      { id: 4, skipped: false, translation: undefined },
    ];
    expect(pendingSegments(segments).map((s) => s.id)).toEqual([1, 4]);
  });
});

describe('moveCrop', () => {
  it('posune o dx, dy', () => expect(moveCrop([0.1, 0.1, 0.3, 0.3], 0.2, 0.1)).toEqual([expect.closeTo(0.3), expect.closeTo(0.2), expect.closeTo(0.5), expect.closeTo(0.4)]));
  it('drží velikost a zůstane na stránce', () => {
    const [x0, y0, x1, y1] = moveCrop([0.5, 0.5, 0.75, 0.75], 1, -1);
    expect([x0, y0]).toEqual([0.75, 0]);
    expect(x1).toBeCloseTo(1);
    expect(y1).toBeCloseTo(0.25);
  });
});

describe('resizeCrop', () => {
  const min: [number, number] = [0.05, 0.05];
  it('tažení rohu se mění jen příslušné strany', () => expect(resizeCrop([0.2, 0.2, 0.6, 0.6], 'se', 0.1, 0.2, min)).toEqual([0.2, 0.2, 0.7, 0.8]));
  it('levý horní roh', () => expect(resizeCrop([0.2, 0.2, 0.6, 0.6], 'nw', -0.1, 0.1, min)).toEqual([expect.closeTo(0.1), expect.closeTo(0.3), 0.6, 0.6]));
  it('roh nepřejde přes protější stranu, drží minimum', () => {
    const c = resizeCrop([0.2, 0.2, 0.6, 0.6], 'nw', 0.9, 0.9, min);
    expect(c[0]).toBeCloseTo(0.55);
    expect(c[1]).toBeCloseTo(0.55);
  });
  it('roh zůstane na stránce', () => expect(resizeCrop([0.2, 0.2, 0.6, 0.6], 'se', 5, 5, min)).toEqual([0.2, 0.2, 1, 1]));
  it('střed hrany mění jen jednu stranu', () => {
    expect(resizeCrop([0.2, 0.2, 0.6, 0.6], 'e', 0.1, 0.5, min)).toEqual([0.2, 0.2, 0.7, 0.6]);
    expect(resizeCrop([0.2, 0.2, 0.6, 0.6], 'n', 0.5, -0.1, min)).toEqual([0.2, expect.closeTo(0.1), 0.6, 0.6]);
    expect(resizeCrop([0.2, 0.2, 0.6, 0.6], 'w', -0.1, 0.5, min)).toEqual([expect.closeTo(0.1), 0.2, 0.6, 0.6]);
    expect(resizeCrop([0.2, 0.2, 0.6, 0.6], 's', 0.5, 0.1, min)).toEqual([0.2, 0.2, 0.6, 0.7]);
  });
  it('hrana se nepřetáhne přes protější ani za stránku', () => {
    expect(resizeCrop([0.2, 0.2, 0.6, 0.6], 'w', 5, 0, min)[0]).toBeCloseTo(0.6 - min[0]);
    expect(resizeCrop([0.2, 0.2, 0.6, 0.6], 's', 0, 5, min)[3]).toBe(1);
    expect(resizeCrop([0.2, 0.2, 0.6, 0.6], 'n', 0, -5, min)[1]).toBe(0);
  });
});
