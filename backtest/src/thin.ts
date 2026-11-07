// Thinning keeps the committed file small without losing anything the simulation acts on.
// Dropped points only ever make a detection later or a low the same, never earlier or higher.
import type { CompactPoint } from './data.ts';

const hfOf = (point: CompactPoint): number => (point[3] <= 0 ? Infinity : point[2] / point[3]);

const moved = (a: number, b: number, tolerance: number): boolean => {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a !== b;
  return Math.abs(a / b - 1) >= tolerance;
};

export interface ObservedOptions {
  triggers: readonly number[];
  /** Above this HF, far from any trigger, a coarser tolerance applies. */
  ceiling: number;
}

/**
 * Keeps the first and last point, any point that crosses a trigger, any debt change of 0.2%
 * or more, and otherwise a point each time HF moves 0.15% (3% above the ceiling).
 */
export function thinObserved(points: CompactPoint[], options: ObservedOptions): CompactPoint[] {
  if (points.length <= 2) return points;
  const kept: CompactPoint[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const point = points[i]!;
    const previous = points[i - 1]!;
    const last = kept[kept.length - 1]!;
    const hf = hfOf(point);
    const crossed = options.triggers.some((t) => hfOf(previous) >= t !== hf >= t);
    const tolerance = hf >= options.ceiling ? 0.03 : 0.0015;
    if (crossed || moved(hf, hfOf(last), tolerance) || moved(point[3], last[3], 0.002)) kept.push(point);
  }
  kept.push(points[points.length - 1]!);
  return kept;
}

/**
 * Frozen points only feed the survival check, so lows must survive exactly. Keeps a point
 * each time HF moves 0.25% from the last kept point, plus the lowest point since then.
 */
export function thinFrozen(points: CompactPoint[]): CompactPoint[] {
  if (points.length <= 2) return points;
  const kept: CompactPoint[] = [points[0]!];
  let low: CompactPoint | null = null;
  for (let i = 1; i < points.length - 1; i++) {
    const point = points[i]!;
    if (!low || hfOf(point) < hfOf(low)) low = point;
    if (moved(hfOf(point), hfOf(kept[kept.length - 1]!), 0.0025)) {
      if (low !== point && low[1] > kept[kept.length - 1]![1]) kept.push(low);
      kept.push(point);
      low = null;
    }
  }
  if (low) kept.push(low);
  kept.push(points[points.length - 1]!);
  return kept.filter((point, i) => i === 0 || point[0] !== kept[i - 1]![0]);
}
