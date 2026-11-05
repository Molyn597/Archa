import type { RegionTranslation } from './types';

type Crop = RegionTranslation['crop'];

// Od této shody (průnik / sjednocení) se označení bere jako stejná oblast.
const SAME_REGION = 0.9;

export function overlap(a: Crop, b: Crop) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const area = (c: Crop) => (c[2] - c[0]) * (c[3] - c[1]);
  const inter = w * h;
  return inter / (area(a) + area(b) - inter);
}

export function findRegion(regions: RegionTranslation[], page: number, crop: Crop) {
  return regions.find((r) => r.page === page && overlap(r.crop, crop) >= SAME_REGION);
}

/** Výřez seřazený (x0 < x1, y0 < y1) a oříznutý na stránku. */
export function normalizeCrop([x0, y0, x1, y1]: Crop): Crop {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [clamp(Math.min(x0, x1)), clamp(Math.min(y0, y1)), clamp(Math.max(x0, x1)), clamp(Math.max(y0, y1))];
}

/** Úchyt výběru: rohy mění dvě strany, středy hran jednu. */
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

const between = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Posun výřezu o (dx, dy) v poměru ke stránce; velikost zůstává, výřez se drží na stránce. */
export function moveCrop([x0, y0, x1, y1]: Crop, dx: number, dy: number): Crop {
  const mx = between(dx, -x0, 1 - x1);
  const my = between(dy, -y0, 1 - y1);
  return [x0 + mx, y0 + my, x1 + mx, y1 + my];
}

/** Tažení úchytu o (dx, dy); posouvané strany zůstanou na stránce a výřez nejmenší možné [šířka, výška] `min`. */
export function resizeCrop([x0, y0, x1, y1]: Crop, handle: Handle, dx: number, dy: number, min: [number, number]): Crop {
  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.includes('n');
  const south = handle.includes('s');
  return [
    west ? between(x0 + dx, 0, x1 - min[0]) : x0,
    north ? between(y0 + dy, 0, y1 - min[1]) : y0,
    east ? between(x1 + dx, x0 + min[0], 1) : x1,
    south ? between(y1 + dy, y0 + min[1], 1) : y1,
  ];
}

/** Segmenty, které další běh přeloží: vybrané a dosud nepřeložené. */
export const pendingSegments = <T extends { skipped?: boolean; translation?: string }>(segments: T[]) =>
  segments.filter((s) => !s.skipped && s.translation === undefined);
