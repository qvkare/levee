import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CompactPoint } from '../src/data.ts';
import { thinFrozen, thinObserved } from '../src/thin.ts';

const point = (i: number, hf: number, debt = 1000): CompactPoint => [100 + i, 1000 + i * 10, hf * debt, debt];
const hfs = (points: CompactPoint[]): number[] => points.map((p) => p[2] / p[3]);

describe('thinObserved', () => {
  const options = { triggers: [1.2], ceiling: 1.4 };

  it('keeps the first and last points', () => {
    const points = [point(0, 1.3), point(1, 1.3), point(2, 1.3), point(3, 1.3)];
    const kept = thinObserved(points, options);
    assert.deepEqual(kept, [points[0], points[3]]);
  });

  it('keeps the exact observation that crosses a trigger', () => {
    // Each step is under the 0.15% tolerance, so only the crossing forces a keep.
    const points = [point(0, 1.2012), point(1, 1.2008), point(2, 1.1999), point(3, 1.1995), point(4, 1.15)];
    const kept = thinObserved(points, options);
    assert.ok(kept.some((p) => p[0] === 102), 'crossing observation was dropped');
  });

  it('keeps a debt change even when HF is flat', () => {
    const points = [point(0, 1.3, 1000), point(1, 1.3, 1100), point(2, 1.3, 1100)];
    assert.equal(thinObserved(points, options).length, 3);
  });

  it('thins harder far above every trigger', () => {
    const points = Array.from({ length: 50 }, (_, i) => point(i, 2 - i * 0.002));
    assert.ok(thinObserved(points, options).length < 8);
  });

  it('never reports a detection earlier than the raw path', () => {
    const raw = Array.from({ length: 200 }, (_, i) => point(i, 1.3 - i * 0.001 + 0.002 * Math.sin(i)));
    const kept = thinObserved(raw, options);
    const firstBelow = (list: CompactPoint[]): number => list.find((p) => p[2] / p[3] < 1.2)![1];
    assert.equal(firstBelow(kept), firstBelow(raw));
  });
});

describe('thinFrozen', () => {
  it('preserves the exact low', () => {
    const series = [1.1, 1.09, 1.0895, 1.0893, 1.0891, 1.0899, 1.095, 1.11, 1.12];
    const raw = series.map((hf, i) => point(i, hf));
    assert.equal(Math.min(...hfs(thinFrozen(raw))), 1.0891);
  });

  it('preserves a low on the last step before the end', () => {
    const raw = [1.1, 1.1001, 1.0999, 0.9, 1.1].map((hf, i) => point(i, hf));
    assert.ok(Math.abs(Math.min(...hfs(thinFrozen(raw))) - 0.9) < 1e-12);
  });

  it('shrinks a flat series to its ends', () => {
    const raw = Array.from({ length: 100 }, (_, i) => point(i, 1.5 + (i % 2) * 0.0001));
    assert.ok(thinFrozen(raw).length <= 4);
  });

  it('stays in time order', () => {
    const raw = Array.from({ length: 500 }, (_, i) => point(i, 1.2 + 0.1 * Math.sin(i / 7)));
    const kept = thinFrozen(raw);
    for (let i = 1; i < kept.length; i++) assert.ok(kept[i]![0] > kept[i - 1]![0]);
  });
});
